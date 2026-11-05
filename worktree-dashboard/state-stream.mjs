/**
 * @typedef {object} StateStreamOptions
 * @property {() => Promise<object>} collect Builds the current snapshot.
 * @property {(snapshot: object) => boolean} needsFastChecks Whether the snapshot shows
 *   a change in progress (such as a service still starting) that warrants fast checks.
 * @property {number} [fastIntervalMs] Check interval while a change is in progress.
 * @property {number} [slowIntervalMs] Check interval otherwise, to notice services
 *   started or stopped outside the dashboard.
 * @property {number} [boostMs] How long checks stay fast after a known change.
 * @property {number} [debounceMs] Window that coalesces bursts of change notifications.
 * @property {number} [keepAliveMs] Idle time after which a comment keeps connections open.
 * @property {(error: unknown) => void} [onError]
 * @property {() => number} [now]
 */

/**
 * Streams dashboard snapshots to Server-Sent Events clients, sending one only when
 * it differs from the last one sent. Snapshots are rebuilt when `notify` reports a
 * known change (an API action, a managed process exiting, a worktree added), and on a
 * timer that only runs while a client is connected: fast for a while after a change
 * and while `needsFastChecks` holds, slow otherwise.
 *
 * @param {StateStreamOptions} options
 */
export function createStateStream({
  collect,
  needsFastChecks,
  fastIntervalMs = 1000,
  slowIntervalMs = 10_000,
  boostMs = 15_000,
  debounceMs = 100,
  keepAliveMs = 25_000,
  onError = () => {},
  now = Date.now,
}) {
  /** @type {Set<import("node:http").ServerResponse>} */
  const clients = new Set();
  let lastSent = null;
  let lastSnapshot = null;
  let lastWriteAt = 0;
  let boostUntil = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let checkTimer = null;
  /** @type {Promise<void> | null} */
  let running = null;
  let rerun = false;

  /** Clients that have received at least one snapshot. */
  const primed = new WeakSet();

  /** Writes one SSE frame to every client and records when the stream was last written. */
  function broadcast(frame, { snapshot = false } = {}) {
    lastWriteAt = now();
    for (const res of clients) {
      res.write(frame);
      if (snapshot) primed.add(res);
    }
  }

  /** Encodes a snapshot as an SSE `snapshot` event. */
  function snapshotFrame(snapshot) {
    return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  }

  /**
   * Compares snapshots without their timestamp, so an unchanged state sends nothing.
   * The comparison key is the JSON of the snapshot minus `generatedAt`.
   */
  function stateKey(snapshot) {
    const { generatedAt: _generatedAt, ...state } = snapshot;
    return JSON.stringify(state);
  }

  /** Clears the pending timed check. */
  function clearCheck() {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = null;
  }

  /** Schedules the next timed check while clients are connected. */
  function scheduleCheck() {
    clearCheck();
    if (clients.size === 0) return;
    const fast =
      now() < boostUntil || (lastSnapshot && needsFastChecks(lastSnapshot));
    checkTimer = setTimeout(
      () => void refreshNow(),
      fast ? fastIntervalMs : slowIntervalMs,
    );
    checkTimer.unref?.();
  }

  /**
   * Rebuilds the snapshot and sends it when it changed, or a keep-alive comment when
   * the stream has been quiet too long. Calls that arrive while one is running are
   * folded into a single follow-up run, so collection never overlaps itself.
   */
  function refreshNow() {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          const snapshot = await collect();
          lastSnapshot = snapshot;
          // A run that outlived its last client must not mark its state as sent.
          if (clients.size === 0) break;
          const key = stateKey(snapshot);
          if (key !== lastSent) {
            lastSent = key;
            broadcast(snapshotFrame(snapshot), { snapshot: true });
          } else if (now() - lastWriteAt >= keepAliveMs) {
            broadcast(": keep-alive\n\n");
          }
        } while (rerun && clients.size > 0);
      } catch (error) {
        onError(error);
      } finally {
        running = null;
        scheduleCheck();
      }
    })();
    return running;
  }

  /**
   * Reports a known change: checks stay fast for a while, and a rebuild runs once the
   * debounce window closes. Does nothing while no client is connected.
   */
  function notify() {
    if (clients.size === 0) return;
    boostUntil = now() + boostMs;
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refreshNow();
    }, debounceMs);
    debounceTimer.unref?.();
  }

  /**
   * Opens an SSE stream on a response and sends the newest snapshot to it right away.
   * The stream ends when the client disconnects; the timer stops with the last client.
   *
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async function addClient(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    clients.add(res);
    req.on("close", () => {
      clients.delete(res);
      if (clients.size === 0) {
        clearCheck();
        lastSent = null;
      }
    });
    // The first client triggers a collection; later ones wait for any in flight.
    await (clients.size === 1 ? refreshNow() : running);
    // Covers a client that joined after the newest snapshot was already sent.
    if (clients.has(res) && !primed.has(res) && lastSnapshot) {
      res.write(snapshotFrame(lastSnapshot));
      primed.add(res);
    }
  }

  /** Ends every open stream, for shutdown. */
  function close() {
    clearCheck();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    for (const res of clients) res.end();
    clients.clear();
  }

  return {
    addClient,
    notify,
    refreshNow,
    close,
    clientCount: () => clients.size,
  };
}
