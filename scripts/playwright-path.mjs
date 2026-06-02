import os from "node:os";
import { join } from "node:path";

const cacheRoot =
  process.platform === "darwin"
    ? join(os.homedir(), "Library", "Caches")
    : process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(os.homedir(), "AppData", "Local"))
      : (process.env.XDG_CACHE_HOME ?? join(os.homedir(), ".cache"));

export const sharedBrowsersPath = join(cacheRoot, "ms-playwright");
