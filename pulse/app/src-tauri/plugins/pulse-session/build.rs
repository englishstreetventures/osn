// One command, deliberately. `request` is the only thing the webview may call,
// and it is not a general-purpose fetch: the Rust side pins the origin from
// config and matches the path against a fixed allowlist, so the permission
// granted here cannot be widened from JS.
//
// Adding a name to this list generates an `allow-<cmd>` permission file, which
// is half of a live IPC surface. Keep it to what `lib.rs` actually handles.
const COMMANDS: &[&str] = &["request"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
