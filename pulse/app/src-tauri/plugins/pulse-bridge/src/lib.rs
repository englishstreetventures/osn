use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::PulseBridge;
#[cfg(mobile)]
use mobile::PulseBridge;

/// Extension trait to access the pulse-bridge APIs on `AppHandle`/`App`.
pub trait PulseBridgeExt<R: Runtime> {
    fn pulse_bridge(&self) -> &PulseBridge<R>;
}

impl<R: Runtime, T: Manager<R>> PulseBridgeExt<R> for T {
    fn pulse_bridge(&self) -> &PulseBridge<R> {
        self.state::<PulseBridge<R>>().inner()
    }
}

/// Initializes the pulse-bridge plugin: `UIImpactFeedbackGenerator` haptics
/// plus safe-area insets pushed into CSS custom properties on the webview.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pulse-bridge")
        .invoke_handler(tauri::generate_handler![
            commands::impact,
            commands::get_safe_area_insets,
            commands::update_glass_panels,
            commands::register_listener,
            commands::remove_listener
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let pulse_bridge = mobile::init(app, api)?;
            #[cfg(desktop)]
            let pulse_bridge = desktop::init(app, api)?;
            app.manage(pulse_bridge);
            Ok(())
        })
        .build()
}
