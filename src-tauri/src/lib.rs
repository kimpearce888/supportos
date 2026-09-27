// SupportOS Tauri 2 shell (v1.3.0).
//
// The core application is a local web app (Fastify backend + built frontend);
// this shell only launches the bundled backend and opens a window. No native
// APIs are required by the core system (spec #114) - which is exactly why the
// same codebase runs in a browser, in `npm start`, and inside MSI/DMG/AppImage
// packages without changes.
//
// Packaging decision: the backend ships as an esbuild bundle plus ONE external
// native module (better-sqlite3) plus an official Node runtime binary, all in
// the app resources. `tauri dev` skips the sidecar entirely and talks to the
// Vite dev server, so the inner loop stays a normal web dev loop.
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::sync::Mutex;

use tauri::Manager;

/// The backend process handle; killed when the app exits so we never leak a node process.
struct ServerState {
    child: Mutex<Option<Child>>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window instead of spawning another backend.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .manage(ServerState { child: Mutex::new(None) })
        .setup(|app| {
            // Start the backend on a background thread so the window appears fast
            // even while SQLite migrations run on first launch.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = start_backend_and_open_window(&handle) {
                    eprintln!("[supportos] backend error: {e}");
                    // Surface the failure instead of silently quitting.
                    let _ = tauri::WebviewWindowBuilder::new(
                        &handle,
                        "main",
                        tauri::WebviewUrl::App("index.html".into()),
                    )
                    .title("SupportOS - startup failed")
                    .build();
                    let _ = handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running SupportOS")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Some(mut child) = app.state::<ServerState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}

fn start_backend_and_open_window(app: &tauri::AppHandle) -> Result<(), String> {
    let resource_dir: PathBuf = app.path().resource_dir().map_err(|e| e.to_string())?;
    let server_js = resource_dir.join("resources").join("server").join("index.cjs");
    let node_bin = resource_dir
        .join("resources")
        .join("node-bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let client_dir = resource_dir.join("resources").join("client");
    let data_dir: PathBuf = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("cannot create data dir: {e}"))?;

    // `tauri dev`: resources are absent (build-desktop.mjs is only run for real builds),
    // so open the Vite dev server instead of spawning a second backend.
    let dev_mode = !server_js.exists();
    let url = if dev_mode {
        "http://localhost:5173".to_string()
    } else {
        let port = free_port();

        // Extraction can drop the exec bit on some setups; re-assert it.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&node_bin) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&node_bin, perms);
            }
        }

        let child = Command::new(&node_bin)
            .arg(&server_js)
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .env("NODE_ENV", "production")
            .env("DATABASE_PATH", data_dir.join("supportos.db"))
            .env("ATTACHMENTS_PATH", data_dir.join("attachments"))
            .env("BACKUPS_PATH", data_dir.join("backups"))
            .env("SUPPORTOS_CLIENT_DIST", &client_dir)
            .spawn()
            .map_err(|e| format!("failed to start the bundled backend: {e}"))?;
        *app.state::<ServerState>().child.lock().unwrap() = Some(child);

        // Wait for /health (up to 30s: first launch runs migrations + demo seed).
        let mut healthy = false;
        for _ in 0..150 {
            if http_ok(port) {
                healthy = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        if !healthy {
            eprintln!("[supportos] backend did not report healthy within 30s; opening anyway");
        }
        format!("http://127.0.0.1:{port}")
    };

    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("invalid backend url {url}: {e}"))?;
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(parsed))
        .title("SupportOS")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 640.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Bind an ephemeral port, drop the listener, and return the port. The tiny race
/// between drop and the backend bind is acceptable for a localhost single-user app.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind an ephemeral port")
        .local_addr()
        .expect("local address")
        .port()
}

/// Minimal HTTP health probe over a raw socket - avoids pulling in an HTTP client crate.
fn http_ok(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    use std::io::{Read, Write};
    let request = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}
