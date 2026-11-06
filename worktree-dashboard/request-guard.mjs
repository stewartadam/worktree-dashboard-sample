const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Splits a comma-separated list of origins, dropping blanks and trailing slashes. */
export function parseAllowedOrigins(value) {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/u, ""))
    .filter(Boolean);
}

/** Returns the lowercase hostname of a Host header value, or null if malformed. */
function hostnameFromHostHeader(host) {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Returns the lowercase hostname of an origin, or null for `null` and malformed ones. */
function hostnameFromOrigin(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Builds the check every dashboard request passes. The API can start, stop and
 * kill local processes, so web pages must not be able to reach it:
 *
 * - The Host header must name this machine, which stops DNS rebinding.
 * - An Origin header, which browsers send on cross-origin POSTs, must be a
 *   loopback origin or one in `allowedOrigins`. CORS alone can't do this:
 *   simple POSTs are sent even when the page can't read the response.
 *
 * Non-browser clients send no Origin and pass on the Host check alone. Only
 * `allowedOrigins` get CORS headers, as the page normally reaches the API through
 * the same-origin Vite proxy.
 *
 * @param {{ dashboardHost: string, allowedOrigins?: string[] }} options
 */
export function createRequestGuard({ dashboardHost, allowedOrigins = [] }) {
  const origins = new Set(allowedOrigins);
  const hosts = new Set(LOOPBACK_HOSTNAMES);
  hosts.add(dashboardHost.toLowerCase());
  for (const origin of allowedOrigins) {
    const hostname = hostnameFromOrigin(origin);
    if (hostname) hosts.add(hostname);
  }

  /**
   * @param {{ host?: string, origin?: string }} headers
   * @returns {{ allowed: boolean, reason?: string, corsOrigin?: string }}
   */
  return function checkRequest({ host, origin }) {
    const hostname = host ? hostnameFromHostHeader(host) : null;
    if (!hostname || !hosts.has(hostname)) {
      return {
        allowed: false,
        reason: `Host not allowed: ${host ?? "(none)"}`,
      };
    }
    if (origin === undefined) return { allowed: true };
    if (origins.has(origin)) return { allowed: true, corsOrigin: origin };
    const originHostname = hostnameFromOrigin(origin);
    if (originHostname && LOOPBACK_HOSTNAMES.has(originHostname)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Origin not allowed: ${origin}. Add it to WORKTREE_DASHBOARD_ALLOWED_ORIGINS to permit it.`,
    };
  };
}
