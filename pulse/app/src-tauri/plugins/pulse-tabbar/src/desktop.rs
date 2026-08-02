use serde::de::DeserializeOwned;
use tauri::{ipc::Channel, plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<PulseTabBar<R>> {
    Ok(PulseTabBar(app.clone()))
}

/// Desktop stub. `pulse` only ships on iOS; this exists so `cargo build` on a
/// host dev machine compiles. Every command reports `Unsupported` rather than
/// succeeding silently — a webview that got `Ok` here would hide its DOM tabs
/// and leave the user with no navigation at all.
pub struct PulseTabBar<R: Runtime>(AppHandle<R>);

impl<R: Runtime> PulseTabBar<R> {
    pub fn set_tabs(
        &self,
        _options: SetTabsOptions,
        _on_select: Channel<TabSelected>,
    ) -> Result<()> {
        Err(Error::Unsupported)
    }

    pub fn set_selected_tab(&self, _options: SetSelectedTabOptions) -> Result<()> {
        Err(Error::Unsupported)
    }
}
