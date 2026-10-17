use serde::de::DeserializeOwned;
use serde_json::Value;
use std::marker::PhantomData;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> std::result::Result<ApkTools<R>, Box<dyn std::error::Error>> {
    Ok(ApkTools(PhantomData))
}

/// Desktop stub: every operation is unsupported.
pub struct ApkTools<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> ApkTools<R> {
    pub fn call(&self, _command: &str, _payload: Value) -> Result<Value> {
        Err(Error::Unsupported)
    }
}
