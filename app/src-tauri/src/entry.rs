//! Process entry glue: needs the real `generate_context!()` and a native event loop, which cannot run
//! under unit tests. Everything testable lives in `lib.rs` (`configure`) and `splash.rs`. This file is excluded
//! from the coverage gate by name (see scripts/coverage-rust.sh) and must stay logic-free.

/// Quits the app (the splash's Quit button).
#[tauri::command]
pub fn app_quit<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    app.exit(0);
}

/// The splash's Open log button: shows the boot error in the platform's file manager (logic lives in splash.rs).
#[tauri::command]
pub fn open_log<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    splash: tauri::State<'_, crate::splash::Splash>,
) -> tauri::Result<()> {
    let error = crate::splash::boot_error(&splash);
    crate::splash::open_log_with(&app, &error, crate::splash::launch).map(|_| ())
}

/// The main window finished its boot work: show it, close the splash (logic lives in splash.rs).
#[tauri::command]
pub async fn main_ready<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    splash: tauri::State<'_, crate::splash::Splash>,
) -> tauri::Result<()> {
    crate::splash::reveal(app, &splash).await
}

/// Closing the splash window before the main window is up means the user wants out.
pub fn on_close_requested<R: tauri::Runtime>(window: &tauri::Window<R>) {
    use tauri::Manager;
    if crate::splash::quits_on_close(
        window.label(),
        window.state::<crate::splash::Splash>().revealed(),
    ) {
        window.app_handle().exit(0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::configure(tauri::Builder::default())
        .setup(crate::splash::setup)
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => on_close_requested(window),
            tauri::WindowEvent::Resized(_) => crate::splash::enforce_min_size(window),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Blockheads Patcher");
}
