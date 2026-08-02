use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImpactStyle {
    Light,
    #[serde(alias = "default")]
    Medium,
    Heavy,
    Soft,
    Rigid,
}

impl Default for ImpactStyle {
    fn default() -> Self {
        Self::Medium
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactOptions {
    #[serde(default)]
    pub style: ImpactStyle,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeAreaInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// A screen-space rect (webview points, matching `getBoundingClientRect()`)
/// backing one native glass panel composited over the webview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassPanel {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub corner_radius: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGlassPanelsOptions {
    pub panels: Vec<GlassPanel>,
}

/// Args for the Swift `Plugin` base class's built-in `registerListener`,
/// forwarding one JS-side `Channel` to receive every future `trigger()` call
/// for `event` (native panel interactions: hour changes, zoom taps).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterListenerArgs {
    pub event: String,
    pub handler: Channel<serde_json::Value>,
}

/// Args for the Swift `Plugin` base class's built-in `removeListener`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveListenerArgs {
    pub event: String,
    pub channel_id: u32,
}
