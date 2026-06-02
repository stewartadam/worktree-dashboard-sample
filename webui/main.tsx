import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";

import "./index.css";

interface AppState {
  ok: boolean;
  pid: number;
  cwd: string;
  worktree: string;
  port: number;
  generatedAt: string | number;
}

const API_BASE = __WORKTREE_API_BASE__;

function formatGeneratedAt(value: AppState["generatedAt"]): string {
  const timestamp =
    typeof value === "number" ? value : Number.parseInt(value, 10);
  const date =
    Number.isFinite(timestamp) && String(value).trim().match(/^\d+$/)
      ? new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp)
      : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleTimeString();
}

function SampleApp() {
  const [state, setState] = createSignal<AppState | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function refresh() {
    try {
      const response = await fetch(`${API_BASE}/app-state`);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      setState((await response.json()) as AppState);
      setError(null);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : String(requestError),
      );
    }
  }

  onMount(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    onCleanup(() => window.clearInterval(timer));
  });

  return (
    <main class="min-h-screen bg-slate-950 text-slate-100">
      <section class="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-center px-6 py-10">
        <div class="mb-6">
          <p class="text-sm font-medium uppercase tracking-wide text-cyan-300">
            Worktree sample
          </p>
          <h1 class="mt-2 text-4xl font-semibold tracking-normal">
            {__WORKTREE_APP_TITLE__}
          </h1>
        </div>

        <div class="grid gap-3 rounded-md border border-slate-700 bg-slate-900 p-5 shadow-xl">
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm text-slate-400">Backend</span>
            <span
              class={`rounded-full px-2 py-1 text-xs font-semibold ${error() ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/20 text-emerald-200"}`}
            >
              {error() ? "offline" : "connected"}
            </span>
          </div>

          <Show
            when={state()}
            fallback={
              <p class="font-mono text-sm text-slate-400">
                {error() ?? "Loading..."}
              </p>
            }
          >
            {(current) => (
              <dl class="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt class="text-xs uppercase text-slate-500">Worktree</dt>
                  <dd class="mt-1 font-mono text-sm">{current().worktree}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase text-slate-500">Backend PID</dt>
                  <dd class="mt-1 font-mono text-sm">{current().pid}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase text-slate-500">Backend Port</dt>
                  <dd class="mt-1 font-mono text-sm">{current().port}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase text-slate-500">Updated</dt>
                  <dd class="mt-1 font-mono text-sm">
                    {formatGeneratedAt(current().generatedAt)}
                  </dd>
                </div>
              </dl>
            )}
          </Show>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("app");
if (!root) {
  throw new Error("Could not find #app root");
}

render(() => <SampleApp />, root);
