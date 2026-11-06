mod backend;
mod monitor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_tauri();
}

pub fn run_tauri() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            backend::spawn_embedded();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub fn run_backend() {
    backend::run();
}
