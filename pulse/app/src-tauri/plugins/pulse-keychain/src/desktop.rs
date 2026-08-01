use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<PulseKeychain<R>> {
    Ok(PulseKeychain(app.clone()))
}

/// Desktop stub: no keychain-backed store exists on this platform, so every
/// operation fails explicitly rather than pretending to persist anything.
pub struct PulseKeychain<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> PulseKeychain<R> {
    pub fn set(&self, _key: String, _value: String) -> Result<()> {
        Err(Error::Unsupported)
    }

    pub fn get(&self, _key: String) -> Result<Option<String>> {
        Err(Error::Unsupported)
    }

    pub fn delete(&self, _key: String) -> Result<()> {
        Err(Error::Unsupported)
    }
}
