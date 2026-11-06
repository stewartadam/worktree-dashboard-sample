//! A small read-only HTTP server for the sample app, built on `std::net`.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use crate::monitor::Monitor;

/// Longest request head to read. These routes take no body or large headers.
const MAX_REQUEST_HEAD_BYTES: usize = 8192;
/// Browsers can open a connection and send nothing, so don't wait forever.
const READ_TIMEOUT: Duration = Duration::from_secs(2);
/// The Web UI listens one port above the backend.
const UI_PORT_OFFSET: u16 = 1;
const TAURI_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

struct Config {
    host: String,
    port: u16,
}

impl Config {
    fn from_env() -> Self {
        Self {
            host: std::env::var("APP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
            port: std::env::var("APP_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(3030),
        }
    }

    fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// Only this worktree's Web UI and the desktop app may read the API, so a
    /// website open in the same browser can't read host details.
    fn allowed_origins(&self) -> Vec<String> {
        let ui_port = self.port.saturating_add(UI_PORT_OFFSET);
        ["localhost", "127.0.0.1", "[::1]", self.host.as_str()]
            .iter()
            .map(|host| format!("http://{host}:{ui_port}"))
            .chain(TAURI_ORIGINS.iter().map(ToString::to_string))
            .collect()
    }
}

struct Backend {
    monitor: Arc<Monitor>,
    allowed_origins: Vec<String>,
}

/// Runs the standalone backend until the process exits.
pub fn run() {
    let config = Config::from_env();
    let address = config.address();
    let listener = TcpListener::bind(&address)
        .unwrap_or_else(|error| panic!("failed to bind backend at {address}: {error}"));

    println!("sample backend listening on http://{address}");
    println!("sample backend API: http://{address}/api/system");

    serve(listener, start_backend(&config));
}

/// Starts the backend alongside the desktop app, unless one is already running
/// on this port, in which case the app uses that one.
pub fn spawn_embedded() {
    let config = Config::from_env();
    let address = config.address();
    match TcpListener::bind(&address) {
        Ok(listener) => {
            std::thread::spawn(move || serve(listener, start_backend(&config)));
        }
        Err(error) if error.kind() == ErrorKind::AddrInUse => {
            log::info!("using the backend already running at {address}");
        }
        Err(error) => log::error!("failed to bind backend at {address}: {error}"),
    }
}

fn start_backend(config: &Config) -> Arc<Backend> {
    Arc::new(Backend {
        monitor: Monitor::start(config.port),
        allowed_origins: config.allowed_origins(),
    })
}

fn serve(listener: TcpListener, backend: Arc<Backend>) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                // One thread per connection, so an idle client can't hold up the rest.
                let backend = Arc::clone(&backend);
                std::thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, &backend) {
                        eprintln!("backend request failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("backend connection failed: {error}"),
        }
    }
}

struct Request<'a> {
    method: &'a str,
    path: &'a str,
    origin: Option<&'a str>,
}

fn handle_connection(mut stream: TcpStream, backend: &Backend) -> std::io::Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let head = match read_request_head(&mut stream) {
        Ok(head) => head,
        // The client connected but never sent a request, which isn't a failure.
        Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let Some(request) = parse_request(&head) else {
        return Ok(());
    };

    backend.monitor.record_request();
    let (status, body) = route(&request, &backend.monitor);
    let allowed_origin = request.origin.filter(|origin| {
        backend
            .allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
    });
    write_response(&mut stream, status, allowed_origin, &body)
}

fn read_request_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut head = Vec::new();
    let mut chunk = [0_u8; 1024];
    while head.len() < MAX_REQUEST_HEAD_BYTES && !head.windows(4).any(|end| end == b"\r\n\r\n") {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..read]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

fn parse_request(head: &str) -> Option<Request<'_>> {
    let mut lines = head.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?;
    let target = request_line.next()?;
    let origin = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("origin").then(|| value.trim())
    });

    Some(Request {
        method,
        path: target.split('?').next().unwrap_or(target),
        origin,
    })
}

fn route(request: &Request, monitor: &Monitor) -> (u16, String) {
    match (request.method, request.path) {
        ("GET", "/health") => (200, r#"{"ok":true}"#.to_string()),
        ("GET", "/api/system") => match serde_json::to_string(&monitor.snapshot()) {
            Ok(body) => (200, body),
            Err(error) => {
                eprintln!("failed to serialize system snapshot: {error}");
                (
                    500,
                    r#"{"ok":false,"error":"internal server error"}"#.to_string(),
                )
            }
        },
        _ => (404, r#"{"ok":false,"error":"not found"}"#.to_string()),
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    allowed_origin: Option<&str>,
    body: &str,
) -> std::io::Result<()> {
    let status_text = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let cors_header = allowed_origin
        .map(|origin| format!("Access-Control-Allow-Origin: {origin}\r\n"))
        .unwrap_or_default();

    write!(
        stream,
        "HTTP/1.1 {status} {status_text}\r\n\
         {cors_header}\
         Vary: Origin\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Starts a backend on a free port that allows the UI origin of port 3030.
    fn start_test_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = Config {
            host: "127.0.0.1".to_string(),
            port: 3030,
        };
        let backend = start_backend(&config);
        std::thread::spawn(move || serve(listener, backend));
        port
    }

    fn send(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn get_from(port: u16, path: &str, origin: &str) -> String {
        send(
            port,
            &format!("GET {path} HTTP/1.1\r\nHost: test\r\nOrigin: {origin}\r\n\r\n"),
        )
    }

    fn body_json(response: &str) -> serde_json::Value {
        let (_, body) = response.split_once("\r\n\r\n").unwrap();
        serde_json::from_str(body).unwrap()
    }

    #[test]
    fn health_reports_ok() {
        let port = start_test_server();
        let response = get_from(port, "/health", "http://localhost:3031");

        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert_eq!(body_json(&response)["ok"], true);
    }

    #[test]
    fn system_returns_backend_host_and_history() {
        let port = start_test_server();
        let body = body_json(&get_from(port, "/api/system?x=1", "http://localhost:3031"));

        assert_eq!(body["backend"]["pid"], std::process::id());
        assert_eq!(body["backend"]["port"], 3030);
        assert_eq!(body["backend"]["requestCount"], 1);
        assert_eq!(body["host"]["arch"], std::env::consts::ARCH);
        assert!(body["host"]["coreCount"].as_u64().unwrap() > 0);
        assert!(body["current"]["memoryTotalBytes"].as_u64().unwrap() > 0);
        assert!(!body["history"].as_array().unwrap().is_empty());
    }

    #[test]
    fn unknown_routes_and_methods_return_not_found() {
        let port = start_test_server();

        let missing = get_from(port, "/api/nope", "http://localhost:3031");
        assert!(missing.starts_with("HTTP/1.1 404 "));

        let post = send(port, "POST /api/system HTTP/1.1\r\nHost: test\r\n\r\n");
        assert!(post.starts_with("HTTP/1.1 404 "));
    }

    #[test]
    fn cors_allows_only_the_ui_and_desktop_origins() {
        let port = start_test_server();

        for origin in [
            "http://localhost:3031",
            "http://127.0.0.1:3031",
            "tauri://localhost",
        ] {
            let response = get_from(port, "/health", origin);
            assert!(
                response.contains(&format!("Access-Control-Allow-Origin: {origin}\r\n")),
                "{origin} should be allowed"
            );
        }

        for origin in ["https://example.com", "http://localhost:9999"] {
            let response = get_from(port, "/health", origin);
            assert!(
                !response.contains("Access-Control-Allow-Origin"),
                "{origin} should be refused"
            );
        }
    }

    #[test]
    fn an_idle_connection_does_not_block_other_requests() {
        let port = start_test_server();
        let _idle = TcpStream::connect(("127.0.0.1", port)).unwrap();

        let response = get_from(port, "/health", "http://localhost:3031");

        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    }

    #[test]
    fn parse_request_finds_the_origin_in_any_case() {
        let request =
            parse_request("GET /health?a=1 HTTP/1.1\r\nHost: x\r\nORIGIN: http://a\r\n\r\n")
                .unwrap();

        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/health");
        assert_eq!(request.origin, Some("http://a"));
    }
}
