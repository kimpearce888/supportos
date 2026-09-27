// SupportOS Tauri 2 shell.
// The core application is a local web app (Fastify backend + built frontend);
// this shell only launches the backend sidecar and opens the window. No native
// APIs are required by the core system (spec #114).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            let resource_dir = app.path().resource_dir().expect("resource dir");
            let server = std::process::Command::new(get_node_binary())
                .arg(resource_dir.join("server/index.js"))
                .env("DATABASE_PATH", app_data_dir(app))
                .spawn()
                .expect("failed to start SupportOS backend");
            let _ = std::fs::write(resource_dir.join("supportos.pid"), server.id().to_string());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SupportOS");
}

fn app_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let dir = app.path().app_data_dir().expect("app data dir");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("supportos.db")
}

fn get_node_binary() -> String {
    // Prefer a bundled sidecar binary; fall back to system node for development.
    if cfg!(windows) {
        "supportos-server.exe".to_string()
    } else {
        "node".to_string()
    }
}
