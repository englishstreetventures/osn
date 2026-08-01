use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub mod commands;
mod error;
#[cfg_attr(not(mobile), allow(dead_code))]
mod models;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::PulseKeychain;
#[cfg(mobile)]
use mobile::PulseKeychain;

/// Extension trait giving Rust code access to the device keychain. There is
/// no JS-facing command anywhere in this crate: the webview has no way to
/// reach this, by design.
pub trait PulseKeychainExt<R: Runtime> {
    fn pulse_keychain(&self) -> &PulseKeychain<R>;
}

impl<R: Runtime, T: Manager<R>> PulseKeychainExt<R> for T {
    fn pulse_keychain(&self) -> &PulseKeychain<R> {
        self.state::<PulseKeychain<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pulse-keychain")
        .setup(|app, api| {
            #[cfg(mobile)]
            let keychain = mobile::init(app, api)?;
            #[cfg(desktop)]
            let keychain = desktop::init(app, api)?;

            app.manage(keychain);
            Ok(())
        })
        .build()
}
