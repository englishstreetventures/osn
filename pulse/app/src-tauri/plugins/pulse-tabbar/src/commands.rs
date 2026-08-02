use tauri::{command, ipc::Channel, AppHandle, Runtime};

use crate::models::*;
use crate::PulseTabBarExt;
use crate::Result;

/// Installs (or replaces) the native tab bar. An empty `tabs` list tears it
/// down and hands the webview its full height back.
///
/// `on_select` has to stay a top-level argument: Tauri's `CommandArg` impl for
/// `Channel` needs the `Webview` to register the channel, so a channel nested
/// inside `options` would not deserialize.
#[command]
pub(crate) async fn set_tabs<R: Runtime>(
    app: AppHandle<R>,
    options: SetTabsOptions,
    on_select: Channel<TabSelected>,
) -> Result<()> {
    options.validate()?;
    app.pulse_tab_bar().set_tabs(options, on_select)
}

/// Moves the highlight, for when the route changed from inside the webview
/// rather than from a tap.
#[command]
pub(crate) async fn set_selected_tab<R: Runtime>(
    app: AppHandle<R>,
    options: SetSelectedTabOptions,
) -> Result<()> {
    app.pulse_tab_bar().set_selected_tab(options)
}
