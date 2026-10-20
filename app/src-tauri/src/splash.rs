//! Desktop splash window (Discord style). The main window is created hidden and runs the boot work (patch list,
//! signing key, settings); a small frameless splash window shows its progress until `main_ready` reveals the main
//! window. Mobile has no second window: the app draws the same card itself (and Android shows the system splash).

use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Runtime, State, Window};
#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub const SPLASH: &str = "splash";
pub const MAIN: &str = "main";
/// Smallest main window (logical pixels): the size it opens at, as minWidth/minHeight in tauri.conf.json.
pub const MIN_SIZE: (f64, f64) = (900.0, 700.0);
/// Card size of the design, in logical pixels.
pub const SIZE: (f64, f64) = (600.0, 380.0);

/// What the splash window shows; the hidden main window (which runs the boot work) pushes it.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
pub struct SplashState {
    /// `loading`, `slow` or `error`.
    pub boot: String,
    pub error: String,
    pub version: String,
    /// UI language of the main window; empty until it has said (the splash then detects its own).
    pub lang: String,
}

/// The splash stays up at least this long, so it is seen rather than flashed.
pub const SPLASH_MIN: Duration = Duration::from_millis(700);

/// Minimum splash time: `BHP_SPLASH_HOLD_MS` in milliseconds (0 = none), else [`SPLASH_MIN`].
pub fn splash_hold(var: Option<OsString>) -> Duration {
    var.and_then(|v| v.to_str().and_then(|s| s.trim().parse::<u64>().ok()))
        .map(Duration::from_millis)
        .unwrap_or(SPLASH_MIN)
}

/// The splash page has drawn (its first `splash_get`): the minimum splash time counts from then, not from the
/// app start, so the splash is seen for all of it.
fn splash_shown(started: &Mutex<Instant>, shown: &AtomicBool) {
    if !shown.swap(true, Ordering::SeqCst) {
        *started.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }
}

/// Shared state of the splash hand-over.
pub struct Splash {
    state: Mutex<Option<SplashState>>,
    /// When the splash page first drew (app start until then), see [`splash_shown`].
    started: Mutex<Instant>,
    shown: AtomicBool,
    hold: Duration,
    /// The main window is on screen: closing the splash is no longer a request to quit.
    revealed: AtomicBool,
}

impl Splash {
    pub fn new(hold: Duration) -> Self {
        Splash {
            state: Mutex::default(),
            started: Mutex::new(Instant::now()),
            shown: AtomicBool::new(false),
            hold,
            revealed: AtomicBool::new(false),
        }
    }

    pub fn from_env() -> Self {
        Self::new(splash_hold(std::env::var_os("BHP_SPLASH_HOLD_MS")))
    }

    pub fn revealed(&self) -> &AtomicBool {
        &self.revealed
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Option<SplashState>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The main window keeps this up to date while it boots; the splash window renders it.
#[tauri::command]
pub fn splash_set<R: Runtime>(app: AppHandle<R>, splash: State<'_, Splash>, state: SplashState) {
    *splash.state() = Some(state.clone());
    let _ = app.emit_to(SPLASH, "splash-state", state);
}

/// The state so far; before the main window has said anything, a plain "loading" with the app's version.
#[tauri::command]
pub fn splash_get<R: Runtime>(app: AppHandle<R>, splash: State<'_, Splash>) -> SplashState {
    splash_shown(&splash.started, &splash.shown);
    splash.state().clone().unwrap_or_else(|| SplashState {
        boot: "loading".into(),
        version: app.package_info().version.to_string(),
        ..SplashState::default()
    })
}

/// The splash's Try again button: the main window owns the boot work, so it is told to run it again.
#[tauri::command]
pub fn splash_retry<R: Runtime>(app: AppHandle<R>) {
    let _ = app.emit_to(MAIN, "splash-retry", ());
}

/// The boot work is done: after the minimum splash time show the main window and close the splash.
pub async fn reveal<R: Runtime>(app: AppHandle<R>, splash: &Splash) -> tauri::Result<()> {
    let wait = splash.hold.saturating_sub(
        splash
            .started
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .elapsed(),
    );
    if !wait.is_zero() {
        // The sleeping task cannot fail, so there is no join error to report.
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(wait)).await;
    }
    splash.revealed.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(MAIN) {
        w.show()?;
        // Frameless windows on Wayland drop the config's size hints when GTK realizes them; set them again.
        let _ = w.set_min_size(Some(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1)));
        let _ = w.set_focus();
    }
    if let Some(w) = app.get_webview_window(SPLASH) {
        let _ = w.close();
    }
    Ok(())
}

/// The size to grow a window of `w` x `h` logical pixels back to, if it is below [`MIN_SIZE`].
pub fn grown_to_min(w: f64, h: f64) -> Option<(f64, f64)> {
    (w < MIN_SIZE.0 || h < MIN_SIZE.1).then(|| (w.max(MIN_SIZE.0), h.max(MIN_SIZE.1)))
}

/// What [`enforce_min_size`] resizes to: nothing while maximized/fullscreen, before the window has a size, or when
/// it is already large enough.
pub fn min_size_fix(physical: (u32, u32), scale: f64, maximized: bool) -> Option<(f64, f64)> {
    if maximized || physical.0 == 0 {
        return None;
    }
    grown_to_min(physical.0 as f64 / scale, physical.1 as f64 / scale)
}

/// Grows `window` back to [`MIN_SIZE`] when its `physical` size is below it (see [`min_size_fix`]).
fn grow_if_small<R: Runtime>(window: &Window<R>, physical: (u32, u32), scale: f64) {
    let maximized =
        window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false);
    if let Some((w, h)) = min_size_fix(physical, scale, maximized) {
        let _ = window.set_size(LogicalSize::new(w, h));
    }
}

/// Some compositors ignore the min-size hint of a frameless window: grow the main window back after a resize.
pub fn enforce_min_size<R: Runtime>(window: &Window<R>) {
    if window.label() == MAIN {
        let size = window.inner_size().unwrap_or_default();
        grow_if_small(
            window,
            (size.width, size.height),
            window.scale_factor().unwrap_or(1.0),
        );
    }
}

/// Appends the boot error to `boot.log` in `dir` and returns the file.
pub fn write_log(dir: &Path, error: &str, now: Duration) -> std::io::Result<PathBuf> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let file = dir.join("boot.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)?;
    writeln!(f, "[{}] boot failed: {}", now.as_secs(), error)?;
    Ok(file)
}

/// The program and arguments that show `path` in the platform's file manager or default app.
pub fn opener(os: &str, path: &Path) -> (&'static str, Vec<OsString>) {
    match os {
        "windows" => {
            let mut arg = OsString::from("/select,");
            arg.push(path);
            ("explorer", vec![arg])
        }
        "macos" => ("open", vec![OsString::from("-R"), path.into()]),
        _ => ("xdg-open", vec![path.into()]),
    }
}

/// Starts `program` detached (a file manager reports odd exit codes, so only the launch is checked).
pub fn launch(program: &str, args: &[impl AsRef<OsStr>]) -> std::io::Result<()> {
    Command::new(program).args(args).spawn().map(|_| ())
}

/// Writes the boot error to the log folder and hands the file to `open` (injected so tests never start a real opener).
pub fn open_log_with<R: Runtime>(
    app: &AppHandle<R>,
    error: &str,
    open: impl FnOnce(&str, &[OsString]) -> std::io::Result<()>,
) -> tauri::Result<PathBuf> {
    let dir = app.path().app_log_dir()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // The file exists (and has the error in it) before anything is asked to open it.
    let file = write_log(&dir, error, now)?;
    let (program, args) = opener(std::env::consts::OS, &file);
    open(program, &args)?;
    Ok(file)
}

/// The stored boot error (empty before the main window has reported one).
pub fn boot_error(splash: &Splash) -> String {
    splash
        .state()
        .as_ref()
        .map(|s| s.error.clone())
        .unwrap_or_default()
}

/// Opens the small frameless splash window. Transparent so the card's rounded corners show; macOS cannot do that
/// without the private API, so it gets a plain undecorated window there. Created hidden and shown once laid out
/// (GTK warns when a frameless window gets its title bar after it was shown).
#[cfg(desktop)]
pub fn open_splash<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<()> {
    let mac = cfg!(target_os = "macos");
    let w = WebviewWindowBuilder::new(manager, SPLASH, WebviewUrl::App(SPLASH.into()))
        .title("Blockheads Patcher")
        .inner_size(SIZE.0, SIZE.1)
        .center()
        .decorations(false)
        .transparent(!mac)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    w.show()
}

/// App setup. The main window comes hidden from tauri.conf.json and `main_ready` shows it. Should the splash fail to
/// open, the main window is shown right away (it draws the same card itself while it boots).
#[cfg_attr(mobile, allow(unused_variables))]
pub fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    if let Err(e) = open_splash(app) {
        eprintln!("splash window failed: {e}");
        if let Some(w) = app.get_webview_window(MAIN) {
            let _ = w.show();
        }
    }
    Ok(())
}

/// Closing the splash (Alt+F4) before the main window is up means the user wants out.
pub fn quits_on_close(label: &str, revealed: &AtomicBool) -> bool {
    label == SPLASH && !revealed.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_splash_time_counts_from_the_first_draw() {
        let (started, shown) = (Mutex::new(Instant::now()), AtomicBool::new(false));
        std::thread::sleep(Duration::from_millis(30));
        splash_shown(&started, &shown);
        let first = *started.lock().unwrap();
        assert!(first.elapsed() < Duration::from_millis(30));
        std::thread::sleep(Duration::from_millis(5));
        splash_shown(&started, &shown);
        assert_eq!(
            *started.lock().unwrap(),
            first,
            "later calls keep the first draw"
        );
    }
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::WebviewWindow;

    fn app(hold: Duration) -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(Splash::new(hold))
            .invoke_handler(tauri::generate_handler![
                splash_set,
                splash_get,
                splash_retry,
            ])
            .build(mock_context(noop_assets()))
            .unwrap()
    }

    fn app_without_windows() -> tauri::App<MockRuntime> {
        app(Duration::ZERO)
    }

    fn state(boot: &str) -> SplashState {
        SplashState {
            boot: boot.into(),
            error: "disk on fire".into(),
            version: "9.9.9".into(),
            lang: "tr".into(),
        }
    }

    fn window(app: &tauri::App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
            .visible(false)
            .build()
            .unwrap()
    }

    #[test]
    fn splash_hold_parses_milliseconds() {
        assert_eq!(splash_hold(None), SPLASH_MIN);
        assert_eq!(splash_hold(Some("".into())), SPLASH_MIN);
        assert_eq!(splash_hold(Some("soon".into())), SPLASH_MIN);
        assert_eq!(splash_hold(Some("0".into())), Duration::ZERO);
        assert_eq!(
            splash_hold(Some(" 2500 ".into())),
            Duration::from_millis(2500)
        );
    }

    #[test]
    fn from_env_has_no_hold_without_the_variable() {
        // The variable is only set by hand for manual tests; the unit tests never set it.
        assert_eq!(
            Splash::from_env().hold,
            splash_hold(std::env::var_os("BHP_SPLASH_HOLD_MS"))
        );
    }

    #[test]
    fn state_defaults_to_loading_with_the_app_version_until_the_main_window_reports() {
        let app = app(Duration::ZERO);
        let h = app.handle().clone();
        let got = splash_get(h.clone(), h.state::<Splash>());
        assert_eq!(got.boot, "loading");
        assert_eq!(got.version, h.package_info().version.to_string());
        splash_set(h.clone(), h.state::<Splash>(), state("error"));
        assert_eq!(splash_get(h.clone(), h.state::<Splash>()), state("error"));
    }

    #[test]
    fn retry_does_not_need_windows() {
        let app = app(Duration::ZERO);
        splash_retry(app.handle().clone());
    }

    #[test]
    fn reveal_shows_main_closes_splash_and_honours_the_hold() {
        let t0 = Instant::now();
        let app = app(Duration::from_millis(30));
        let main = window(&app, MAIN);
        window(&app, SPLASH);
        let h = app.handle().clone();
        tauri::async_runtime::block_on(reveal(h.clone(), &h.state::<Splash>())).unwrap();
        assert!(t0.elapsed() >= Duration::from_millis(30));
        assert!(main.is_visible().unwrap());
        assert!(h.state::<Splash>().revealed.load(Ordering::SeqCst));
    }

    #[test]
    fn grown_to_min_only_when_below() {
        assert_eq!(grown_to_min(900.0, 700.0), None);
        assert_eq!(grown_to_min(1200.0, 800.0), None);
        assert_eq!(grown_to_min(500.0, 800.0), Some((900.0, 800.0)));
        assert_eq!(grown_to_min(1000.0, 300.0), Some((1000.0, 700.0)));
    }

    #[test]
    fn min_size_fix_skips_maximized_unsized_and_large_windows() {
        assert_eq!(min_size_fix((500, 400), 1.0, true), None);
        assert_eq!(min_size_fix((0, 0), 1.0, false), None);
        assert_eq!(min_size_fix((1800, 1400), 2.0, false), None);
        assert_eq!(min_size_fix((1000, 800), 2.0, false), Some((900.0, 700.0)));
    }

    #[test]
    fn enforce_min_size_ignores_other_windows_and_handles_the_main_one() {
        let app = app(Duration::ZERO);
        let main = window(&app, MAIN);
        let splash = window(&app, SPLASH);
        enforce_min_size(&splash.as_ref().window());
        enforce_min_size(&main.as_ref().window());
        grow_if_small(&main.as_ref().window(), (400, 300), 1.0);
    }

    #[test]
    fn reveal_without_windows_is_fine() {
        let app = app(Duration::ZERO);
        let h = app.handle().clone();
        tauri::async_runtime::block_on(reveal(h.clone(), &h.state::<Splash>())).unwrap();
    }

    #[test]
    fn write_log_appends_timestamped_lines() {
        let dir = std::env::temp_dir().join(format!("bhp-splash-log-{}", std::process::id()));
        let file = write_log(&dir.join("sub"), "first", Duration::from_secs(5)).unwrap();
        write_log(&dir.join("sub"), "second", Duration::from_secs(6)).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text, "[5] boot failed: first\n[6] boot failed: second\n");
        // A path that is a file cannot become a directory.
        assert!(write_log(&file, "x", Duration::ZERO).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn opener_picks_the_platform_file_manager() {
        let p = Path::new("/l/boot.log");
        assert_eq!(
            opener("linux", p),
            ("xdg-open", vec![OsString::from("/l/boot.log")])
        );
        assert_eq!(
            opener("macos", p),
            (
                "open",
                vec![OsString::from("-R"), OsString::from("/l/boot.log")]
            )
        );
        assert_eq!(
            opener("windows", p),
            ("explorer", vec![OsString::from("/select,/l/boot.log")])
        );
    }

    #[cfg(unix)]
    #[test]
    fn launch_reports_a_missing_program() {
        assert!(launch("true", &["x"]).is_ok());
        assert!(launch("bhp-no-such-program", &["x"]).is_err());
    }

    #[test]
    fn open_log_writes_the_file_before_opening_it_and_never_opens_for_real() {
        let app = app(Duration::ZERO);
        let h = app.handle().clone();
        let seen = std::cell::RefCell::new(None);
        let file = open_log_with(&h, "disk on fire", |program, args| {
            *seen.borrow_mut() = Some((program.to_string(), args.to_vec()));
            Ok(())
        })
        .unwrap();
        // The opener got an existing file with the error in it.
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .contains("boot failed: disk on fire"));
        let (program, args) = seen.into_inner().unwrap();
        assert!(!program.is_empty());
        assert!(args
            .iter()
            .any(|a| a.to_string_lossy().ends_with("boot.log")));
        // An opener that cannot start is reported.
        assert!(open_log_with(&h, "x", |_, _| Err(std::io::Error::other("no opener"))).is_err());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn open_splash_builds_a_hidden_then_shown_window_and_setup_runs() {
        let mut app = app(Duration::ZERO);
        window(&app, MAIN);
        setup(&mut app).unwrap();
        let w = app.get_webview_window(SPLASH).expect("splash window");
        assert_eq!(w.label(), SPLASH);
        // A second splash with the same label fails; setup then falls back to showing the main window.
        assert!(open_splash(&app).is_err());
        setup(&mut app).unwrap();
        assert!(app.get_webview_window(MAIN).unwrap().is_visible().unwrap());
        // No main window either: nothing to show, nothing to fail.
        let mut bare = app_without_windows();
        window(&bare, SPLASH);
        setup(&mut bare).unwrap();
    }

    #[test]
    fn closing_the_splash_early_quits_but_not_after_the_reveal() {
        let revealed = AtomicBool::new(false);
        assert!(quits_on_close(SPLASH, &revealed));
        assert!(!quits_on_close(MAIN, &revealed));
        revealed.store(true, Ordering::SeqCst);
        assert!(!quits_on_close(SPLASH, &revealed));
    }

    #[test]
    fn boot_error_reads_the_stored_state() {
        let splash = Splash::new(Duration::ZERO);
        assert_eq!(boot_error(&splash), "");
        *splash.state() = Some(state("error"));
        assert_eq!(boot_error(&splash), "disk on fire");
    }

    #[test]
    fn revealed_flag_is_shared_and_a_poisoned_lock_is_still_usable() {
        let splash = std::sync::Arc::new(Splash::new(Duration::ZERO));
        assert!(!splash.revealed().load(Ordering::SeqCst));
        let s2 = splash.clone();
        let _ = std::thread::spawn(move || {
            let _guard = s2.state.lock().unwrap();
            panic!("poison");
        })
        .join();
        *splash.state() = Some(state("slow"));
        assert_eq!(splash.state().as_ref().unwrap().boot, "slow");
    }
}
