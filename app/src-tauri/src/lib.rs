mod entry;
pub mod splash;
pub mod update;

pub use entry::run;

use tauri::{Builder, Runtime};

/// Registers every plugin the app uses. Kept separate from `run` so it is testable with the mock runtime.
pub fn configure<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_apk_tools::init())
        .manage(splash::Splash::from_env())
        .invoke_handler(tauri::generate_handler![
            splash::splash_set,
            splash::splash_get,
            splash::splash_retry,
            entry::app_quit,
            entry::main_ready,
            entry::open_log,
            update::update_target,
        ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn configure_registers_plugins_and_builds() {
        let app = configure(mock_builder()).build(mock_context(noop_assets()));
        assert!(app.is_ok());
    }
}
