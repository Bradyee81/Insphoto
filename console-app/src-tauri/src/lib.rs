// The InsPhoto console as a desktop app. The main window opens a small
// local page (dist/index.html) that checks the connection and then loads
// the live console from Cloudflare Pages — so the app never needs
// reinstalling to get console updates.
//
// Like Lucky Draw's output window, the app can also put the LED screen
// (/s/<event>) full screen on a second display, so one laptop runs both.
// The console page asks for it through `open_screen` / `close_screen`.

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const SITE: &str = "https://insphoto.pages.dev";
const SCREEN: &str = "screen";
const CONSOLE: &str = "console";

fn valid_slug(slug: &str) -> bool {
    (3..=40).contains(&slug.len())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Opens (or re-opens) the LED screen for `slug`. Full screen on a display
/// other than the console's when there is one; otherwise a normal window on
/// the same display, so the operator is never trapped behind it.
/// Async on purpose: creating a window from a synchronous command
/// deadlocks on Windows.
#[tauri::command]
async fn open_screen(app: AppHandle, slug: String) -> Result<String, String> {
    if !valid_slug(&slug) {
        return Err("invalid event".into());
    }
    if let Some(old) = app.get_webview_window(SCREEN) {
        let _ = old.destroy();
    }

    let console = app.get_webview_window(CONSOLE).ok_or("console window missing")?;
    let here = console.current_monitor().map_err(|e| e.to_string())?;
    let monitors = console.available_monitors().map_err(|e| e.to_string())?;
    let other = monitors.into_iter().find(|m| match &here {
        Some(h) => m.position() != h.position(),
        None => false,
    });

    let url = format!("{SITE}/s/{slug}").parse().map_err(|e| format!("{e}"))?;
    let screen = WebviewWindowBuilder::new(&app, SCREEN, WebviewUrl::External(url))
        .title("InsPhoto Screen")
        .inner_size(1280.0, 720.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    let message = match other {
        Some(m) => {
            let p = m.position();
            screen
                .set_position(PhysicalPosition::new(p.x, p.y))
                .map_err(|e| e.to_string())?;
            screen.set_decorations(false).map_err(|e| e.to_string())?;
            screen.set_fullscreen(true).map_err(|e| e.to_string())?;
            "Screen is showing on the second display."
        }
        None => "Only one display found — the screen opened in a window. Connect the LED/projector and press again.",
    };
    screen.show().map_err(|e| e.to_string())?;
    // Keep the operator's focus on the console.
    let _ = console.set_focus();
    Ok(message.into())
}

#[tauri::command]
async fn close_screen(app: AppHandle) {
    if let Some(w) = app.get_webview_window(SCREEN) {
        let _ = w.destroy();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_screen, close_screen])
        .on_window_event(|window, event| {
            // Closing the console closes the screen window with it.
            if window.label() == CONSOLE {
                if let WindowEvent::CloseRequested { .. } = event {
                    if let Some(w) = window.app_handle().get_webview_window(SCREEN) {
                        let _ = w.destroy();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the InsPhoto console");
}
