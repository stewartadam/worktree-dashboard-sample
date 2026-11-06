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
import { writeClipboardText } from "./lib/clipboard";
import { pushToast } from "./state/appStores";

import "./index.css";

/** A service name from the API's catalog, or a group such as `all`. */
type ServiceTarget = string;
type ServiceAction = "start" | "stop" | "recycle";
type DashboardAction = ServiceAction | "open-editor" | "open-log" | "remove";

interface WorktreeServiceState {
  pid: number | null;
  running: boolean;
  startedAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  logPath: string | null;
  port: number | null;
  url: string | null;
  portOpen: boolean;
  listenerPid: number | null;
  reachable: boolean;
}

interface ServiceInfo {
  name: string;
  label: string;
  hasPort: boolean;
  hasUrl: boolean;
  oneShot: boolean;
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
  canRemove: boolean;
  basePort: number | null;
  services: Record<string, WorktreeServiceState | undefined>;
}

interface DashboardStatePayload {
  generatedAt: string;
  dashboardPid: number;
  basePortEnv: string;
  services: ServiceInfo[];
  worktrees: WorktreeSummary[];
}

interface CreateWorktreeResponse {
  ok: boolean;
  action?: "created" | "existing";
  message: string;
  path?: string;
}

interface RemoveWorktreeResponse {
  ok: boolean;
  reason?: "local-changes" | "unmerged" | "failed";
  message: string;
  details: string[];
  total: number;
}

/** A delete waiting for the user to confirm it. */
interface DeleteRequest {
  worktreeId: string;
  label: string;
  path: string;
  force: boolean;
}

interface ActionMenuItem {
  action: ServiceAction;
  icon: string;
  title: string;
}

interface StatusDotProps {
  isReachable: boolean;
  isManagedRunning: boolean;
  status: string;
  children?: JSX.Element;
}

type ActionMenuPlacement = "up" | "down";

const EMPTY_DASHBOARD_PAYLOAD: DashboardStatePayload = {
  generatedAt: "",
  dashboardPid: 0,
  basePortEnv: "",
  services: [],
  worktrees: [],
};

const API_BASE_PATH = __WORKTREE_DASHBOARD_API_BASE__;
/** Pause before reopening an event stream the browser gave up on. */
const EVENTS_REOPEN_DELAY_MS = 2000;
const MORE_ACTIONS_MENU = "more";
const REFUSAL_DETAILS_SHOWN = 3;
const REFUSAL_TOAST_MS = 10_000;
const ACTION_MENU_OFFSET_PX = 4;
const ACTION_MENU_VIEWPORT_PADDING_PX = 8;
const ACTION_MENU_Z_INDEX = "2147483647";
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
  oneShot: boolean,
): string {
  if (oneShot) {
    if (isManagedRunning) return pid !== null ? `running (${pid})` : "running";
    return isReachable ? "completed" : "not completed";
  }

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

/**
 * Explains why a worktree was kept and how to remove it anyway: uncommitted
 * files are named, and an unmerged branch reports its commit count and the
 * reason `wt done` gave.
 */
function removalRefusalMessage(
  label: string,
  response: RemoveWorktreeResponse,
): string {
  const forceHint = "Hold Shift and choose Force delete to remove it anyway.";
  const { total } = response;
  if (response.reason === "local-changes") {
    const files = response.details.slice(0, REFUSAL_DETAILS_SHOWN);
    const more = total > files.length ? ", …" : "";
    return `${label} has ${response.message} (${files.join(", ")}${more}). ${forceHint}`;
  }
  const unmerged =
    total > 0
      ? `has ${total} unmerged ${total === 1 ? "commit" : "commits"}`
      : "isn't merged";
  return `${label} ${unmerged} (${response.message}). ${forceHint}`;
}

/** Splits a search query into lowercase words, all of which must match. */
function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
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

  const [searchQuery, setSearchQuery] = createSignal("");
  const [creatingBranch, setCreatingBranch] = createSignal<string | null>(null);
  const [shiftHeld, setShiftHeld] = createSignal(false);
  const [deleteRequest, setDeleteRequest] = createSignal<DeleteRequest | null>(
    null,
  );

  const worktrees = createMemo(() => payload.worktrees);
  /** Worktrees whose branch name or path contains every word typed in the search box. */
  const visibleWorktrees = createMemo(() => {
    const terms = searchTerms(searchQuery());
    return worktrees().filter((worktree) => {
      const haystack =
        `${worktree.branch ?? ""} ${worktree.path}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  });
  /**
   * The branch the create button offers: the trimmed search text, unless a worktree
   * already has exactly that branch or the text can't be a branch name.
   */
  const branchToCreate = createMemo(() => {
    const branch = searchQuery().trim();
    if (!branch || /\s/u.test(branch)) return null;
    return worktrees().some((worktree) => worktree.branch === branch)
      ? null
      : branch;
  });
  const columnCount = createMemo(() => payload.services.length + 2);
  /** Worktrees with per-worktree configuration can be managed by the dashboard services. */
  const initializedWorktrees = createMemo(() =>
    visibleWorktrees().filter((worktree) => worktree.envExists),
  );
  /** Worktrees missing .env are visible for orientation but grouped after managed entries. */
  const uninitializedWorktrees = createMemo(() =>
    visibleWorktrees().filter((worktree) => !worktree.envExists),
  );
  const metadataText = createMemo(() => {
    if (!hasPayload()) {
      return "Waiting for dashboard state...";
    }
    const total = payload.worktrees.length;
    const shown = visibleWorktrees().length;
    const count = shown === total ? `${total}` : `${shown} of ${total}`;
    return `Updated ${new Date(payload.generatedAt).toLocaleTimeString()} | API PID ${payload.dashboardPid} | ${count} Worktrees`;
  });

  function serviceLabel(service: ServiceTarget): string {
    if (service === "all") return "all services";
    const info = payload.services.find((entry) => entry.name === service);
    return info ? info.label.toLowerCase() : service;
  }

  function worktreeLabel(worktreeId: string): string {
    const current = worktrees().find((worktree) => worktree.id === worktreeId);
    if (!current) return worktreeId;
    return current.branch ?? current.name;
  }

  function actionMenuKey(worktreeId: string, action: string): string {
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
    action: string,
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

  /**
   * Replaces the shown state with a snapshot from the API or its event stream.
   * Snapshots older than the one shown are dropped, so a slow GET can't overwrite a
   * newer pushed state (ISO timestamps compare in time order as strings).
   */
  function applyPayload(next: DashboardStatePayload): void {
    if (hasPayload() && next.generatedAt < payload.generatedAt) return;
    setPayload("generatedAt", next.generatedAt);
    setPayload("dashboardPid", next.dashboardPid);
    setPayload("basePortEnv", next.basePortEnv);
    setPayload(
      "services",
      reconcile(next.services, { key: "name", merge: true }),
    );
    setPayload(
      "worktrees",
      reconcile(next.worktrees, { key: "id", merge: true }),
    );
    setHasPayload(true);
  }

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

      applyPayload((await response.json()) as DashboardStatePayload);
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
    const key = actionKey(worktreeId, "open-editor", "worktree");
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

  /**
   * Removes a worktree and, when merged, its branch. The dashboard refuses a
   * worktree with local changes or an unmerged branch and the toast says which;
   * `force` removes it anyway and deletes the branch.
   */
  async function deleteWorktree(
    worktreeId: string,
    force: boolean,
  ): Promise<void> {
    const key = actionKey(worktreeId, "remove", "worktree");
    const label = worktreeLabel(worktreeId);
    markPendingOperation(key);

    try {
      const response = await fetch(
        `${API_BASE_PATH}/worktrees/${encodeURIComponent(worktreeId)}/remove${force ? "?force=1" : ""}`,
        { method: "POST" },
      );

      if (response.status === 409) {
        const refusal = (await response.json()) as RemoveWorktreeResponse;
        if (refusal.reason !== "failed") {
          pushToast(
            "warning",
            removalRefusalMessage(label, refusal),
            REFUSAL_TOAST_MS,
          );
          return;
        }
        throw new Error(refusal.message);
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }

      pushToast("success", `Deleted ${label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Failed to delete ${label}: ${message}`);
      console.error("Failed to delete worktree:", { error, worktreeId, force });
    } finally {
      clearPendingOperation(key);
      // A failed removal may still have deleted the worktree.
      await refresh({ silent: true });
    }
  }

  /**
   * Creates a worktree for the branch typed in the search box through the dashboard
   * API, which runs Worktrunk with the repository's hooks. Existing branches (local or
   * on origin) are checked out; other names become new branches from origin's default
   * branch. The search text stays, so the new worktree is what the table then shows.
   */
  async function createWorktreeForBranch(): Promise<void> {
    const branch = branchToCreate();
    if (!branch || creatingBranch()) return;
    setCreatingBranch(branch);

    try {
      const response = await fetch(
        `${API_BASE_PATH}/worktrees?branch=${encodeURIComponent(branch)}`,
        { method: "POST" },
      );
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const body = await response.text();
        throw new Error(body || `Request failed (${response.status})`);
      }
      const result = (await response.json()) as CreateWorktreeResponse;
      if (!result.ok) {
        throw new Error(result.message);
      }
      pushToast(
        result.action === "existing" ? "info" : "success",
        result.path ? `${result.message} at ${result.path}` : result.message,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Failed to create ${branch}: ${message}`);
      console.error("Failed to create worktree:", { error, branch });
    } finally {
      setCreatingBranch(null);
      await refresh({ silent: true });
    }
  }

  async function openServiceLog(
    worktreeId: string,
    service: string,
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
      await writeClipboardText(worktree.path);
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

  /**
   * Collects the less frequent per-worktree actions behind a "..." button.
   * Delete turns into Force delete while Shift is held.
   */
  function WorktreeMoreMenu(props: { worktree: WorktreeSummary }) {
    const pending = (action: DashboardAction) =>
      isPendingOperation(actionKey(props.worktree.id, action, "worktree"));
    const closeMenu = () => {
      setOpenActionMenu(null);
      setOpenActionMenuAnchor(null);
    };
    return (
      <div class="relative" data-action-menu>
        <button
          type="button"
          class="inline-flex items-center justify-center px-2.5 py-1.5 text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-700"
          title="More actions"
          aria-label="More actions"
          onClick={(event) =>
            openActionMenuFor(
              props.worktree.id,
              MORE_ACTIONS_MENU,
              event.currentTarget,
            )
          }
        >
          <HeroIcon icon="ellipsis-horizontal" class="size-4" />
        </button>
        <Show
          when={
            openActionMenu() ===
            actionMenuKey(props.worktree.id, MORE_ACTIONS_MENU)
          }
        >
          <Portal>
            <div
              ref={openActionMenuPanel}
              data-action-menu
              style={actionMenuStyle()}
              class="rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-700"
                disabled={pending("open-editor")}
                onClick={() => {
                  closeMenu();
                  void openEditor(props.worktree.id);
                }}
              >
                <HeroIcon icon="command-line" class="size-3.5" />
                Open in VS Code
              </button>
              <div class="my-1 border-t border-slate-200 dark:border-slate-600" />
              <button
                type="button"
                class="flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-left text-xs text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-rose-300 dark:hover:bg-rose-900/30"
                title={
                  !props.worktree.canRemove
                    ? "The primary worktree and the checkout running the dashboard can't be deleted"
                    : shiftHeld()
                      ? "Discards local changes and unmerged commits"
                      : "Hold Shift to force"
                }
                disabled={!props.worktree.canRemove || pending("remove")}
                onClick={(event) => {
                  closeMenu();
                  setDeleteRequest({
                    worktreeId: props.worktree.id,
                    label: props.worktree.branch ?? props.worktree.name,
                    path: props.worktree.path,
                    force: event.shiftKey,
                  });
                }}
              >
                <HeroIcon icon="trash" class="size-3.5" />
                {shiftHeld() ? "Force delete" : "Delete"}
              </button>
            </div>
          </Portal>
        </Show>
      </div>
    );
  }

  /**
   * Asks before deleting. Force is fixed when the menu item is chosen, so releasing
   * Shift can't change what the dialog says. Cancel takes focus, so pressing Enter by
   * accident keeps the worktree.
   */
  function ConfirmDeleteDialog(props: { request: DeleteRequest }) {
    const titleId = "confirm-delete-title";
    const descriptionId = "confirm-delete-description";
    const cancel = () => setDeleteRequest(null);
    const confirm = () => {
      // Read these first: closing the dialog makes `props.request` a stale read.
      const { worktreeId, force } = props.request;
      setDeleteRequest(null);
      void deleteWorktree(worktreeId, force);
    };
    return (
      <Portal>
        <div
          class="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-4"
          style={{ "z-index": ACTION_MENU_Z_INDEX }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) cancel();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancel();
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            class="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <h2
              id={titleId}
              class="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              {props.request.force ? "Force delete" : "Delete"}{" "}
              {props.request.label}?
            </h2>
            <p
              id={descriptionId}
              class="mt-2 text-sm text-slate-600 dark:text-slate-300"
            >
              {props.request.force
                ? "This permanently discards uncommitted changes and unmerged commits, and deletes the worktree and its branch."
                : "This removes the worktree and, once merged, its branch. A worktree with uncommitted changes or unmerged commits is kept."}
            </p>
            <p class="mt-2 break-all font-mono text-xs text-slate-500 dark:text-slate-400">
              {props.request.path}
            </p>
            <div class="mt-4 flex justify-end gap-2">
              <button
                type="button"
                ref={(element) => queueMicrotask(() => element.focus())}
                class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                onClick={cancel}
              >
                Cancel
              </button>
              <button
                type="button"
                class="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
                onClick={confirm}
              >
                {props.request.force ? "Force delete" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    );
  }

  function ServiceCell(props: {
    worktree: WorktreeSummary;
    info: ServiceInfo;
  }) {
    const state = () => props.worktree.services[props.info.name];
    return (
      <td class="px-4 py-3">
        <div class="inline-flex items-center gap-2">
          <StatusDot
            isReachable={Boolean(state()?.reachable)}
            isManagedRunning={Boolean(state()?.running)}
            status={serviceStatusText(
              Boolean(state()?.reachable),
              Boolean(state()?.running),
              state()?.pid ?? state()?.listenerPid ?? null,
              props.info.oneShot,
            )}
          >
            <Show when={props.info.hasPort}>
              <p class="font-mono text-xs text-slate-600 dark:text-slate-300">
                {state()?.port ?? "n/a"}
              </p>
            </Show>
          </StatusDot>
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-md border border-slate-300 p-1 text-slate-600 hover:border-slate-400 hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title={
              state()?.logPath
                ? `Open ${props.info.label} log: ${state()?.logPath}`
                : `No ${props.info.label} log file yet`
            }
            aria-label={`Open ${props.info.label} log file`}
            disabled={
              !state()?.logPath ||
              isPendingOperation(
                actionKey(props.worktree.id, "open-log", props.info.name),
              )
            }
            onClick={() =>
              void openServiceLog(props.worktree.id, props.info.name)
            }
          >
            <HeroIcon icon="document-text" class="size-3.5" />
          </button>
          <Show when={state()?.url}>
            {(url) => (
              <a
                href={url()}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${props.info.label}`}
                aria-label={`Open ${props.info.label}`}
                class="inline-flex items-center p-1 text-sky-700 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
              >
                <HeroIcon
                  icon="arrow-top-right-on-square"
                  class="size-3 text-sky-700 dark:text-sky-300"
                />
              </a>
            )}
          </Show>
        </div>
      </td>
    );
  }

  onMount(() => {
    void refresh();

    let events: EventSource | null = null;
    let reopenTimer: number | undefined;
    /**
     * Subscribes to the API's snapshot stream, which pushes the state whenever it
     * changes. EventSource retries a dropped connection itself, but gives up for good
     * on an error response, which the Vite proxy sends while the API is down; the
     * stream is then reopened after a pause.
     */
    const openEvents = () => {
      if (events) return;
      const source = new EventSource(`${API_BASE_PATH}/events`);
      events = source;
      source.addEventListener("snapshot", (event) => {
        try {
          applyPayload(JSON.parse(event.data) as DashboardStatePayload);
        } catch (error) {
          console.error("Ignoring malformed dashboard snapshot event:", error);
        }
      });
      source.addEventListener("error", () => {
        if (source.readyState !== EventSource.CLOSED) return;
        closeEvents();
        reopenTimer = window.setTimeout(openEvents, EVENTS_REOPEN_DELAY_MS);
      });
    };
    /** Closes the stream so the API stops checking for changes nobody is watching. */
    const closeEvents = () => {
      window.clearTimeout(reopenTimer);
      events?.close();
      events = null;
    };
    /** Follows the page's visibility: a hidden tab gets no updates, a shown one catches up. */
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        closeEvents();
      } else {
        openEvents();
      }
    };
    if (document.visibilityState !== "hidden") openEvents();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    /** Mirrors the Shift key so the menu can relabel Delete as Force delete. */
    const handleModifierChange = (event: KeyboardEvent) =>
      setShiftHeld(event.shiftKey);
    /** Clears Shift when the window loses focus and its keyup would be missed. */
    const handleBlur = () => setShiftHeld(false);
    window.addEventListener("keydown", handleModifierChange);
    window.addEventListener("keyup", handleModifierChange);
    window.addEventListener("blur", handleBlur);

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
      closeEvents();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleModifierChange);
      window.removeEventListener("keyup", handleModifierChange);
      window.removeEventListener("blur", handleBlur);
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
          <p class="mt-1 flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
            <span>{metadataText()}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center rounded p-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              title="Refresh"
              aria-label="Refresh"
              onClick={() => void refresh()}
              disabled={loading()}
            >
              <HeroIcon
                icon="arrow-path"
                class={`size-3.5 ${loading() ? "animate-spin" : ""}`}
              />
            </button>
          </p>
        </div>
        <input
          type="search"
          aria-label="Search worktrees"
          placeholder="Search branch or path"
          class="mt-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none md:mt-0 md:w-80 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          value={searchQuery()}
          onInput={(event) => {
            // A filtered-out row would leave its open menu anchored to nothing.
            setOpenActionMenu(null);
            setOpenActionMenuAnchor(null);
            setSearchQuery(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            // Shift+Enter creates a worktree for the typed branch.
            if (event.key !== "Enter" || !event.shiftKey) return;
            event.preventDefault();
            void createWorktreeForBranch();
          }}
        />
      </header>

      <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
            <thead class="bg-slate-50 dark:bg-slate-800/70">
              <tr>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
                  Worktree
                </th>
                <For each={payload.services}>
                  {(info) => (
                    <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
                      {info.label}
                    </th>
                  )}
                </For>
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
                              ? `${payload.basePortEnv}=${worktree.basePort ?? "invalid"}`
                              : ".env missing"}
                          </p>
                        </div>
                      </div>
                    </td>
                    <For each={payload.services}>
                      {(info) => (
                        <ServiceCell worktree={worktree} info={info} />
                      )}
                    </For>
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
                                      <div class="px-1">
                                        <For each={payload.services}>
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
                                                  target.name,
                                                )
                                              }
                                            >
                                              {target.label}
                                            </button>
                                          )}
                                        </For>
                                      </div>
                                    </div>
                                  </Portal>
                                </Show>
                              </div>
                            )}
                          </For>
                          <WorktreeMoreMenu worktree={worktree} />
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
                    colSpan={columnCount()}
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
                    <For each={payload.services}>
                      {() => (
                        <td class="px-4 py-3">
                          <p class="font-mono text-xs text-slate-500 dark:text-slate-400">
                            n/a
                          </p>
                        </td>
                      )}
                    </For>
                    <td class="px-4 py-3">
                      <div class="flex w-full items-center gap-2">
                        <p class="mr-auto text-xs text-slate-500 dark:text-slate-400">
                          Unavailable until .env exists
                        </p>
                        <div class="inline-flex rounded-md border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800">
                          <WorktreeMoreMenu worktree={worktree} />
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

        <Show
          when={
            hasPayload() &&
            searchQuery().trim() &&
            visibleWorktrees().length === 0
          }
        >
          <div class="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
            No worktrees match "{searchQuery().trim()}".
          </div>
        </Show>
        <Show when={hasPayload() && branchToCreate()}>
          {(branch) => (
            <div class="flex flex-col items-center gap-1.5 border-t border-slate-200 px-4 py-4 dark:border-slate-700">
              <button
                type="button"
                class="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-slate-700"
                disabled={creatingBranch() !== null}
                onClick={() => void createWorktreeForBranch()}
              >
                <HeroIcon
                  icon={creatingBranch() ? "arrow-path" : "plus"}
                  class={`size-4 ${creatingBranch() ? "animate-spin" : ""}`}
                />
                {creatingBranch() ? "Creating worktree" : "Create worktree"}
              </button>
              <span class="text-xs text-slate-500 dark:text-slate-400">
                Shift+Enter in the search box creates{" "}
                <span class="font-mono text-slate-700 dark:text-slate-200">
                  {branch()}
                </span>
              </span>
            </div>
          )}
        </Show>
        <Show when={loading() && worktrees().length === 0}>
          <div class="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
            Loading worktrees...
          </div>
        </Show>
      </section>

      <Show when={deleteRequest()}>
        {(request) => <ConfirmDeleteDialog request={request()} />}
      </Show>

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
