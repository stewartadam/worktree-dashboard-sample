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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub fn run_backend() {
    let host = std::env::var("WORKTREE_APP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("WORKTREE_APP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3030);
    let address = format!("{host}:{port}");
    let listener = std::net::TcpListener::bind(&address)
        .unwrap_or_else(|error| panic!("failed to bind backend at {address}: {error}"));

    println!("sample backend listening on http://{address}");
    println!("sample backend API: http://{address}/api/app-state");

    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                if let Err(error) = handle_backend_connection(&mut stream, port) {
                    eprintln!("backend request failed: {error}");
                }
            }
            Err(error) => eprintln!("backend connection failed: {error}"),
        }
    }
}

fn handle_backend_connection(stream: &mut std::net::TcpStream, port: u16) -> std::io::Result<()> {
    use std::io::Read;

    let mut buffer = [0_u8; 2048];
    let read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let request_line = request.lines().next().unwrap_or_default();

    if request_line.starts_with("OPTIONS ") {
        write_response(stream, 204, "No Content", "")
    } else if request_line.starts_with("GET /health ") {
        write_json_response(stream, 200, "OK", r#"{"ok":true}"#)
    } else if request_line.starts_with("GET /api/app-state ") {
        write_json_response(stream, 200, "OK", &app_state_json(port))
    } else {
        write_json_response(
            stream,
            404,
            "Not Found",
            r#"{"ok":false,"error":"not found"}"#,
        )
    }
}

fn app_state_json(port: u16) -> String {
    let cwd = std::env::current_dir().unwrap_or_default();
    let worktree = cwd
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    format!(
        r#"{{"ok":true,"pid":{},"cwd":"{}","worktree":"{}","port":{},"generatedAt":"{}"}}"#,
        std::process::id(),
        json_escape(&cwd.display().to_string()),
        json_escape(worktree),
        port,
        json_escape(&unix_timestamp_string()),
    )
}

fn unix_timestamp_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn json_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn write_json_response(
    stream: &mut std::net::TcpStream,
    status_code: u16,
    status_text: &str,
    body: &str,
) -> std::io::Result<()> {
    write_response_with_content_type(stream, status_code, status_text, "application/json", body)
}

fn write_response(
    stream: &mut std::net::TcpStream,
    status_code: u16,
    status_text: &str,
    body: &str,
) -> std::io::Result<()> {
    write_response_with_content_type(stream, status_code, status_text, "text/plain", body)
}

fn write_response_with_content_type(
    stream: &mut std::net::TcpStream,
    status_code: u16,
    status_text: &str,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    use std::io::Write;

    write!(
        stream,
        "HTTP/1.1 {status_code} {status_text}\r\n\
     Access-Control-Allow-Origin: *\r\n\
     Access-Control-Allow-Methods: GET, OPTIONS\r\n\
     Access-Control-Allow-Headers: Content-Type\r\n\
     Content-Type: {content_type}; charset=utf-8\r\n\
     Content-Length: {}\r\n\
     Cache-Control: no-store\r\n\
     \r\n\
     {body}",
        body.len(),
    )
}
