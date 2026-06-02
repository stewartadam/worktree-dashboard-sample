import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Portal, render } from "solid-js/web";
import HeroIcon from "./components/hero-icon";
import { pushToast } from "./state/appStores";

import "./index.css";

type ServiceName = "backend" | "ui";
type ServiceTarget = ServiceName | "both" | "all";
type ServiceAction = "start" | "stop" | "recycle";
type DashboardAction = ServiceAction | "open-editor" | "open-log";

interface ManagedServiceState {
  pid: number | null;
  running: boolean;
  startedAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  logPath: string | null;
}

interface WorktreeSummary {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  envPath: string;
  envExists: boolean;
  backendPort: number | null;
  webUiPort: number | null;
  webUiUrl: string | null;
  managed: Record<ServiceName, ManagedServiceState>;
  observed: {
    backendPortOpen: boolean;
    webUiPortOpen: boolean;
    backendPid: number | null;
    webUiPid: number | null;
  };
}

interface DashboardStatePayload {
  generatedAt: string;
  dashboardPid: number;
  worktrees: WorktreeSummary[];
}

interface ActionMenuItem {
  action: ServiceAction;
  icon: string;
  title: string;
}

interface ServiceTargetGroup {
  key: string;
  options: Array<{ value: ServiceTarget; label: string }>;
}

interface StatusDotProps {
  isReachable: boolean;
  isManagedRunning: boolean;
  status: string;
  children?: JSX.Element;
}

type ActionMenuPlacement = "up" | "down";

const EMPTY_MANAGED_SERVICE_STATE: ManagedServiceState = {
  pid: null,
  running: false,
  startedAt: null,
  lastExitCode: null,
  lastExitSignal: null,
  lastError: null,
  logPath: null,
};

const EMPTY_DASHBOARD_PAYLOAD: DashboardStatePayload = {
  generatedAt: "",
  dashboardPid: 0,
  worktrees: [],
};

const API_BASE_PATH = __WORKTREE_DASHBOARD_API_BASE__;
const POLL_INTERVAL_MS = 2000;
const ACTION_MENU_OFFSET_PX = 4;
const ACTION_MENU_VIEWPORT_PADDING_PX = 8;
const ACTION_MENU_Z_INDEX = "2147483647";
const WORKTREE_SERVICE_OPTIONS: Array<{ value: ServiceTarget; label: string }> =
  [
    { value: "backend", label: "Backend" },
    { value: "ui", label: "Web UI" },
  ];

function serviceTargetGroupsForAction(): ServiceTargetGroup[] {
  return [
    {
      key: "worktree-services",
      options: WORKTREE_SERVICE_OPTIONS,
    },
  ];
}
const ACTION_MENU_ITEMS: ActionMenuItem[] = [
  {
    action: "recycle",
    icon: "arrow-path-rounded-square",
    title: "Recycle",
  },
  { action: "stop", icon: "stop", title: "Stop" },
];

function statusOrbClasses(
  isReachable: boolean,
  isManagedRunning: boolean,
): string {
  if (isReachable) {
    return "bg-emerald-500";
  }
  if (isManagedRunning) {
    return "bg-amber-500 animate-pulse";
  }
  return "bg-rose-500";
}

function serviceStatusText(
  isReachable: boolean,
  isManagedRunning: boolean,
  pid: number | null,
): string {
  if (!isReachable && isManagedRunning) {
    if (pid !== null) {
      return `managed (starting..., ${pid})`;
    }
    return "managed (starting...)";
  }

  if (isManagedRunning) {
    return pid !== null ? `managed (${pid})` : "managed";
  }

  const status = !isReachable ? "offline" : "unmanaged";

  if (pid !== null) {
    return `${status} (${pid})`;
  }

  return status;
}

function StatusDot(props: StatusDotProps) {
  return (
    <span class="group relative inline-flex items-center gap-2">
      <span
        class={`size-2.5 rounded-full ${statusOrbClasses(props.isReachable, props.isManagedRunning)}`}
      />
      {props.children}
      <span class="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] text-white shadow-lg group-hover:block dark:bg-slate-700">
        {props.status}
      </span>
    </span>
  );
}

function actionKey(
  worktreeId: string,
  action: DashboardAction,
  service: ServiceTarget,
): string {
  return `${worktreeId}:${action}:${service}`;
}

function actionLabel(action: ServiceAction): string {
  if (action === "start") return "started";
  if (action === "stop") return "stopped";
  return "recycled";
}

function serviceLabel(service: ServiceTarget): string {
  if (service === "both") return "both";
  if (service === "ui") return "web ui";
  if (service === "all") return "all services";
  return "backend";
}

function normalizeManagedServiceState(
  input: Partial<ManagedServiceState> | null | undefined,
): ManagedServiceState {
  if (!input) return { ...EMPTY_MANAGED_SERVICE_STATE };
  return {
    pid: input.pid ?? null,
    running: Boolean(input.running),
    startedAt: input.startedAt ?? null,
    lastExitCode: input.lastExitCode ?? null,
    lastExitSignal: input.lastExitSignal ?? null,
    lastError: input.lastError ?? null,
    logPath: input.logPath ?? null,
  };
}

function normalizeDashboardPayload(
  payload: DashboardStatePayload,
): DashboardStatePayload {
  return {
    ...payload,
    worktrees: (payload.worktrees ?? []).map((worktree) => {
      const managed = (worktree.managed ?? {}) as Partial<
        Record<ServiceName, Partial<ManagedServiceState>>
      >;
      const observed = (worktree.observed ?? {}) as Partial<
        WorktreeSummary["observed"]
      >;

      return {
        ...worktree,
        managed: {
          backend: normalizeManagedServiceState(managed.backend),
          ui: normalizeManagedServiceState(managed.ui),
        },
        observed: {
          backendPortOpen: Boolean(observed.backendPortOpen),
          webUiPortOpen: Boolean(observed.webUiPortOpen),
          backendPid:
            typeof observed.backendPid === "number"
              ? observed.backendPid
              : null,
          webUiPid:
            typeof observed.webUiPid === "number" ? observed.webUiPid : null,
        },
      };
    }),
  };
}

function WorktreeDashboardApp() {
  const [payload, setPayload] = createStore<DashboardStatePayload>({
    ...EMPTY_DASHBOARD_PAYLOAD,
  });
  const [hasPayload, setHasPayload] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [pendingActions, setPendingActions] = createSignal<Set<string>>(
    new Set(),
  );
  const [copiedPathFor, setCopiedPathFor] = createSignal<string | null>(null);
  const [openActionMenu, setOpenActionMenu] = createSignal<string | null>(null);
  const [actionMenuPlacement, setActionMenuPlacement] =
    createSignal<ActionMenuPlacement>("down");
  const [actionMenuStyle, setActionMenuStyle] = createSignal<JSX.CSSProperties>(
    {
      position: "fixed",
      left: "-9999px",
      top: "-9999px",
      "z-index": ACTION_MENU_Z_INDEX,
    },
  );
  const [openActionMenuAnchor, setOpenActionMenuAnchor] =
    createSignal<HTMLButtonElement | null>(null);
  let openActionMenuPanel: HTMLDivElement | undefined;

  const worktrees = createMemo(() => payload.worktrees);
  /** Worktrees with per-worktree configuration can be managed by the dashboard services. */
  const initializedWorktrees = createMemo(() =>
    worktrees().filter((worktree) => worktree.envExists),
  );
  /** Worktrees missing .env are visible for orientation but grouped after managed entries. */
  const uninitializedWorktrees = createMemo(() =>
    worktrees().filter((worktree) => !worktree.envExists),
  );
  const metadataText = createMemo(() => {
    if (!hasPayload()) {
      return "Waiting for dashboard state...";
    }
    return `Updated ${new Date(payload.generatedAt).toLocaleTimeString()} | Dashboard PID ${payload.dashboardPid} | ${payload.worktrees.length} Worktrees`;
  });

  function worktreeLabel(worktreeId: string): string {
    const current = worktrees().find((worktree) => worktree.id === worktreeId);
    if (!current) return worktreeId;
    return current.branch ?? current.name;
  }

  function actionMenuKey(worktreeId: string, action: ServiceAction): string {
    return `${worktreeId}:${action}`;
  }

  function isActionPending(worktreeId: string, action: ServiceAction): boolean {
    const prefix = `${actionMenuKey(worktreeId, action)}:`;
    for (const key of pendingActions()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  function disableActionWhilePending(action: ServiceAction): boolean {
    return action === "stop";
  }

  function isPendingOperation(key: string): boolean {
    return pendingActions().has(key);
  }

  function hasPendingOperationForWorktree(worktreeId: string): boolean {
    const prefix = `${worktreeId}:`;
    for (const key of pendingActions()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  function markPendingOperation(key: string): void {
    setPendingActions((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  function clearPendingOperation(key: string): void {
    setPendingActions((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function openActionMenuFor(
    worktreeId: string,
    action: ServiceAction,
    anchor: HTMLButtonElement,
  ): void {
    const key = actionMenuKey(worktreeId, action);
    if (openActionMenu() === key) {
      setOpenActionMenu(null);
      setOpenActionMenuAnchor(null);
      return;
    }
    setOpenActionMenuAnchor(anchor);
    setOpenActionMenu(key);
  }

  async function runActionFromMenu(
    worktreeId: string,
    action: ServiceAction,
    service: ServiceTarget,
  ): Promise<void> {
    await runAction(worktreeId, action, service);
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  function positionOpenActionMenu(): void {
    const anchor = openActionMenuAnchor();
    if (!anchor || !openActionMenuPanel) return;

    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = openActionMenuPanel.getBoundingClientRect();
    const panelWidth = panelRect.width;
    const panelHeight = panelRect.height;

    const maxLeft = Math.max(
      ACTION_MENU_VIEWPORT_PADDING_PX,
      window.innerWidth - panelWidth - ACTION_MENU_VIEWPORT_PADDING_PX,
    );
    const left = clamp(
      anchorRect.left,
      ACTION_MENU_VIEWPORT_PADDING_PX,
      maxLeft,
    );

    const availableBelow =
      window.innerHeight -
      anchorRect.bottom -
      ACTION_MENU_OFFSET_PX -
      ACTION_MENU_VIEWPORT_PADDING_PX;
    const shouldOpenUp =
      panelHeight > availableBelow &&
      anchorRect.top -
        ACTION_MENU_OFFSET_PX -
        ACTION_MENU_VIEWPORT_PADDING_PX >=
        panelHeight;

    let top = shouldOpenUp
      ? anchorRect.top - panelHeight - ACTION_MENU_OFFSET_PX
      : anchorRect.bottom + ACTION_MENU_OFFSET_PX;
    const maxTop = Math.max(
      ACTION_MENU_VIEWPORT_PADDING_PX,
      window.innerHeight - panelHeight - ACTION_MENU_VIEWPORT_PADDING_PX,
    );
    top = clamp(top, ACTION_MENU_VIEWPORT_PADDING_PX, maxTop);

    setActionMenuPlacement(shouldOpenUp ? "up" : "down");
    setActionMenuStyle({
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      "min-width": `${anchorRect.width}px`,
      "z-index": ACTION_MENU_Z_INDEX,
    });
  }

  createEffect(() => {
    const openMenuKey = openActionMenu();
    const anchor = openActionMenuAnchor();
    if (!openMenuKey || !anchor) return;

    setActionMenuStyle({
      position: "fixed",
      left: "-9999px",
      top: "-9999px",
      "z-index": ACTION_MENU_Z_INDEX,
    });
    requestAnimationFrame(() => positionOpenActionMenu());

    const handleViewportChange = () => positionOpenActionMenu();
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    onCleanup(() => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    });
  });

  createEffect(() => {
    worktrees();
    queueMicrotask(() => {
      window.HSStaticMethods?.autoInit();
    });
  });

  async function refresh(options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) {
      setLoading(true);
    }

    try {
      const response = await fetch(`${API_BASE_PATH}/worktrees`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Failed to load worktrees (${response.status})`);
      }

      const next = normalizeDashboardPayload(
        (await response.json()) as DashboardStatePayload,
      );
      setPayload("generatedAt", next.generatedAt);
      setPayload("dashboardPid", next.dashboardPid);
      setPayload(
        "worktrees",
        reconcile(next.worktrees, { key: "id", merge: true }),
      );
      setHasPayload(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.silent) {
        pushToast("error", `Failed to refresh worktree dashboard: ${message}`);
      }
      console.error("Failed to refresh worktree dashboard state:", error);
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }

  async function runAction(
    worktreeId: string,
    action: ServiceAction,
    service: ServiceTarget = "backend",
  ): Promise<void> {
    const key = actionKey(worktreeId, action, service);
    markPendingOperation(key);

    try {
      const params = new URLSearchParams({
        service,
      });
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/${action}?${params.toString()}`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      await refresh({ silent: true });
      pushToast(
        "success",
        `${actionLabel(action)} ${serviceLabel(service)} for ${worktreeLabel(worktreeId)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast(
        "error",
        `Failed to ${action} ${serviceLabel(service)} for ${worktreeLabel(worktreeId)}: ${message}`,
      );
      console.error("Failed to execute dashboard action:", {
        error,
        action,
        service,
        worktreeId,
      });
    } finally {
      clearPendingOperation(key);
    }
  }

  async function openEditor(worktreeId: string): Promise<void> {
    const key = actionKey(worktreeId, "open-editor", "both");
    markPendingOperation(key);

    try {
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/open-editor`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      pushToast("success", `Opened ${worktreeLabel(worktreeId)} in VS Code`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast(
        "error",
        `Failed to open ${worktreeLabel(worktreeId)} in VS Code: ${message}`,
      );
      console.error("Failed to open worktree in editor:", {
        error,
        worktreeId,
      });
    } finally {
      clearPendingOperation(key);
    }
  }

  async function openServiceLog(
    worktreeId: string,
    service: ServiceName,
  ): Promise<void> {
    const key = actionKey(worktreeId, "open-log", service);
    markPendingOperation(key);

    try {
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/open-log?service=${encodeURIComponent(service)}`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      pushToast(
        "success",
        `Opened ${service} log for ${worktreeLabel(worktreeId)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast(
        "error",
        `Failed to open ${service} log for ${worktreeLabel(worktreeId)}: ${message}`,
      );
      console.error("Failed to open service log:", {
        error,
        worktreeId,
        service,
      });
    } finally {
      clearPendingOperation(key);
    }
  }

  async function copyWorktreePath(worktree: WorktreeSummary): Promise<void> {
    try {
      await navigator.clipboard.writeText(worktree.path);
      setCopiedPathFor(worktree.id);
      window.setTimeout(() => {
        setCopiedPathFor((current) =>
          current === worktree.id ? null : current,
        );
      }, 1400);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Could not copy path: ${message}`);
      console.error("Failed to copy worktree path:", error);
    }
  }

  onMount(() => {
    void refresh();

    const pollTimer = window.setInterval(() => {
      void refresh({ silent: true });
    }, POLL_INTERVAL_MS);

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest("[data-action-menu]")) {
        return;
      }
      setOpenActionMenu(null);
      setOpenActionMenuAnchor(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);

    onCleanup(() => {
      window.clearInterval(pollTimer);
      document.removeEventListener("pointerdown", handlePointerDown);
    });
  });

  return (
    <div class="mx-auto max-w-[1280px] p-4 text-slate-900 md:p-6 dark:text-slate-100">
      <header class="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:flex md:items-start md:justify-between dark:border-slate-700 dark:bg-slate-900">
        <div>
          <div class="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-700 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
            <HeroIcon
              icon="command-line"
              class="size-3 text-sky-700 dark:text-sky-300"
            />
            Worktree Launcher
          </div>
          <h1 class="mt-2 text-xl font-semibold text-slate-900 md:text-2xl dark:text-slate-100">
            Sample multi-worktree dashboard
          </h1>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {metadataText()}
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
            <span class="inline-flex items-center gap-1.5">
              <span class="size-2.5 rounded-full bg-emerald-500" />
              Online
            </span>
            <span class="inline-flex items-center gap-1.5">
              <span class="size-2.5 rounded-full bg-rose-500" />
              Offline
            </span>
          </div>
        </div>
        <div class="mt-3 flex items-center gap-2 md:mt-0">
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-slate-700"
            onClick={() => void refresh()}
            disabled={loading()}
          >
            <HeroIcon icon="arrow-path" class="size-4 text-slate-500" />
            Refresh
          </button>
          <a
            href="/"
            class="inline-flex items-center gap-2 rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:border-slate-500 dark:bg-slate-700 dark:hover:bg-slate-600"
          >
            <HeroIcon
              icon="arrow-right-on-rectangle"
              class="size-4 text-white"
            />
            Sample App
          </a>
        </div>
      </header>

      <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
            <thead class="bg-slate-50 dark:bg-slate-800/70">
              <tr>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
                  Worktree
                </th>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
                  Backend
                </th>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
                  Web UI
                </th>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-900">
              <For each={initializedWorktrees()}>
                {(worktree) => (
                  <tr class="align-top">
                    <td class="px-4 py-3">
                      <div class="flex items-start gap-2">
                        <div>
                          <div class="flex items-center gap-2">
                            <strong class="text-sm text-slate-900 dark:text-slate-100">
                              {worktree.branch ?? "(detached)"}
                            </strong>
                            <Show when={worktree.isMain}>
                              <span class="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                                main
                              </span>
                            </Show>
                            <div class="group relative inline-flex">
                              <button
                                type="button"
                                onClick={() => void copyWorktreePath(worktree)}
                                class={`inline-flex items-center rounded-md border px-1.5 py-1 ${copiedPathFor() === worktree.id ? "border-emerald-300 text-emerald-700 dark:border-emerald-500 dark:text-emerald-300" : "border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"}`}
                                title="Copy worktree path"
                                aria-label="Copy worktree path"
                              >
                                <HeroIcon icon="folder-open" class="size-3.5" />
                              </button>
                              <span class="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-[42rem] rounded-md bg-slate-900 px-2 py-1 font-mono text-xs text-white shadow-lg group-hover:block">
                                {worktree.path}
                              </span>
                            </div>
                          </div>
                          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {worktree.envExists
                              ? `WORKTREE_APP_PORT=${worktree.backendPort ?? "invalid"}`
                              : ".env missing"}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td class="px-4 py-3">
                      <div class="inline-flex items-center gap-2">
                        <StatusDot
                          isReachable={worktree.observed.backendPortOpen}
                          isManagedRunning={worktree.managed.backend.running}
                          status={serviceStatusText(
                            worktree.observed.backendPortOpen,
                            worktree.managed.backend.running,
                            worktree.managed.backend.pid ?? worktree.observed.backendPid,
                          )}
                        >
                          <p class="font-mono text-xs text-slate-600 dark:text-slate-300">
                            {worktree.backendPort ?? "n/a"}
                          </p>
                        </StatusDot>
                        <button
                          type="button"
                          class="inline-flex items-center justify-center rounded-md border border-slate-300 p-1 text-slate-600 hover:border-slate-400 hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                          title={
                            worktree.managed.backend.logPath
                              ? `Open backend log: ${worktree.managed.backend.logPath}`
                              : "No backend log file yet"
                          }
                          aria-label="Open backend log file"
                          disabled={
                            !worktree.managed.backend.logPath ||
                            isPendingOperation(
                              actionKey(worktree.id, "open-log", "backend"),
                            )
                          }
                          onClick={() => void openServiceLog(worktree.id, "backend")}
                        >
                          <HeroIcon icon="document-text" class="size-3.5" />
                        </button>
                      </div>
                    </td>
                    <td class="px-4 py-3">
                      <div class="inline-flex items-center gap-2">
                        <StatusDot
                          isReachable={worktree.observed.webUiPortOpen}
                          isManagedRunning={worktree.managed.ui.running}
                          status={serviceStatusText(
                            worktree.observed.webUiPortOpen,
                            worktree.managed.ui.running,
                            worktree.managed.ui.pid ??
                              worktree.observed.webUiPid,
                          )}
                        >
                          <p class="font-mono text-xs text-slate-600 dark:text-slate-300">
                            {worktree.webUiPort ?? "n/a"}
                          </p>
                        </StatusDot>
                      </div>
                      <Show when={worktree.webUiUrl}>
                        {(url) => (
                          <a
                            href={url()}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="ml-2 inline-flex items-center p-1 text-sky-700 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
                          >
                            <HeroIcon
                              icon="arrow-top-right-on-square"
                              class="size-3 text-sky-700 dark:text-sky-300"
                            />
                          </a>
                        )}
                      </Show>
                    </td>
                    <td class="px-4 py-3">
                      <div class="flex w-full items-center gap-2">
                        <div class="inline-flex rounded-md border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800">
                          <For each={ACTION_MENU_ITEMS}>
                            {(item) => (
                              <div class="relative" data-action-menu>
                                <button
                                  type="button"
                                  class="inline-flex items-center justify-center gap-1 border-r border-slate-300 px-2 py-1.5 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                                  title={`${item.title}...`}
                                  aria-label={`${item.title}...`}
                                  disabled={
                                    disableActionWhilePending(item.action) &&
                                    isActionPending(worktree.id, item.action)
                                  }
                                  onClick={(event) =>
                                    openActionMenuFor(
                                      worktree.id,
                                      item.action,
                                      event.currentTarget,
                                    )
                                  }
                                >
                                  <HeroIcon icon={item.icon} class="size-4" />
                                  <HeroIcon
                                    icon="chevron-down"
                                    class="size-3 text-slate-500 dark:text-slate-300"
                                  />
                                </button>
                                <Show
                                  when={
                                    openActionMenu() ===
                                    actionMenuKey(worktree.id, item.action)
                                  }
                                >
                                  <Portal>
                                    <div
                                      ref={openActionMenuPanel}
                                      data-action-menu
                                      style={actionMenuStyle()}
                                      class={`rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-600 dark:bg-slate-800 ${actionMenuPlacement() === "up" ? "origin-bottom-left" : "origin-top-left"}`}
                                    >
                                      <For
                                        each={serviceTargetGroupsForAction()}
                                      >
                                        {(group, groupIndex) => (
                                          <div>
                                            <Show when={groupIndex() > 0}>
                                              <div class="my-1 border-t border-slate-200 dark:border-slate-600" />
                                            </Show>
                                            <div class="px-1">
                                              <For each={group.options}>
                                                {(target) => (
                                                  <button
                                                    type="button"
                                                    class="block w-full whitespace-nowrap rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-700"
                                                    disabled={
                                                      disableActionWhilePending(
                                                        item.action,
                                                      ) &&
                                                      isActionPending(
                                                        worktree.id,
                                                        item.action,
                                                      )
                                                    }
                                                    onClick={() =>
                                                      void runActionFromMenu(
                                                        worktree.id,
                                                        item.action,
                                                        target.value,
                                                      )
                                                    }
                                                  >
                                                    {target.label}
                                                  </button>
                                                )}
                                              </For>
                                            </div>
                                          </div>
                                        )}
                                      </For>
                                    </div>
                                  </Portal>
                                </Show>
                              </div>
                            )}
                          </For>
                          <button
                            type="button"
                            class="inline-flex items-center justify-center px-2.5 py-1.5 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-700"
                            title="Open in VS Code"
                            aria-label="Open in VS Code"
                            disabled={isPendingOperation(
                              actionKey(worktree.id, "open-editor", "both"),
                            )}
                            onClick={() => void openEditor(worktree.id)}
                          >
                            <HeroIcon icon="command-line" class="size-4" />
                          </button>
                        </div>
                        <div class="ml-auto flex h-6 w-6 items-center justify-center">
                          <Show
                            when={hasPendingOperationForWorktree(worktree.id)}
                          >
                            <HeroIcon
                              icon="arrow-path"
                              class="size-4 animate-spin text-slate-500 dark:text-slate-300"
                            />
                          </Show>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
              <Show when={uninitializedWorktrees().length > 0}>
                <tr>
                  <td
                    colSpan={4}
                    class="bg-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-300"
                  >
                    Uninitialized worktrees
                  </td>
                </tr>
              </Show>
              <For each={uninitializedWorktrees()}>
                {(worktree) => (
                  <tr class="align-top bg-slate-50/70 dark:bg-slate-800/30">
                    <td class="px-4 py-3">
                      <div class="flex items-start gap-2">
                        <div>
                          <div class="flex items-center gap-2">
                            <strong class="text-sm text-slate-900 dark:text-slate-100">
                              {worktree.branch ?? "(detached)"}
                            </strong>
                            <div class="group relative inline-flex">
                              <button
                                type="button"
                                onClick={() => void copyWorktreePath(worktree)}
                                class={`inline-flex items-center rounded-md border px-1.5 py-1 ${copiedPathFor() === worktree.id ? "border-emerald-300 text-emerald-700 dark:border-emerald-500 dark:text-emerald-300" : "border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"}`}
                                title="Copy worktree path"
                                aria-label="Copy worktree path"
                              >
                                <HeroIcon icon="folder-open" class="size-3.5" />
                              </button>
                              <span class="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-[42rem] rounded-md bg-slate-900 px-2 py-1 font-mono text-xs text-white shadow-lg group-hover:block">
                                {worktree.path}
                              </span>
                            </div>
                          </div>
                          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            .env missing
                          </p>
                        </div>
                      </div>
                    </td>
                    <td class="px-4 py-3">
                      <p class="font-mono text-xs text-slate-500 dark:text-slate-400">
                        n/a
                      </p>
                    </td>
                    <td class="px-4 py-3">
                      <p class="font-mono text-xs text-slate-500 dark:text-slate-400">
                        n/a
                      </p>
                    </td>
                    <td class="px-4 py-3">
                      <div class="flex w-full items-center gap-2">
                        <p class="mr-auto text-xs text-slate-500 dark:text-slate-400">
                          Unavailable until .env exists
                        </p>
                        <div class="inline-flex rounded-md border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800">
                          <button
                            type="button"
                            class="inline-flex items-center justify-center px-2.5 py-1.5 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-700"
                            title="Open in VS Code"
                            aria-label="Open in VS Code"
                            disabled={isPendingOperation(
                              actionKey(worktree.id, "open-editor", "both"),
                            )}
                            onClick={() => void openEditor(worktree.id)}
                          >
                            <HeroIcon icon="command-line" class="size-4" />
                          </button>
                        </div>
                        <div class="ml-auto flex h-6 w-6 items-center justify-center">
                          <Show
                            when={hasPendingOperationForWorktree(worktree.id)}
                          >
                            <HeroIcon
                              icon="arrow-path"
                              class="size-4 animate-spin text-slate-500 dark:text-slate-300"
                            />
                          </Show>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>

        <Show when={loading() && worktrees().length === 0}>
          <div class="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
            Loading worktrees...
          </div>
        </Show>
      </section>

      <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Only processes started by this dashboard instance are marked as managed.
      </p>
    </div>
  );
}

async function bootstrap(): Promise<void> {
  try {
    await import("preline");
  } catch (error) {
    console.warn("Preline failed to load for worktree dashboard UI:", error);
  }

  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Could not find #app root");
  }

  render(() => <WorktreeDashboardApp />, root);
}

void bootstrap();
