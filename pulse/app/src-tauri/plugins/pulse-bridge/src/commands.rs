use tauri::{command, ipc::Channel, AppHandle, Runtime};

use crate::models::*;
use crate::Result;
use crate::PulseBridgeExt;

#[command]
pub(crate) async fn impact<R: Runtime>(app: AppHandle<R>, options: ImpactOptions) -> Result<()> {
    app.pulse_bridge().impact(options)
}

#[command]
pub(crate) async fn get_safe_area_insets<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SafeAreaInsets> {
    app.pulse_bridge().get_safe_area_insets()
}

#[command]
pub(crate) async fn update_glass_panels<R: Runtime>(
    app: AppHandle<R>,
    options: UpdateGlassPanelsOptions,
) -> Result<()> {
    app.pulse_bridge().update_glass_panels(options.panels)
}

#[command]
pub(crate) async fn register_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    handler: Channel<serde_json::Value>,
) -> Result<()> {
    app.pulse_bridge().register_listener(event, handler)
}

#[command]
pub(crate) async fn remove_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    channel_id: u32,
) -> Result<()> {
    app.pulse_bridge().remove_listener(event, channel_id)
}
