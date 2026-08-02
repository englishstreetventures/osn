use serde::de::DeserializeOwned;
use tauri::{
    ipc::Channel,
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;
use crate::Result;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pulse_bridge);

#[cfg(all(mobile, not(target_os = "ios")))]
compile_error!("the pulse-bridge plugin only supports iOS");

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<PulseBridge<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_pulse_bridge)?;
    Ok(PulseBridge(handle))
}

/// Handle to the iOS-side `PulseBridgePlugin` Swift class.
pub struct PulseBridge<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> PulseBridge<R> {
    pub fn impact(&self, options: ImpactOptions) -> Result<()> {
        self.0
            .run_mobile_plugin("impact", options)
            .map_err(Into::into)
    }

    pub fn get_safe_area_insets(&self) -> Result<SafeAreaInsets> {
        self.0
            .run_mobile_plugin("getSafeAreaInsets", ())
            .map_err(Into::into)
    }

    pub fn update_glass_panels(&self, panels: Vec<GlassPanel>) -> Result<()> {
        self.0
            .run_mobile_plugin("updateGlassPanels", UpdateGlassPanelsOptions { panels })
            .map_err(Into::into)
    }

    /// `registerListener`/`removeListener` are inherited, unmodified, from the
    /// vendored Swift `Plugin` base class — no override needed in
    /// `PulseBridgePlugin.swift`, they already back `Plugin.trigger()`.
    pub fn register_listener(&self, event: String, handler: Channel<serde_json::Value>) -> Result<()> {
        self.0
            .run_mobile_plugin("registerListener", RegisterListenerArgs { event, handler })
            .map_err(Into::into)
    }

    pub fn remove_listener(&self, event: String, channel_id: u32) -> Result<()> {
        self.0
            .run_mobile_plugin("removeListener", RemoveListenerArgs { event, channel_id })
            .map_err(Into::into)
    }
}
