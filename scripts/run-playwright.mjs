import { spawnSync } from "node:child_process";
import os from "node:os";
import { join } from "node:path";

import { sharedBrowsersPath } from "./playwright-path.mjs";

const cliEntrypoint = join(
  process.cwd(),
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const osReleaseMajor = Number.parseInt(os.release().split(".")[0] ?? "0", 10);
const playwrightHostPlatform =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  osReleaseMajor >= 20
    ? `mac${Math.min(osReleaseMajor - 9, 15)}-arm64`
    : undefined;

const result = spawnSync(
  process.execPath,
  [cliEntrypoint, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? sharedBrowsersPath,
      ...(playwrightHostPlatform
        ? { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: playwrightHostPlatform }
        : {}),
    },
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 0);
