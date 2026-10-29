fn main() {
    // Declaring the app's own commands generates `allow-list-displays`, `allow-open-screen` and
    // `allow-close-screen` permissions, which the capability grants to the
    // live console page (a remote page gets nothing it isn't granted).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["list_displays", "open_screen", "close_screen", "open_download"])),
    )
    .expect("failed to run tauri-build");
}
