// No commands. This plugin is reachable from Rust only — see src/lib.rs.
//
// Listing a command here generates an `allow-<cmd>` permission, which is the
// first half of a webview-callable IPC surface. Keep this empty so a stray
// `.invoke_handler(...)` in lib.rs cannot silently become a live surface with
// its permission already granted.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
