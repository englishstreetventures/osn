const COMMANDS: &[&str] = &[
    "impact",
    "get_safe_area_insets",
    "update_glass_panels",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .try_build()
        .expect("failed to run tauri-plugin build script");
}
