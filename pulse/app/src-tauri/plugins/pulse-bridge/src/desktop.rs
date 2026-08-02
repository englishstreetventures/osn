use serde::de::DeserializeOwned;
use tauri::{ipc::Channel, plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;
use crate::Error;
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

    /// Unlike `impact`/`get_safe_area_insets` (silent no-ops, pre-existing),
    /// this fails loudly: a caller silently getting "success" with no glass
    /// panel ever drawn would hide a real desktop/browser code path bug.
    pub fn update_glass_panels(&self, _panels: Vec<GlassPanel>) -> Result<()> {
        Err(Error::Unsupported)
    }

    /// Same reasoning as `update_glass_panels`: JS should gate
    /// `addPluginListener` calls behind `nativeGlass`, so this path should
    /// never actually run on desktop — fail loudly rather than silently.
    pub fn register_listener(&self, _event: String, _handler: Channel<serde_json::Value>) -> Result<()> {
        Err(Error::Unsupported)
    }

    pub fn remove_listener(&self, _event: String, _channel_id: u32) -> Result<()> {
        Err(Error::Unsupported)
    }
}
