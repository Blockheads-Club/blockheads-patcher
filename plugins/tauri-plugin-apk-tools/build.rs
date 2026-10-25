const COMMANDS: &[&str] = &[
    "get_installed_package", "read_installed_apk", "request_uninstall",
    "install_apk", "can_request_installs", "open_install_settings", "update_download", "update_status", "update_cancel",
];
fn main() { tauri_plugin::Builder::new(COMMANDS).android_path("android").build(); }
