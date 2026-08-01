#[cfg(not(target_os = "ios"))]
compile_error!(
    "pulse-keychain has no Android implementation; this crate is iOS-only. \
     Do not build src/mobile.rs for a mobile target other than iOS."
);

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{
    models::{KeyPayload, SetPayload},
    Result,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pulse_keychain);

#[cfg(target_os = "ios")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<PulseKeychain<R>> {
    let handle = api.register_ios_plugin(init_plugin_pulse_keychain)?;
    Ok(PulseKeychain(handle))
}

pub struct PulseKeychain<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> PulseKeychain<R> {
    pub fn set(&self, key: String, value: String) -> Result<()> {
        self.0
            .run_mobile_plugin("set", SetPayload { key, value })
            .map_err(Into::into)
    }

    pub fn get(&self, key: String) -> Result<Option<String>> {
        self.0
            .run_mobile_plugin("get", KeyPayload { key })
            .map_err(Into::into)
    }

    pub fn delete(&self, key: String) -> Result<()> {
        self.0
            .run_mobile_plugin("delete", KeyPayload { key })
            .map_err(Into::into)
    }
}
