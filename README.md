# Worktree Dashboard

This sample contains the a sample worktree dashboard that permits easily inspecting and launching isolated backend + front-end dev servers for your app across different worktrees.

<img width="786" height="469" alt="image" src="https://github.com/user-attachments/assets/235bd39a-5c55-4e9b-85f3-e986fcf811c6" />

[`worktrunk`](https://worktrunk.dev/) hooks are used to automatically prepare new worktrees and assign each worktree unique ports to listen on.
Port detection is also available to display the PID of externally-launched backend instances that are currently bound to the port(s) assigned to the worktree.

The repo currently has three runtime pieces:

- Sample backend: the Rust binary in `src-tauri`, run with `cargo run` from
  `src-tauri` when it is not launched by the Tauri CLI.
- Sample Web UI: the Solid app at `webui/index.html`, served by Vite with
  `npm run dev`.
- Worktree dashboard: a Node API at `worktree-dashboard/worktree-dashboard.mjs`
  plus the Solid dashboard page at `webui/worktree-dashboard.html`.

## Scripts

Current npm scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start Vite and open `/worktree-dashboard.html`. |
| `npm run build` | Build the Vite web UI into `webui/dist`. |
| `npm run serve` | Preview the built Vite output. |
| `npm run tauri` | Run the Tauri CLI. Pass commands after `--`. |
| `npm run worktree:dashboard` | Start the dashboard API with Node watch mode. |
| `npm run worktree:mcp` | Start the dashboard MCP server. |
| `npm run worktree:stop-services` | Ask the dashboard API to stop services for `WORKTREE_TARGET`. |
| `npm run setup-env` | Generate the current worktree's `.env`. |
| `npm run test:webui-playwright` | Run the Playwright wrapper. See validation notes below. |
| `npm run lint` | Run Biome checks. |
| `npm run typecheck` | Run TypeScript project references with no emit. |

## Setup

Install dependencies:

```sh
npm install
```

Create or refresh the current worktree's `.env`:

```sh
npm run setup-env
```

`setup-env` writes:

```text
WORKTREE_APP_PORT=<random 3000-3999 port, or supplied value>
VITE_APP_TITLE=Sample Worktree App (<branch>)
PLAYWRIGHT_BROWSERS_PATH=<shared-playwright-cache>
```

Pin a specific app base port when needed:

```sh
WORKTREE_APP_PORT=3410 npm run setup-env
```

With that value, the backend listens on `3410` and Vite listens on `3411`.

## Sample App

Start the backend:

```sh
cd src-tauri
cargo run
```

In another shell, start the Web UI from the repo root:

```sh
npm run dev
```

Open the sample app at the Vite root:

```text
http://localhost:<WORKTREE_APP_PORT + 1>/
```

The sample UI polls:

```text
http://127.0.0.1:<WORKTREE_APP_PORT>/api/app-state
```

The backend also exposes:

```text
GET /health
GET /api/app-state
```

## Dashboard

Start the dashboard API:

```sh
npm run worktree:dashboard
```

Start Vite in another shell:

```sh
npm run dev
```

Open:

```text
http://localhost:<Vite port>/worktree-dashboard.html
```

If `.env` contains `WORKTREE_APP_PORT`, the Vite port is
`WORKTREE_APP_PORT + 1`. Without `.env`, Vite defaults to `3031`.

The dashboard API defaults to:

```text
http://127.0.0.1:4781/api
```

Override the dashboard API address with:

```sh
WORKTREE_DASHBOARD_HOST=127.0.0.1
WORKTREE_DASHBOARD_PORT=4781
```

or set the browser-facing API base directly:

```sh
VITE_WORKTREE_DASHBOARD_API_BASE=http://127.0.0.1:4781/api
```

The dashboard discovers worktrees with `git worktree list`, reads each
worktree's `.env`, and can start, stop, or recycle two managed services:

- `backend`: `cargo run` in `src-tauri`
- `ui`: `npm run dev` from the worktree root

Managed service logs are written under the system temp directory in
`worktree-dashboard/`.

## Tauri

The Tauri config uses:

- `devUrl`: `http://localhost:3031/`
- `frontendDist`: `../webui/dist`
- `beforeBuildCommand`: `npm run build`

Run the desktop app in development:

```sh
npm run tauri -- dev
```

Build a debug app bundle:

```sh
npm run tauri -- build --debug
```

The Rust binary behaves differently depending on how it is launched. When the
Tauri CLI sets `TAURI_ENV_PLATFORM`, it starts the desktop app. Without that
environment variable, `cargo run` starts the sample backend server.

## wt Hooks

The included `.config/wt.toml` defines:

- `pre-start`: run `node ./scripts/setup-env.mjs`, then `npm install`
- `post-start`: run `cargo build --workspace`
- `pre-remove`: call `scripts/stop-processes.mjs` through the dashboard API

The stop hook requires the dashboard API to be running.

## MCP Server

The MCP server lets agents inspect and manage worktrees through the dashboard
API.

Start the dashboard API first:

```sh
npm run worktree:dashboard
```

Then configure an MCP client to run:

```sh
npm run worktree:mcp
```

Example:

```json
{
  "mcpServers": {
    "worktree-dashboard": {
      "command": "npm",
      "args": ["run", "worktree:mcp"],
      "cwd": "/absolute/path/to/worktree-dashboard"
    }
  }
}
```

The MCP server targets `http://127.0.0.1:4781` by default. Override with:

```sh
WORKTREE_DASHBOARD_URL=http://127.0.0.1:4781
```

or:

```sh
WORKTREE_DASHBOARD_HOST=127.0.0.1
WORKTREE_DASHBOARD_PORT=4781
```

Available MCP tools:

- `dashboard_list_worktrees`
- `dashboard_worktree_status`
- `dashboard_worktree_manage`

`dashboard_worktree_manage` requires `worktree` and `action`. `action` is one
of `start`, `stop`, or `recycle`. `services` defaults to `["backend", "ui"]`
and accepts `backend`, `ui`, or `all`.

## Validation

Currently runnable checks:

```sh
npm run lint
npm run typecheck
npm run build
npm run tauri -- build --debug
```

The Playwright wrapper exists as `npm run test:webui-playwright`, but the
current `playwright.config.ts` references `npm run worktree:dashboard:ui`, which
is not defined in `package.json`.
