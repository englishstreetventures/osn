use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;
mod models;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};
pub use models::Config;

#[cfg(desktop)]
use desktop::PulseSession;
#[cfg(mobile)]
use mobile::PulseSession;

/// Rust-side access to the platform HTTP client. Nothing outside this crate
/// needs it — the webview goes through `commands::request`, which is the only
/// path that applies the allowlist.
pub(crate) trait PulseSessionExt<R: Runtime> {
    fn pulse_session(&self) -> &PulseSession<R>;
}

impl<R: Runtime, T: Manager<R>> PulseSessionExt<R> for T {
    fn pulse_session(&self) -> &PulseSession<R> {
        self.state::<PulseSession<R>>().inner()
    }
}

/// Reads `plugins.pulse-session.issuerUrl` from `tauri.conf.json`.
///
/// A bad or missing issuer fails the whole plugin setup, which fails app
/// startup. That is deliberate: this transport carries the session credential,
/// and a build that does not know where to send it should not run at all.
pub fn init<R: Runtime>() -> TauriPlugin<R, Config> {
    Builder::<R, Config>::new("pulse-session")
        .invoke_handler(tauri::generate_handler![commands::request])
        .setup(|app, api| {
            let issuer = commands::normalise_issuer(&api.config().issuer_url)?;

            #[cfg(mobile)]
            let session = mobile::init(app, api)?;
            #[cfg(desktop)]
            let session = desktop::init(app, api)?;

            app.manage(session);
            app.manage(commands::IssuerOrigin(issuer));
            Ok(())
        })
        .build()
}
