//! Samples host and process stats on a background thread, so CPU usage is
//! measured over a steady interval however often clients poll.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sysinfo::{
    CpuRefreshKind, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind,
    System, MINIMUM_CPU_UPDATE_INTERVAL,
};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
/// One minute of history at `SAMPLE_INTERVAL`.
const HISTORY_LEN: usize = 60;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    name: String,
    os: String,
    arch: &'static str,
    core_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reading {
    cpu_percent: f32,
    core_cpu_percents: Vec<f32>,
    memory_used_bytes: u64,
    memory_total_bytes: u64,
    /// `None` on Windows, which has no load average.
    load_average: Option<[f64; 3]>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct CpuPoint {
    timestamp_ms: u64,
    cpu_percent: f32,
}

struct Latest {
    reading: Reading,
    backend_memory_bytes: u64,
    history: VecDeque<CpuPoint>,
}

/// The details that differ between worktrees, unlike the host stats they share.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendInfo<'a> {
    pid: u32,
    worktree: &'a str,
    port: u16,
    uptime_seconds: u64,
    request_count: u64,
    memory_bytes: u64,
}

/// The body of `GET /api/system`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot<'a> {
    ok: bool,
    backend: BackendInfo<'a>,
    host: HostInfo,
    current: Reading,
    history: Vec<CpuPoint>,
}

pub struct Monitor {
    started_at: Instant,
    pid: u32,
    worktree: String,
    port: u16,
    host: HostInfo,
    requests: AtomicU64,
    latest: Mutex<Latest>,
}

impl Monitor {
    /// Takes a first sample, then keeps sampling on a background thread.
    ///
    /// Blocks briefly, because CPU usage is the difference between two readings.
    pub fn start(port: u16) -> Arc<Self> {
        let mut system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        )
        .expect("failed to initialize system monitoring");
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);

        let pid = std::process::id();
        let cwd = std::env::current_dir().unwrap_or_default();
        let (reading, backend_memory_bytes) = take_reading(&mut system, pid);
        let mut history = VecDeque::with_capacity(HISTORY_LEN);
        push_point(&mut history, now_ms(), reading.cpu_percent);

        let monitor = Arc::new(Self {
            started_at: Instant::now(),
            pid,
            worktree: worktree_name(&cwd),
            port,
            host: HostInfo {
                name: System::host_name().unwrap_or_else(|_| "unknown".to_string()),
                os: System::long_os_version().unwrap_or_else(|_| std::env::consts::OS.to_string()),
                arch: std::env::consts::ARCH,
                core_count: reading.core_cpu_percents.len(),
            },
            requests: AtomicU64::new(0),
            latest: Mutex::new(Latest {
                reading,
                backend_memory_bytes,
                history,
            }),
        });

        let sampler = Arc::clone(&monitor);
        std::thread::spawn(move || loop {
            std::thread::sleep(SAMPLE_INTERVAL);
            let (reading, backend_memory_bytes) = take_reading(&mut system, sampler.pid);
            let mut latest = sampler.latest.lock().expect("monitor lock poisoned");
            push_point(&mut latest.history, now_ms(), reading.cpu_percent);
            latest.reading = reading;
            latest.backend_memory_bytes = backend_memory_bytes;
        });

        monitor
    }

    pub fn record_request(&self) {
        self.requests.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> Snapshot<'_> {
        let latest = self.latest.lock().expect("monitor lock poisoned");
        Snapshot {
            ok: true,
            backend: BackendInfo {
                pid: self.pid,
                worktree: &self.worktree,
                port: self.port,
                uptime_seconds: self.started_at.elapsed().as_secs(),
                request_count: self.requests.load(Ordering::Relaxed),
                memory_bytes: latest.backend_memory_bytes,
            },
            host: self.host.clone(),
            current: latest.reading.clone(),
            history: latest.history.iter().copied().collect(),
        }
    }
}

fn take_reading(system: &mut System, pid: u32) -> (Reading, u64) {
    system.refresh_cpu_usage();
    system.refresh_memory();
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let reading = Reading {
        cpu_percent: round_percent(system.global_cpu_usage()),
        core_cpu_percents: system
            .cpus()
            .iter()
            .map(|cpu| round_percent(cpu.usage()))
            .collect(),
        memory_used_bytes: system.used_memory(),
        memory_total_bytes: system.total_memory(),
        load_average: if cfg!(windows) {
            None
        } else {
            System::load_average()
                .ok()
                .map(|load| [load.one, load.five, load.fifteen])
        },
    };
    let backend_memory_bytes = system.process(pid).map_or(0, |process| process.memory());
    (reading, backend_memory_bytes)
}

fn round_percent(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

fn push_point(history: &mut VecDeque<CpuPoint>, timestamp_ms: u64, cpu_percent: f32) {
    if history.len() == HISTORY_LEN {
        history.pop_front();
    }
    history.push_back(CpuPoint {
        timestamp_ms,
        cpu_percent,
    });
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Names the worktree containing `dir`. Backends run from `src-tauri`, so this
/// looks for the checkout root, where `.git` is a directory or a worktree's file.
fn worktree_name(dir: &Path) -> String {
    let root = dir
        .ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
        .unwrap_or(dir);
    root.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_keeps_only_the_newest_points() {
        let mut history = VecDeque::new();
        for timestamp_ms in 0..(HISTORY_LEN as u64 + 5) {
            push_point(&mut history, timestamp_ms, 1.0);
        }

        assert_eq!(history.len(), HISTORY_LEN);
        assert_eq!(history.front().map(|point| point.timestamp_ms), Some(5));
    }

    #[test]
    fn worktree_name_uses_the_checkout_root_from_a_subdirectory() {
        let root = std::env::temp_dir().join(format!("monitor-test-{}", std::process::id()));
        let subdir = root.join("my-worktree/src-tauri");
        std::fs::create_dir_all(&subdir).unwrap();
        // A linked worktree's `.git` is a file.
        std::fs::write(root.join("my-worktree/.git"), "gitdir: elsewhere").unwrap();

        let name = worktree_name(&subdir);
        std::fs::remove_dir_all(&root).unwrap();

        assert_eq!(name, "my-worktree");
    }

    #[test]
    fn round_percent_keeps_one_decimal() {
        assert_eq!(round_percent(23.456), 23.5);
    }
}
