import { atom } from "nanostores";
import Toastify from "toastify-js";
import { TOAST_DURATION_MS } from "../lib/constants";

export type ToastLevel = "info" | "success" | "warning" | "error";

export interface NotificationHistoryEntry {
  id: number;
  level: ToastLevel;
  message: string;
  createdAt: number;
}

const NOTIFICATION_HISTORY_LIMIT = 100;
let nextNotificationHistoryId = 1;

export const notificationHistory = atom<NotificationHistoryEntry[]>([]);

/** Appends a toast notification to the bounded in-memory notification history. */
function appendNotificationHistory(
  level: ToastLevel,
  message: string,
): NotificationHistoryEntry {
  const entry = {
    id: nextNotificationHistoryId++,
    level,
    message,
    createdAt: Date.now(),
  };

  notificationHistory.set(
    [entry, ...notificationHistory.get()].slice(0, NOTIFICATION_HISTORY_LIMIT),
  );

  return entry;
}

/** Clears all notifications from the in-memory history list. */
export function clearNotificationHistory(): void {
  notificationHistory.set([]);
}

const toastStyles: Record<
  ToastLevel,
  { iconBg: string; iconColor: string; icon: string }
> = {
  info: {
    iconBg: "bg-blue-100 dark:bg-blue-800/30",
    iconColor: "text-blue-500",
    icon: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  success: {
    iconBg: "bg-teal-100 dark:bg-teal-800/30",
    iconColor: "text-teal-500",
    icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  warning: {
    iconBg: "bg-yellow-100 dark:bg-yellow-800/30",
    iconColor: "text-yellow-500",
    icon: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  },
  error: {
    iconBg: "bg-red-100 dark:bg-red-800/30",
    iconColor: "text-red-500",
    icon: "M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z",
  },
};

/** Builds the custom Toastify DOM node for a typed toast message. */
function createToastNode(level: ToastLevel, message: string): HTMLElement {
  const style = toastStyles[level];
  const container = document.createElement("div");
  container.className =
    "max-w-xs bg-white border border-gray-200 rounded-xl shadow-lg dark:bg-neutral-800 dark:border-neutral-700";
  container.setAttribute("role", "alert");

  container.innerHTML = `
    <div class="flex p-4">
      <div class="shrink-0">
        <span class="inline-flex items-center justify-center size-8 rounded-full ${style.iconBg}">
          <svg class="shrink-0 size-4 ${style.iconColor}" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="${style.icon}" />
          </svg>
        </span>
      </div>
      <div class="ms-3 me-2 grow">
        <p class="text-sm text-gray-700 dark:text-neutral-400">${escapeHtml(message)}</p>
      </div>
      <button type="button" class="toast-close inline-flex shrink-0 justify-center items-center size-5 rounded-lg text-gray-800 opacity-50 hover:opacity-100 focus:outline-hidden focus:opacity-100 dark:text-white" aria-label="Close">
        <span class="sr-only">Close</span>
        <svg class="shrink-0 size-4" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  `;

  return container;
}

/** Escapes untrusted text before inserting it into toast HTML. */
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** Shows a toast notification and wires its close button to the Toastify instance. */
export function pushToast(
  level: ToastLevel,
  message: string,
  ttlMs = TOAST_DURATION_MS,
): void {
  appendNotificationHistory(level, message);

  const node = createToastNode(level, message);
  const toast = Toastify({
    node,
    duration: ttlMs,
    gravity: "top",
    position: "right",
    stopOnFocus: true,
    className: "!bg-transparent !shadow-none !p-0",
    offset: { x: 16, y: 16 },
  });

  const closeButton = node.querySelector(".toast-close");
  if (closeButton) {
    closeButton.addEventListener("click", () => toast.hideToast());
  }

  toast.showToast();
}
