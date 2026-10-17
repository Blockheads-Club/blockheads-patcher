use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::Result;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.blockheadspatcher.apktools";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> std::result::Result<ApkTools<R>, Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ApkToolsPlugin")?;
        Ok(ApkTools(handle))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = api;
        Err("apk-tools is only supported on Android".into())
    }
}

/// Forwards commands to the Kotlin plugin.
pub struct ApkTools<R: Runtime>(pub PluginHandle<R>);

impl<R: Runtime> ApkTools<R> {
    pub fn call(&self, command: &str, payload: Value) -> Result<Value> {
        Ok(self.0.run_mobile_plugin(command, payload)?)
    }
}
