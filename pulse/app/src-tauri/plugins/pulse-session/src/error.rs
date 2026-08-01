use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),

    #[error("pulse-session is unsupported on this platform (iOS only)")]
    Unsupported,

    /// The webview asked for something outside the allowlist. The message is
    /// deliberately vague: a caller that reaches this is either buggy or
    /// hostile, and neither needs to learn the shape of the allowlist.
    #[error("request rejected")]
    Rejected,

    #[error("issuerUrl in the pulse-session plugin config is not a valid URL")]
    BadIssuerUrl,

    #[error("keychain: {0}")]
    Keychain(String),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
