// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if cfg!(feature = "desktop") {
        app_lib::run_tauri();
    } else {
        app_lib::run_backend();
    }
}
