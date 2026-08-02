use std::sync::Mutex;

use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    ipc::Channel,
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;
use crate::Result;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pulse_tabbar);

#[cfg(all(mobile, not(target_os = "ios")))]
compile_error!("the pulse-tabbar plugin only supports iOS");

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<PulseTabBar<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_pulse_tabbar)?;
    Ok(PulseTabBar {
        handle,
        on_select: Mutex::new(None),
    })
}

/// Handle to the iOS-side `PulseTabBarPlugin` Swift class.
pub struct PulseTabBar<R: Runtime> {
    handle: PluginHandle<R>,
    /// The live selection channel, held so it outlives the command that
    /// carried it. Rust never sends on it — Swift does, on every tap — so
    /// nothing else in this crate reads the field.
    on_select: Mutex<Option<Channel<TabSelected>>>,
}

/// A `Channel` serializes to the string `__CHANNEL__:<id>`, which is exactly
/// what Swift's `Channel: Decodable` expects to find. That only works while
/// the value travels through the plugin's own argument decoding, so the
/// channel goes over the wire as a field of this payload rather than being
/// re-wrapped by hand.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetTabsPayload<'a> {
    tabs: &'a [TabItem],
    selected_id: Option<&'a str>,
    on_select: &'a Channel<TabSelected>,
}

impl<R: Runtime> PulseTabBar<R> {
    pub fn set_tabs(&self, options: SetTabsOptions, on_select: Channel<TabSelected>) -> Result<()> {
        self.handle.run_mobile_plugin::<()>(
            "setTabs",
            SetTabsPayload {
                tabs: &options.tabs,
                selected_id: options.selected_id.as_deref(),
                on_select: &on_select,
            },
        )?;

        // Only after the Swift side has taken the channel, so a rejected call
        // does not replace a working one.
        *self.on_select.lock().expect("tab bar channel lock") = Some(on_select);
        Ok(())
    }

    pub fn set_selected_tab(&self, options: SetSelectedTabOptions) -> Result<()> {
        self.handle
            .run_mobile_plugin("setSelectedTab", options)
            .map_err(Into::into)
    }
}
