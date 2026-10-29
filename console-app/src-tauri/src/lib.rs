// The InsPhoto console as a desktop app. The main window opens a small
// local page (dist/index.html) that checks the connection and then loads
// the live console from Cloudflare Pages — so the app never needs
// reinstalling to get console updates.
//
// Like Lucky Draw's output window, the app can also put the LED screen
// (/s/<event>) full screen on another display ("Extend screen"), so one
// laptop runs both. The console page lists the displays through
// `list_displays` and asks for the screen through `open_screen` /
// `close_screen`.

use serde::Serialize;
use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const SITE: &str = "https://insphoto.pages.dev";
const SCREEN: &str = "screen";
const CONSOLE: &str = "console";

fn valid_slug(slug: &str) -> bool {
    (3..=40).contains(&slug.len())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Serialize)]
struct Display {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    is_console: bool,
}

fn same_monitor(a: &Monitor, b: &Monitor) -> bool {
    a.position() == b.position() && a.size() == b.size()
}

fn monitors(app: &AppHandle) -> Result<(Vec<Monitor>, Option<Monitor>), String> {
    let console = app.get_webview_window(CONSOLE).ok_or("console window missing")?;
    let here = console.current_monitor().map_err(|e| e.to_string())?;
    let all = console.available_monitors().map_err(|e| e.to_string())?;
    Ok((all, here))
}

/// Every connected display, in the order `open_screen` takes them.
#[tauri::command]
async fn list_displays(app: AppHandle) -> Result<Vec<Display>, String> {
    let (all, here) = monitors(&app)?;
    Ok(all
        .iter()
        .enumerate()
        .map(|(index, m)| Display {
            index,
            name: m.name().cloned().unwrap_or_default(),
            width: m.size().width,
            height: m.size().height,
            is_console: here.as_ref().is_some_and(|h| same_monitor(h, m)),
        })
        .collect())
}

/// Opens (or re-opens) the LED screen for `slug` full screen on `display`
/// (an index from `list_displays`), or on the first display that isn't the
/// console's when none is given. On the console's own display it opens as
/// a normal window, so the operator is never trapped behind it.
/// Async on purpose: creating a window from a synchronous command
/// deadlocks on Windows.
#[tauri::command]
async fn open_screen(app: AppHandle, slug: String, display: Option<usize>) -> Result<String, String> {
    if !valid_slug(&slug) {
        return Err("invalid event".into());
    }
    if let Some(old) = app.get_webview_window(SCREEN) {
        let _ = old.destroy();
    }

    let (all, here) = monitors(&app)?;
    let is_console = |m: &Monitor| here.as_ref().is_some_and(|h| same_monitor(h, m));
    let target = match display {
        Some(i) => Some((i, all.get(i).cloned().ok_or("that display is no longer connected — press ↻")?)),
        None => all.iter().enumerate().find(|(_, m)| !is_console(m)).map(|(i, m)| (i, m.clone())),
    };

    let url = format!("{SITE}/s/{slug}").parse().map_err(|e| format!("{e}"))?;
    let screen = WebviewWindowBuilder::new(&app, SCREEN, WebviewUrl::External(url))
        .title("InsPhoto Screen")
        .inner_size(1280.0, 720.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    let message = match target {
        Some((i, m)) if !is_console(&m) => {
            // Windows only makes a window full screen on the display it is
            // actually showing on, so: move it there, show it, then go full
            // screen — and if that didn't take, cover the display by hand.
            let p = m.position();
            let size = m.size();
            screen
                .set_position(PhysicalPosition::new(p.x + 50, p.y + 50))
                .map_err(|e| e.to_string())?;
            screen.set_decorations(false).map_err(|e| e.to_string())?;
            screen.show().map_err(|e| e.to_string())?;
            screen.set_fullscreen(true).map_err(|e| e.to_string())?;
            pause(150).await;
            if !screen.is_fullscreen().unwrap_or(false) {
                let _ = screen.set_position(PhysicalPosition::new(p.x, p.y));
                let _ = screen.set_size(*size);
                let _ = screen.set_fullscreen(true);
            }
            format!("Screen is showing full screen on Display {} ({}×{}).", i + 1, size.width, size.height)
        }
        Some(_) => {
            screen.show().map_err(|e| e.to_string())?;
            "That's the console's own display — the screen opened in a window. Pick the LED/projector display to go full screen.".into()
        }
        None => {
            screen.show().map_err(|e| e.to_string())?;
            "Only one display found — the screen opened in a window. Connect the LED/projector, press ↻, then Extend screen.".into()
        }
    };
    // Keep the operator's focus on the console.
    if let Some(console) = app.get_webview_window(CONSOLE) {
        let _ = console.set_focus();
    }
    Ok(message)
}

async fn pause(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms))
    })
    .await;
}

/// Opens a new console app installer from this project's GitHub releases
/// in the default browser, which downloads it; the operator then runs it
/// over the installed app. Only release URLs of this repo are accepted.
#[tauri::command]
async fn open_download(url: String) -> Result<(), String> {
    const RELEASES: &str = "https://github.com/Bradyee81/Insphoto/releases/";
    if !url.starts_with(RELEASES) || url.contains(|c: char| c.is_whitespace() || c == '"') {
        return Err("not an InsPhoto release link".into());
    }
    std::process::Command::new("explorer")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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
        .invoke_handler(tauri::generate_handler![list_displays, open_screen, close_screen, open_download])
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
