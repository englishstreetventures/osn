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
use desktop::PulseTabBar;
#[cfg(mobile)]
use mobile::PulseTabBar;

/// Extension trait to access the tab bar on `AppHandle`/`App`.
pub trait PulseTabBarExt<R: Runtime> {
    fn pulse_tab_bar(&self) -> &PulseTabBar<R>;
}

impl<R: Runtime, T: Manager<R>> PulseTabBarExt<R> for T {
    fn pulse_tab_bar(&self) -> &PulseTabBar<R> {
        self.state::<PulseTabBar<R>>().inner()
    }
}

/// Initializes the pulse-tabbar plugin: a real `UITabBar` pinned to the bottom
/// of the webview, with the webview's scroll inset adjusted to match. On
/// iOS 26 the bar picks up Liquid Glass from the system because its appearance
/// is left untouched — no private API involved.
///
/// Lives in its own crate rather than in `pulse-bridge` so that the tab bar
/// and the rest of the native surface can be worked on without colliding.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pulse-tabbar")
        .invoke_handler(tauri::generate_handler![
            commands::set_tabs,
            commands::set_selected_tab
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let pulse_tab_bar = mobile::init(app, api)?;
            #[cfg(desktop)]
            let pulse_tab_bar = desktop::init(app, api)?;
            app.manage(pulse_tab_bar);
            Ok(())
        })
        .build()
}
