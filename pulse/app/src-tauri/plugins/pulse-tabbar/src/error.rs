use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    /// The tab set the webview asked for cannot be rendered faithfully.
    #[error("invalid tabs: {0}")]
    InvalidTabs(String),
    /// There is no native tab bar off iOS. The webview treats this as its cue
    /// to keep rendering the DOM tabs, so it has to be distinguishable from a
    /// real failure.
    #[error("a native tab bar is only available on iOS")]
    Unsupported,
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
