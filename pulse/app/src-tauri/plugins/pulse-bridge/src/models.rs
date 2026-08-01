use serde::{Deserialize, Serialize};

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
