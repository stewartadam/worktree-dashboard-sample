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
| `npm run dev` | Start Vite. |
| `npm run build` | Build the Vite web UI into `webui/dist`. |
| `npm run serve` | Preview the built Vite output. |
| `npm run tauri` | Run the Tauri CLI. Pass commands after `--`. |
| `npm run worktree:dashboard` | Start the dashboard API with Node watch mode. |
| `npm run worktree:mcp` | Start the dashboard MCP server. |
| `npm run setup-env` | Generate the current worktree's `.env`. |
| `npm run worktree:dashboard:ui` | Start Vite and open the dashboard page in your browser. |
| `npm test` | Run the Node tests in `scripts/`. |
| `npm run test:webui-playwright` | Run the Playwright tests. |
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
APP_PORT=<first port of a free 10-port block in 3000-3999, or supplied value>
VITE_APP_TITLE=Sample Worktree App (<branch>)
PLAYWRIGHT_BROWSERS_PATH=<shared-playwright-cache>
```

Pin a specific app base port when needed:

```sh
APP_PORT=3410 npm run setup-env
```

With that value, the backend listens on `3410` and Vite listens on `3411`.

Without a supplied value, `setup-env` picks a block aligned to a multiple of 10
that overlaps no other worktree's `APP_PORT`.

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
http://localhost:<APP_PORT + 1>/
```

The sample UI polls:

```text
http://127.0.0.1:<APP_PORT>/api/app-state
```

The backend also exposes:

```text
GET /health
GET /api/app-state
```

## Dashboard

The dashboard has two processes: the API, and Vite, which serves the page.

In VS Code, choose **Tasks: Run Task**, then **worktree dashboard: launch (ui+api)**.
It starts both and opens the page in your browser.

From a terminal, start the API, then the page in another shell:

```sh
npm run worktree:dashboard
```

```sh
npm run worktree:dashboard:ui
```

The page is at:

```text
http://localhost:<Vite port>/worktree-dashboard.html
```

If `.env` contains `APP_PORT`, the Vite port is
`APP_PORT + 1`. Without `.env`, Vite defaults to `3031`.

The dashboard API defaults to:

```text
http://127.0.0.1:4781/api
```

Override the dashboard API address with:

```sh
WORKTREE_DASHBOARD_HOST=127.0.0.1
WORKTREE_DASHBOARD_PORT=4781
```

The page reaches the API through the Vite dev server, which proxies
`/worktree-api` to `/api`.

Because the API starts and kills local processes, it refuses any request whose
`Host` isn't this machine, or whose `Origin` isn't a loopback address. To call it
directly from another origin, such as a dev server opened over your LAN, list
that origin and point the page at the API:

```sh
WORKTREE_DASHBOARD_ALLOWED_ORIGINS=http://192.168.1.20:3411
VITE_WORKTREE_DASHBOARD_API_BASE=http://192.168.1.20:4781/api
```

The hostnames of allowed origins are also accepted as `Host` values. Loopback
origins are always allowed, so other servers on this machine can still reach the
API.

The dashboard discovers worktrees with `git worktree list`, reads each
worktree's `.env`, and can start, stop, or recycle the managed services:

- `backend`: `cargo run` in `src-tauri`
- `ui`: `npm run dev` from the worktree root

The page updates as soon as anything changes, over a Server-Sent Events stream at
`GET /api/events`. Its search box filters by branch name or path. Type a branch that
has no worktree and press Shift+Enter, or choose **Create worktree**, to create one
through `wt switch`: a branch that exists locally or on `origin` is checked out, and
any other name becomes a new branch from `origin/HEAD`.

A worktree's **More actions** menu opens it in VS Code or deletes it. Delete keeps a
worktree with uncommitted files, or a branch that hasn't landed in `origin`'s default
branch or a merged pull request. Hold Shift to choose **Force delete**, which
discards both. Both ask for confirmation first. The primary worktree and the checkout running the dashboard can't be
deleted.

To adapt the dashboard to your app, edit
[`worktree-dashboard/services.mjs`](worktree-dashboard/services.mjs). It's the one
place services are defined: the API, the page's columns and menus, and the MCP
server all read from it. Restart the dashboard API afterwards.

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
- `pre-remove`: run `wt service stop -s all --best-effort`, which gives up after 5
  seconds per request and never blocks removal
- `wt service`: an alias that manages services from the terminal
- `wt done`: an alias that removes a worktree whose branch has landed, and keeps it
  with a list of unmerged commits otherwise

## Managing services from a terminal

With the dashboard API running, the `wt service` alias acts on the worktree you're
in, or on another one with `wt -C <path>`:

```sh
wt service list                   # every worktree with its ports and status
wt service status                 # this worktree's services, with URLs
wt service restart                # restart every service and wait for them
wt service start -s backend       # start one service
wt -C ../other service stop -s all
```

`start` and `restart` wait up to 600 seconds for each service to answer, print the
log tail of any that fails, and exit with an error. Run `wt service --help` for every
option.

`wt service` runs the copy of its script in the worktree you're in, while the API
runs the copy from the checkout you started it in. If the alias rejects a service
the API knows, or the reverse, bring the worktree up to date and restart the API.

## Claude Code worktrees

Claude Code doesn't read `.config/wt.toml`. Its `WorktreeCreate` and `WorktreeRemove`
hooks in `.claude/settings.json` run `scripts/claude-worktree-hook.mjs`, which sends
worktrees through `wt` so they get the same setup and cleanup. Their branches are
named `claude/<name>` and start from `origin/HEAD`, so set it if it's missing:

```sh
git remote set-head origin --auto
```

## How it works

One Node process, the dashboard API, owns the running services of every worktree.
The page, `wt service` and the MCP server hold no service state: they ask the API for
a snapshot and send it actions, so a service started from the terminal shows up on the
page and an agent can stop it. The `.env` in each worktree is the contract between the
`wt` hooks, which write it, and the API, which reads it.

The API knows a service in two ways. It's managed when the API spawned the process,
and observed when something answers on the service's port:

| Managed process running | Port answers | Status |
| --- | --- | --- |
| Yes | Yes | managed + reachable |
| Yes | No | managed starting/unreachable |
| No | Yes | external process detected |
| No | No | stopped |

Managed records live in memory, so restarting the API forgets them. It stops what it
started when it shuts down.

`start` leaves an external process on a service's port running. `stop` and `recycle`
terminate whatever listens on that port, including processes the dashboard didn't
start.

### API

The API listens on `127.0.0.1:4781` by default. A worktree's ID is its absolute path,
encoded as base64url.

| Method and path | Query | Description |
| --- | --- | --- |
| `GET /health` | None | Returns `{"ok": true}`. |
| `GET /api/worktrees` | None | Returns a snapshot of the service catalog and every worktree. |
| `GET /api/events` | None | Sends the same snapshot as a `snapshot` event on connect and whenever it changes. |
| `POST /api/worktrees` | `branch` | Creates a worktree through `wt switch`. Returns 400 for an invalid name and 409 with Worktrunk's error when it refuses. |
| `POST /api/worktrees/<id>/start` | `service` | Starts services. Returns 400 when the worktree has no `.env`. |
| `POST /api/worktrees/<id>/stop` | `service` | Stops services and clears their ports. |
| `POST /api/worktrees/<id>/recycle` | `service` | Stops and starts services. |
| `POST /api/worktrees/<id>/open-log` | `service` | Opens a service's latest log in VS Code. |
| `POST /api/worktrees/<id>/open-editor` | None | Opens the worktree in VS Code. |
| `POST /api/worktrees/<id>/remove` | `force` | Removes the worktree through `wt done`, or `wt remove --force` with `force=1`. Returns 409 with the reason when it keeps the worktree. |

`service` is a service name or a group from `worktree-dashboard/services.mjs`, and
defaults to `all`.

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

The MCP server and `wt service` target `http://127.0.0.1:4781` by default. Override
with:

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
of `start`, `stop`, or `recycle`. `services` defaults to `["all"]` and accepts any
service or group from `worktree-dashboard/services.mjs`.

## Validation

Currently runnable checks:

```sh
npm test
npm run test:webui-playwright
npm run lint
npm run typecheck
npm run build
npm run tauri -- build --debug
```
