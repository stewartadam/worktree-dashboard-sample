import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import solidPlugin from "vite-plugin-solid";

interface TauriConfig {
  productName?: string;
  version?: string;
  bundle?: {
    copyright?: string;
    license?: string;
  };
}

/** Reads the generated Tauri config so app metadata stays in one place. */
function readTauriConfig(): TauriConfig {
  return JSON.parse(
    readFileSync(resolve(__dirname, "src-tauri/tauri.conf.json"), "utf8"),
  ) as TauriConfig;
}

/** Formats a copyright string for HTML by replacing (c) with &copy;. */
function formatCopyrightForHtml(value: string): string {
  return value.replace(/\(c\)/gi, "&copy;");
}

/** Returns true when Vite is being run by the Tauri CLI. */
function isTauri(): boolean {
  return process.env.TAURI_ENV_PLATFORM !== undefined;
}

/** Resolves the dashboard API base URL for direct webview requests. */
function resolveDashboardApiBase(env: Record<string, string>): string {
  if (env.VITE_WORKTREE_DASHBOARD_API_BASE) {
    return env.VITE_WORKTREE_DASHBOARD_API_BASE.replace(/\/+$/u, "");
  }

  const dashboardHost = env.WORKTREE_DASHBOARD_HOST || "127.0.0.1";
  const dashboardPort = env.WORKTREE_DASHBOARD_PORT || "4781";
  return `http://${dashboardHost}:${dashboardPort}/api`;
}

/** Resolves the worktree backend API base URL. */
function resolveWorktreeApiBase(env: Record<string, string>): string {
  if (env.VITE_WORKTREE_APP_API_BASE) {
    return env.VITE_WORKTREE_APP_API_BASE.replace(/\/+$/u, "");
  }

  const appHost = env.WORKTREE_APP_HOST || "127.0.0.1";
  const appPort = env.WORKTREE_APP_PORT || "3030";
  return `http://${appHost}:${appPort}/api`;
}

const tauriConfig = readTauriConfig();
const appName = tauriConfig.productName ?? "Worktree Dashboard";
const appVersion = tauriConfig.version ?? "0.1.0";
const appLicense = tauriConfig.bundle?.license ?? "MIT";
const appCopyright = formatCopyrightForHtml(
  tauriConfig.bundle?.copyright ?? "(c) 2026",
);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname), [
    "WORKTREE_APP_",
    "WORKTREE_DASHBOARD_",
    "VITE_",
  ]);
  const runtimeEnv = { ...env, ...process.env } as Record<string, string>;

  const tauri = isTauri();

  const appTitle = tauri ? appName : runtimeEnv.VITE_APP_TITLE || appName;

  const defaultVitePort = 3031;
  const vitePort =
    (tauri ? undefined : Number(env.WORKTREE_APP_PORT) + 1) || defaultVitePort;

  return {
    root: "./webui",
    // Do not use .env if running a Tauri build, it expects a fixed backend URL as configured in tauri.config.json
    envDir: tauri ? false : resolve(__dirname),
    envPrefix: ["VITE_", "TAURI_", "WORKTREE_APP_", "WORKTREE_DASHBOARD_"],
    build: {
      sourcemap: true,
    },
    define: {
      __WORKTREE_APP_NAME__: JSON.stringify(appName),
      __WORKTREE_APP_TITLE__: JSON.stringify(appTitle),
      __WORKTREE_APP_VERSION__: JSON.stringify(appVersion),
      __WORKTREE_APP_LICENSE__: JSON.stringify(appLicense),
      __WORKTREE_APP_COPYRIGHT__: JSON.stringify(appCopyright),
      __WORKTREE_DASHBOARD_API_BASE__: JSON.stringify(
        resolveDashboardApiBase(runtimeEnv),
      ),
      __WORKTREE_API_BASE__: JSON.stringify(
        resolveWorktreeApiBase(runtimeEnv),
      ),
    },
    plugins: [tailwindcss(), solidPlugin()],
    server: {
      port: vitePort,
    },
  };
});
