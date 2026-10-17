use serde_json::{json, Value};
use tauri::{command, AppHandle, Runtime};

use crate::{ApkToolsExt, Result};

#[command]
pub(crate) async fn get_installed_package<R: Runtime>(app: AppHandle<R>, package_name: String) -> Result<Value> {
    app.apk_tools().call("get_installed_package", json!({ "packageName": package_name }))
}

#[command]
pub(crate) async fn read_installed_apk<R: Runtime>(app: AppHandle<R>, package_name: String) -> Result<Value> {
    app.apk_tools().call("read_installed_apk", json!({ "packageName": package_name }))
}

#[command]
pub(crate) async fn request_uninstall<R: Runtime>(app: AppHandle<R>, package_name: String) -> Result<Value> {
    app.apk_tools().call("request_uninstall", json!({ "packageName": package_name }))
}

#[command]
pub(crate) async fn install_apk<R: Runtime>(app: AppHandle<R>, path: String) -> Result<Value> {
    app.apk_tools().call("install_apk", json!({ "path": path }))
}

pub(crate) async fn can_request_installs<R: Runtime>(app: AppHandle<R>) -> Result<Value> {
    app.apk_tools().call("can_request_installs", json!({}))
}

pub(crate) async fn open_install_settings<R: Runtime>(app: AppHandle<R>) -> Result<Value> {
    app.apk_tools().call("open_install_settings", json!({}))
}
