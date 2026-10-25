//! apk-tools plugin. Android functionality is implemented in Kotlin (`android/`); the Rust
//! commands forward to it. On other platforms every command rejects with `"unsupported"`.
//! Contract: docs/ARCHITECTURE.md section 8.
use serde_json::Value;
use std::future::Future;
use tauri::{
    ipc::{Invoke, InvokeError},
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

mod commands;
#[cfg(not(mobile))]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(not(mobile))]
use desktop::ApkTools;
#[cfg(mobile)]
use mobile::ApkTools;

/// Error type serialized to the webview as a plain string.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported")]
    Unsupported,
    #[cfg(mobile)]
    #[error("{0}")]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub trait ApkToolsExt<R: Runtime> {
    fn apk_tools(&self) -> &ApkTools<R>;
}

impl<R: Runtime, T: Manager<R>> ApkToolsExt<R> for T {
    fn apk_tools(&self) -> &ApkTools<R> {
        self.state::<ApkTools<R>>().inner()
    }
}

/// Dispatches the argument-less commands by hand (a `#[command]` expansion contains an argument
/// extraction error arm that is unreachable for them) and everything else to the generated handler.
fn handler<R: Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    let generated = typed::<R, _>(tauri::generate_handler![
        commands::get_installed_package,
        commands::read_installed_apk,
        commands::request_uninstall,
        commands::install_apk,
        commands::update_download,
    ]);
    move |invoke| match invoke.message.command() {
        "can_request_installs" => respond(invoke, commands::can_request_installs),
        "open_install_settings" => respond(invoke, commands::open_install_settings),
        "update_status" => respond(invoke, commands::update_status),
        "update_cancel" => respond(invoke, commands::update_cancel),
        _ => generated(invoke),
    }
}

fn typed<R: Runtime, H: Fn(Invoke<R>) -> bool>(h: H) -> H {
    h
}

fn respond<R, F, Fut>(invoke: Invoke<R>, command: F) -> bool
where
    R: Runtime,
    F: FnOnce(AppHandle<R>) -> Fut,
    Fut: Future<Output = Result<Value>> + Send + 'static,
{
    let app = invoke.message.webview_ref().app_handle().clone();
    let task = command(app);
    invoke.resolver.respond_async(async move { task.await.map_err(InvokeError::from) });
    true
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-tools")
        .invoke_handler(handler::<R>())
        .setup(|app, api| {
            #[cfg(mobile)]
            let tools = mobile::init(app, api)?;
            #[cfg(not(mobile))]
            let tools = desktop::init(app, api)?;
            app.manage(tools);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use tauri::ipc::{CallbackFn, InvokeBody, RuntimeAuthority};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewWindow, WebviewWindowBuilder};
    use tauri_utils::acl::resolved::{Resolved, ResolvedCommand};

    const COMMANDS: [&str; 9] = [
        "get_installed_package",
        "read_installed_apk",
        "request_uninstall",
        "install_apk",
        "can_request_installs",
        "open_install_settings",
        "update_download",
        "update_status",
        "update_cancel",
    ];

    /// Mock app with the plugin registered and every plugin command allowed for the "main" window
    /// (the mock context ships an empty ACL, which would reject plugin commands before dispatch).
    fn setup() -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
        let mut ctx = mock_context(noop_assets());
        let allowed_commands = COMMANDS
            .iter()
            .map(|c| {
                let cmd = ResolvedCommand {
                    windows: vec![glob::Pattern::new("main").unwrap()],
                    ..Default::default()
                };
                (format!("plugin:apk-tools|{c}"), vec![cmd])
            })
            .collect();
        let resolved = Resolved { allowed_commands, ..Default::default() };
        *ctx.runtime_authority_mut() = RuntimeAuthority::new(BTreeMap::new(), resolved);
        let app = mock_builder().plugin(init()).build(ctx).expect("mock app builds");
        let window = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock window builds");
        (app, window)
    }

    fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> std::result::Result<tauri::ipc::InvokeResponseBody, Value> {
        let req = InvokeRequest {
            cmd: format!("plugin:apk-tools|{cmd}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        };
        get_ipc_response(window, req)
    }

    #[test]
    fn every_command_rejects_unsupported_on_desktop() {
        let (_app, window) = setup();
        for cmd in COMMANDS {
            let body = json!({ "packageName": "com.example", "path": "/x.apk", "url": "https://x", "name": "n.apk", "size": 1, "sumsUrl": "" });
            assert_eq!(invoke(&window, cmd, body).unwrap_err(), json!("unsupported"), "{cmd}");
        }
    }

    #[test]
    fn commands_reject_missing_arguments() {
        let (_app, window) = setup();
        for cmd in COMMANDS {
            let err = invoke(&window, cmd, json!({})).unwrap_err();
            assert!(err == json!("unsupported") || err.as_str().unwrap().contains("missing required key"), "{cmd}: {err}");
        }
    }

    #[test]
    fn update_download_rejects_each_missing_argument() {
        let (_app, window) = setup();
        let full = json!({ "url": "https://x", "name": "n.apk", "size": 1, "sumsUrl": "" });
        for key in ["url", "name", "size", "sumsUrl"] {
            let mut body = full.clone();
            body.as_object_mut().unwrap().remove(key);
            let err = invoke(&window, "update_download", body).unwrap_err();
            assert!(err.as_str().unwrap().contains(&format!("missing required key {key}")), "{key}: {err}");
        }
    }

    #[test]
    fn error_serializes_as_plain_string() {
        assert_eq!(serde_json::to_string(&Error::Unsupported).unwrap(), "\"unsupported\"");
        assert_eq!(Error::Unsupported.to_string(), "unsupported");
    }

    #[test]
    fn ext_trait_exposes_managed_state() {
        let (app, _window) = setup();
        let r = app.handle().apk_tools().call("anything", json!({}));
        assert!(matches!(r, Err(Error::Unsupported)));
    }
}
