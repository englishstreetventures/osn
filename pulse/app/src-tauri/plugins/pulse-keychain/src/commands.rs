use tauri::{AppHandle, Runtime};

use crate::{PulseKeychainExt, Result};

/// Store `value` under `key` in the platform keychain, overwriting any
/// existing entry. No JS-facing command exists for this: only Rust callers
/// (e.g. the native session transport added in N3) can reach it.
pub fn set<R: Runtime>(app: &AppHandle<R>, key: String, value: String) -> Result<()> {
    app.pulse_keychain().set(key, value)
}

/// Retrieve the value stored under `key`, or `None` if it was never set.
pub fn get<R: Runtime>(app: &AppHandle<R>, key: String) -> Result<Option<String>> {
    app.pulse_keychain().get(key)
}

/// Remove the value stored under `key`. A no-op if nothing is stored there.
pub fn delete<R: Runtime>(app: &AppHandle<R>, key: String) -> Result<()> {
    app.pulse_keychain().delete(key)
}
