/**
 * The services the dashboard manages in each worktree. This is the one place to
 * add, remove or change a service: the API, the page, the MCP server and the
 * tests all read from it.
 *
 * Each worktree's `.env` sets BASE_PORT_ENV to the first port of its block, and
 * a service listens at that port plus its `portOffset`.
 *
 * A definition has these fields:
 * - `label`: name shown in the page.
 * - `command`, `args`: what to run. `args` can be a function of
 *   `{ env, port }`, to pass the worktree's port on the command line.
 * - `workdir`: relative to the worktree root; defaults to the root.
 * - `portOffset`: omit for a service with no port. It then counts as live while
 *   its process runs.
 * - `url`: true to link to the service from the page.
 * - `oneShot`: true for a job that exits when done, such as a build, which
 *   reports completed or failed rather than reachable.
 *
 * For example, to preview an mdBook on the third port of the block:
 *
 *     docs: {
 *       label: "Docs",
 *       command: "mdbook",
 *       args: ({ port }) => ["serve", "docs", "--port", String(port)],
 *       portOffset: 2,
 *       url: true,
 *     },
 *
 * Keep offsets below PORT_BLOCK_SIZE in `scripts/setup-env.mjs`.
 */

/** Windows runs npm and similar tools through a `.cmd` shim, and cargo as an `.exe`. */
function platformCommand(name, windowsSuffix) {
  return process.platform === "win32" ? `${name}${windowsSuffix}` : name;
}

export const BASE_PORT_ENV = "APP_PORT";
/** The base port when a checkout's env doesn't set one. */
export const DEFAULT_BASE_PORT = 3030;
/** Where Vite listens in the block. It serves both the `ui` service and the dashboard page. */
const VITE_PORT_OFFSET = 1;

export const SERVICE_DEFINITIONS = {
  backend: {
    label: "Backend",
    command: platformCommand("cargo", ".exe"),
    args: ["run"],
    workdir: "./src-tauri",
    portOffset: 0,
  },
  ui: {
    label: "Web UI",
    command: platformCommand("npm", ".cmd"),
    args: ["run", "dev"],
    portOffset: VITE_PORT_OFFSET,
    url: true,
  },
};

export const SERVICES = Object.keys(SERVICE_DEFINITIONS);

export const ALL_SELECTOR = "all";

/** Names that target several services. `all` always means every service. */
export const SERVICE_SELECTORS = {
  [ALL_SELECTOR]: SERVICES,
  both: ["backend", "ui"],
};

/** Every name a caller may pass as a service target. */
export const SERVICE_TARGET_NAMES = [
  ...SERVICES,
  ...Object.keys(SERVICE_SELECTORS),
];

/** Lists what clients need to know about each service, without its command. */
export const SERVICE_CATALOG = SERVICES.map((name) => {
  const definition = SERVICE_DEFINITIONS[name];
  return {
    name,
    label: definition.label,
    hasPort: definition.portOffset !== undefined,
    hasUrl: Boolean(definition.url),
    oneShot: Boolean(definition.oneShot),
  };
});

/** Reads a worktree's base port from its env, or null if missing or invalid. */
export function basePortFromEnv(env) {
  const port = Number.parseInt(env[BASE_PORT_ENV] ?? "", 10);
  return Number.isFinite(port) ? port : null;
}

/**
 * Returns the port a service listens on in a worktree with this env, or null
 * when the service has no port or the env has no valid base port.
 */
export function servicePortFromEnv(service, env) {
  const offset = SERVICE_DEFINITIONS[service]?.portOffset;
  if (offset === undefined) return null;
  const base = basePortFromEnv(env);
  return base === null ? null : base + offset;
}

/** Returns the port Vite listens on for this env, using the default base port if unset. */
export function vitePortFromEnv(env) {
  return (basePortFromEnv(env) ?? DEFAULT_BASE_PORT) + VITE_PORT_OFFSET;
}

/** Returns the arguments to spawn a service with, resolving a function of env and port. */
export function serviceArgs(service, env) {
  const { args = [] } = SERVICE_DEFINITIONS[service];
  return typeof args === "function"
    ? args({ env, port: servicePortFromEnv(service, env) })
    : args;
}

/** Expands a target name to its services, or null for an unknown name. */
export function servicesForTarget(target) {
  if (Object.hasOwn(SERVICE_SELECTORS, target)) {
    return SERVICE_SELECTORS[target];
  }
  return Object.hasOwn(SERVICE_DEFINITIONS, target) ? [target] : null;
}
