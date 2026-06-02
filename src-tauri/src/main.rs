// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::var_os("TAURI_ENV_PLATFORM").is_some() {
        app_lib::run_tauri();
    } else {
        app_lib::run_backend();
    }
}
