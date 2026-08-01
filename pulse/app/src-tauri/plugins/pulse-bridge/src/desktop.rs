use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;
use crate::Result;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<PulseBridge<R>> {
    Ok(PulseBridge(app.clone()))
}

/// No-op desktop stub. `pulse` only ships on iOS; this exists solely so
/// `cargo build` on a host macOS/Linux/Windows dev machine compiles cleanly.
pub struct PulseBridge<R: Runtime>(AppHandle<R>);

impl<R: Runtime> PulseBridge<R> {
    pub fn impact(&self, _options: ImpactOptions) -> Result<()> {
        Ok(())
    }

    pub fn get_safe_area_insets(&self) -> Result<SafeAreaInsets> {
        Ok(SafeAreaInsets::default())
    }
}
