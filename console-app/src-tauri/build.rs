fn main() {
    // Declaring the app's own commands generates `allow-open-screen` and
    // `allow-close-screen` permissions, which the capability grants to the
    // live console page (a remote page gets nothing it isn't granted).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["open_screen", "close_screen"])),
    )
    .expect("failed to run tauri-build");
}
