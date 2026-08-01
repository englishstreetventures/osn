use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{
    models::{NativeRequest, NativeResponse},
    Error, Result,
};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<PulseSession<R>> {
    Ok(PulseSession(app.clone()))
}

/// Desktop stub. Nothing calls it: a desktop webview has a working cookie jar,
/// so `@osn/client` keeps using plain `fetch` there and never installs the
/// native transport. Failing loudly beats returning a plausible empty response
/// if that ever stops being true.
pub struct PulseSession<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> PulseSession<R> {
    pub(crate) fn request(&self, _request: NativeRequest) -> Result<NativeResponse> {
        Err(Error::Unsupported)
    }
}
