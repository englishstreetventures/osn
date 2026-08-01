#[cfg(not(target_os = "ios"))]
compile_error!(
    "pulse-session has no Android implementation; this crate is iOS-only. \
     Do not build src/mobile.rs for a mobile target other than iOS."
);

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{
    models::{NativeRequest, NativeResponse},
    Result,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pulse_session);

#[cfg(target_os = "ios")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<PulseSession<R>> {
    let handle = api.register_ios_plugin(init_plugin_pulse_session)?;
    Ok(PulseSession(handle))
}

/// A thin pass-through to `URLSession`. It holds no policy: the allowlist, the
/// Origin pin and the cookie jar all live in `commands.rs`, so the native side
/// can only do what Rust already decided to ask for.
pub struct PulseSession<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> PulseSession<R> {
    pub(crate) fn request(&self, request: NativeRequest) -> Result<NativeResponse> {
        self.0
            .run_mobile_plugin("request", request)
            .map_err(Into::into)
    }
}
