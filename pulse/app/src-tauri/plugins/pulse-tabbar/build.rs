// Two independent halves have to agree, and nothing checks that they do:
// this list generates the `allow-<cmd>`/`deny-<cmd>` permission files, while
// `Builder::invoke_handler` in src/lib.rs registers the callable commands.
// A name here without a handler there is a granted permission that resolves
// to nothing.
const COMMANDS: &[&str] = &["set_tabs", "set_selected_tab"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .try_build()
        .expect("failed to run tauri-plugin build script");
}
