use tauri::{command, AppHandle, Runtime};

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
