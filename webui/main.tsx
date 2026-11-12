import { createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";

import "./index.css";
import "./host-monitor.css";

interface CpuPoint {
  timestampMs: number;
  cpuPercent: number;
}

interface SystemSnapshot {
  ok: boolean;
  backend: {
    pid: number;
    worktree: string;
    port: number;
    uptimeSeconds: number;
    requestCount: number;
    memoryBytes: number;
  };
  host: {
    name: string;
    os: string;
    arch: string;
    coreCount: number;
  };
  current: {
    cpuPercent: number;
    coreCpuPercents: number[];
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    loadAverage: [number, number, number] | null;
  };
  history: CpuPoint[];
}

const API_BASE = __WORKTREE_API_BASE__;
const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 3000;
/** How many samples the chart spans. Matches the backend's history length. */
const CHART_SLOTS = 60;
const LOAD_WINDOWS = ["1 min", "5 min", "15 min"];
const GRAPH_ACCENT_STORAGE_KEY = "host-monitor-graph-accent";

function readGraphAccent(): string {
  try {
    const saved = localStorage.getItem(GRAPH_ACCENT_STORAGE_KEY);
    if (saved && /^#[0-9a-f]{6}$/i.test(saved)) return saved;
  } catch {
    // The picker still works when browser storage is unavailable.
  }
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--cp-accent")
    .trim();
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** Newest sample sits at the right edge, so the line fills in from the right. */
function chartX(index: number, count: number): number {
  return ((CHART_SLOTS - count + index) / (CHART_SLOTS - 1)) * 100;
}

function chartY(cpuPercent: number): number {
  return 100 - Math.min(Math.max(cpuPercent, 0), 100);
}

function CpuChart(props: { history: CpuPoint[] }) {
  const [hoverIndex, setHoverIndex] = createSignal<number | null>(null);

  const linePoints = () =>
    props.history
      .map(
        (point, index) =>
          `${chartX(index, props.history.length)},${chartY(point.cpuPercent)}`,
      )
      .join(" ");

  const hovered = () => {
    const index = hoverIndex();
    const point = index === null ? undefined : props.history[index];
    if (index === null || !point) return null;
    return { point, x: chartX(index, props.history.length) };
  };

  function handlePointerMove(event: PointerEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const slot = Math.round(
      ((event.clientX - bounds.left) / bounds.width) * (CHART_SLOTS - 1),
    );
    const index = slot - (CHART_SLOTS - props.history.length);
    setHoverIndex(Math.min(Math.max(index, 0), props.history.length - 1));
  }

  return (
    <div>
      <div class="flex gap-2">
        <div class="flex h-32 flex-col justify-between text-right text-xs text-slate-500">
          <span>100%</span>
          <span>0%</span>
        </div>
        <div
          class="relative h-32 flex-1 cursor-crosshair border-y border-slate-800"
          role="img"
          aria-label={`CPU usage over the last ${props.history.length} seconds`}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <svg
            class="absolute inset-0 h-full w-full overflow-visible"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              fill="none"
              class="graph-accent-line"
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
              vector-effect="non-scaling-stroke"
              points={linePoints()}
            />
          </svg>
          <Show when={hovered()}>
            {(current) => (
              <>
                <div
                  class="pointer-events-none absolute inset-y-0 w-px bg-slate-500"
                  style={{ left: `${current().x}%` }}
                />
                <div
                  class="graph-accent-fill pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-slate-900"
                  style={{
                    left: `${current().x}%`,
                    top: `${chartY(current().point.cpuPercent)}%`,
                  }}
                />
                <div
                  class="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs shadow-lg"
                  style={{
                    left: `${current().x}%`,
                    transform: `translateX(${current().x > 50 ? "calc(-100% - 8px)" : "8px"})`,
                  }}
                >
                  <span class="font-semibold">
                    {formatPercent(current().point.cpuPercent)}
                  </span>{" "}
                  <span class="text-slate-400">
                    {new Date(current().point.timestampMs).toLocaleTimeString()}
                  </span>
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
      <div class="mt-1 flex justify-between pl-10 text-xs text-slate-500">
        <span>1 min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

function MemoryMeter(props: { used: number; total: number }) {
  const percent = () =>
    props.total > 0 ? (props.used / props.total) * 100 : 0;

  return (
    <div
      class="h-2 overflow-hidden rounded-full bg-slate-800"
      role="img"
      aria-label={`${formatPercent(percent())} of memory in use`}
    >
      <div
        class="graph-accent-fill h-full rounded-full transition-[width] duration-500"
        style={{ width: `${percent()}%` }}
      />
    </div>
  );
}

function CoreBars(props: { percents: number[] }) {
  const [hoverIndex, setHoverIndex] = createSignal<number | null>(null);

  const label = () => {
    const index = hoverIndex();
    const percent = index === null ? undefined : props.percents[index];
    return index === null || percent === undefined
      ? "Hover a bar for its value"
      : `Core ${index + 1}: ${formatPercent(percent)}`;
  };

  return (
    <div>
      <div class="flex items-baseline justify-between gap-4">
        <h2 class="text-sm font-medium text-slate-300">Core usage</h2>
        <span class="text-xs text-slate-400">{label()}</span>
      </div>
      <div
        class="mt-3 flex h-16 gap-0.5"
        role="img"
        aria-label={`Usage per core: ${props.percents.map(formatPercent).join(", ")}`}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <Index each={props.percents}>
          {(percent, index) => (
            <div
              class="flex min-w-0 flex-1 items-end rounded-t hover:bg-slate-800"
              onPointerEnter={() => setHoverIndex(index)}
            >
              <div
                class="graph-accent-fill w-full rounded-t-sm transition-[height] duration-500"
                style={{ height: `${Math.max(percent(), 2)}%` }}
              />
            </div>
          )}
        </Index>
      </div>
    </div>
  );
}

function BackendFact(props: { label: string; value: string }) {
  return (
    <div class="min-w-0">
      <dt class="text-xs uppercase text-slate-500">{props.label}</dt>
      <dd class="mt-1 truncate font-mono text-sm" title={props.value}>
        {props.value}
      </dd>
    </div>
  );
}

function HostMonitor() {
  const [snapshot, setSnapshot] = createSignal<SystemSnapshot | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [graphAccent, setGraphAccent] = createSignal(readGraphAccent());
  let timer: number | undefined;
  let stopped = false;

  function changeGraphAccent(color: string) {
    setGraphAccent(color);
    try {
      localStorage.setItem(GRAPH_ACCENT_STORAGE_KEY, color);
    } catch {
      // Storage restrictions must not prevent live color updates.
    }
  }

  async function poll() {
    try {
      const response = await fetch(`${API_BASE}/system`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      setSnapshot((await response.json()) as SystemSnapshot);
      setError(null);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : String(requestError),
      );
    }
    if (!stopped) {
      timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
  }

  onMount(() => void poll());
  onCleanup(() => {
    stopped = true;
    window.clearTimeout(timer);
  });

  return (
    <main
      class="min-h-screen bg-slate-950 text-slate-100"
      style={{ "--cp-graph-accent": graphAccent() }}
    >
      <section class="mx-auto w-full max-w-4xl px-6 py-10">
        <header class="mb-6 flex items-end justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm font-medium uppercase tracking-wide text-cyan-300">
              Host monitor
            </p>
            <h1 class="mt-2 text-3xl font-semibold tracking-normal">
              {__WORKTREE_APP_TITLE__}
            </h1>
          </div>
          <span
            class={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${error() ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/20 text-emerald-200"}`}
          >
            {error() ? "offline" : "connected"}
          </span>
        </header>

        <div class="mb-4 flex justify-end">
          <label class="graph-accent-picker">
            Graph accent
            <input
              type="color"
              value={graphAccent()}
              onInput={(event) => changeGraphAccent(event.currentTarget.value)}
            />
          </label>
        </div>

        <Show when={error()}>
          <p
            class="mb-4 rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
            role="alert"
          >
            Can't reach the backend at <code>{API_BASE}</code>. Start it from
            the dashboard, or run <code>cargo run</code> in{" "}
            <code>src-tauri</code>.
          </p>
        </Show>

        <Show
          when={snapshot()}
          fallback={
            <Show when={!error()}>
              <p class="font-mono text-sm text-slate-400">Loading...</p>
            </Show>
          }
        >
          {(current) => (
            <div class={`grid gap-4 ${error() ? "opacity-60" : ""}`}>
              <section
                class="rounded-md border border-slate-700 bg-slate-900 p-5"
                aria-labelledby="backend-heading"
              >
                <h2
                  id="backend-heading"
                  class="mb-3 break-words text-sm font-medium text-slate-300"
                >
                  This backend:{" "}
                  <span class="font-mono text-slate-100">
                    {current().backend.worktree}
                  </span>
                </h2>
                <dl class="grid grid-cols-2 gap-4 sm:grid-cols-5">
                  <BackendFact
                    label="Port"
                    value={String(current().backend.port)}
                  />
                  <BackendFact
                    label="PID"
                    value={String(current().backend.pid)}
                  />
                  <BackendFact
                    label="Uptime"
                    value={formatUptime(current().backend.uptimeSeconds)}
                  />
                  <BackendFact
                    label="Requests"
                    value={current().backend.requestCount.toLocaleString()}
                  />
                  <BackendFact
                    label="Memory"
                    value={formatBytes(current().backend.memoryBytes)}
                  />
                </dl>
              </section>

              <section
                class="grid gap-6 rounded-md border border-slate-700 bg-slate-900 p-5"
                aria-labelledby="host-heading"
              >
                <div>
                  <h2
                    id="host-heading"
                    class="text-sm font-medium text-slate-300"
                  >
                    Host: {current().host.name}
                  </h2>
                  <p class="mt-1 text-xs text-slate-400">
                    {current().host.os} · {current().host.arch} ·{" "}
                    {current().host.coreCount} cores · shared by every worktree
                  </p>
                </div>

                <div>
                  <p class="mb-3 flex items-baseline gap-2">
                    <span class="text-3xl font-semibold">
                      {formatPercent(current().current.cpuPercent)}
                    </span>
                    <span class="text-sm text-slate-400">CPU</span>
                  </p>
                  <CpuChart history={current().history} />
                </div>

                <div class="grid gap-6 sm:grid-cols-2">
                  <div>
                    <div class="mb-3 flex items-baseline justify-between gap-4">
                      <h2 class="text-sm font-medium text-slate-300">Memory</h2>
                      <span class="font-mono text-sm">
                        {formatBytes(current().current.memoryUsedBytes)} /{" "}
                        {formatBytes(current().current.memoryTotalBytes)}
                      </span>
                    </div>
                    <MemoryMeter
                      used={current().current.memoryUsedBytes}
                      total={current().current.memoryTotalBytes}
                    />
                  </div>

                  <Show when={current().current.loadAverage}>
                    {(load) => (
                      <div>
                        <h2 class="mb-2 text-sm font-medium text-slate-300">
                          Load average
                        </h2>
                        <dl class="flex gap-6">
                          <Index each={load()}>
                            {(value, index) => (
                              <div>
                                <dt class="text-xs text-slate-500">
                                  {LOAD_WINDOWS[index]}
                                </dt>
                                <dd class="font-mono text-sm">
                                  {value().toFixed(2)}
                                </dd>
                              </div>
                            )}
                          </Index>
                        </dl>
                      </div>
                    )}
                  </Show>
                </div>

                <CoreBars percents={current().current.coreCpuPercents} />
              </section>
            </div>
          )}
        </Show>
      </section>
    </main>
  );
}

const root = document.getElementById("app");
if (!root) {
  throw new Error("Could not find #app root");
}

render(() => <HostMonitor />, root);
