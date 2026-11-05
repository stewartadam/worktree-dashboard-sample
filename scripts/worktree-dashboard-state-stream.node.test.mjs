import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import { createStateStream } from "../worktree-dashboard/state-stream.mjs";

/** Builds a fake request/response pair that records every SSE frame written. */
function fakeClient() {
  const req = new EventEmitter();
  const frames = [];
  const res = {
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(frame) {
      frames.push(frame);
    },
    end() {
      this.ended = true;
    },
  };
  /** Returns the snapshots sent so far, parsed from `snapshot` events. */
  const snapshots = () =>
    frames
      .filter((frame) => frame.startsWith("event: snapshot"))
      .map((frame) => JSON.parse(frame.split("data: ")[1]));
  return { req, res, frames, snapshots, disconnect: () => req.emit("close") };
}

/**
 * Builds a stream over a mutable fake state with a manual clock, counting collections.
 * `state.value` is what the next snapshot reports.
 */
function fixture(overrides = {}) {
  let clock = 0;
  const state = { value: 1, starting: false };
  let collections = 0;
  const stream = createStateStream({
    collect: async () => {
      collections += 1;
      return {
        generatedAt: `t${clock}`,
        value: state.value,
        starting: state.starting,
      };
    },
    needsFastChecks: (snapshot) => snapshot.starting,
    fastIntervalMs: 1000,
    slowIntervalMs: 10_000,
    boostMs: 5000,
    debounceMs: 100,
    keepAliveMs: 25_000,
    now: () => clock,
    ...overrides,
  });
  /** Advances the fake clock and Node's mocked timers together, then lets promises settle. */
  const advance = async (ms) => {
    clock += ms;
    mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { stream, state, advance, collections: () => collections };
}

/** A new client gets SSE headers and the current snapshot right away. */
test("state stream sends the current snapshot when a client connects", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const f = fixture();
  const client = fakeClient();

  await f.stream.addClient(client.req, client.res);

  assert.equal(client.res.status, 200);
  assert.match(client.res.headers["Content-Type"], /text\/event-stream/);
  assert.deepEqual(client.snapshots(), [
    { generatedAt: "t0", value: 1, starting: false },
  ]);
});

/** Timed checks that find the same state send nothing, and a change is sent once. */
test("state stream sends only snapshots that changed, ignoring the timestamp", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const f = fixture();
  const client = fakeClient();
  await f.stream.addClient(client.req, client.res);

  await f.advance(10_000);
  assert.equal(f.collections(), 2);
  assert.equal(client.snapshots().length, 1);

  f.state.value = 2;
  await f.advance(10_000);
  assert.deepEqual(
    client.snapshots().map((snapshot) => snapshot.value),
    [1, 2],
  );
});

/** A notified change is collected after the debounce window, and bursts collapse into one. */
test("state stream coalesces notifications and then checks fast for a while", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const f = fixture();
  const client = fakeClient();
  await f.stream.addClient(client.req, client.res);

  f.state.value = 2;
  f.stream.notify();
  f.stream.notify();
  f.stream.notify();
  await f.advance(100);
  assert.equal(f.collections(), 2);
  assert.equal(client.snapshots().at(-1).value, 2);

  // Inside the boost window the next check is 1s away instead of 10s.
  await f.advance(1000);
  assert.equal(f.collections(), 3);
  await f.advance(5000);
  const afterBoost = f.collections();
  await f.advance(1000);
  assert.equal(f.collections(), afterBoost);
});

/** A snapshot reporting work in progress keeps checks fast until it settles. */
test("state stream checks fast while needsFastChecks holds", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const f = fixture();
  f.state.starting = true;
  const client = fakeClient();
  await f.stream.addClient(client.req, client.res);

  await f.advance(1000);
  await f.advance(1000);
  assert.equal(f.collections(), 3);

  f.state.starting = false;
  await f.advance(1000);
  assert.equal(f.collections(), 4);
  await f.advance(1000);
  assert.equal(f.collections(), 4);
});

/** Nothing is collected while no client is connected, and a returning client is caught up. */
test("state stream stops checking without clients", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const f = fixture();
  const first = fakeClient();
  await f.stream.addClient(first.req, first.res);
  first.disconnect();

  f.stream.notify();
  await f.advance(60_000);
  assert.equal(f.collections(), 1);
  assert.equal(f.stream.clientCount(), 0);

  const second = fakeClient();
  await f.stream.addClient(second.req, second.res);
  assert.equal(second.snapshots().length, 1);
});

/** A quiet stream gets a comment frame so idle connections stay open. */
test("state stream writes keep-alive comments when nothing changes", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const f = fixture();
  const client = fakeClient();
  await f.stream.addClient(client.req, client.res);

  await f.advance(10_000);
  await f.advance(10_000);
  assert.equal(client.frames.includes(": keep-alive\n\n"), false);
  await f.advance(10_000);
  assert.equal(client.frames.includes(": keep-alive\n\n"), true);
});

/** close ends every stream, for dashboard shutdown. */
test("state stream close ends all clients", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const f = fixture();
  const client = fakeClient();
  await f.stream.addClient(client.req, client.res);

  f.stream.close();

  assert.equal(client.res.ended, true);
  assert.equal(f.stream.clientCount(), 0);
});

/**
 * A collection still running when the last client leaves must not count as sent, so
 * a client that reconnects afterwards still gets the state that run captured.
 */
test("state stream catches up a client that reconnects after an orphaned run", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let release = () => {};
  let value = 1;
  let gated = false;
  const stream = createStateStream({
    collect: async () => {
      if (gated) await new Promise((resolve) => (release = resolve));
      return { generatedAt: "t", value };
    },
    needsFastChecks: () => false,
  });
  const first = fakeClient();
  await stream.addClient(first.req, first.res);

  gated = true;
  value = 2;
  const orphaned = stream.refreshNow();
  first.disconnect();
  release();
  await orphaned;

  gated = false;
  const second = fakeClient();
  await stream.addClient(second.req, second.res);
  assert.deepEqual(second.snapshots(), [{ generatedAt: "t", value: 2 }]);
});

/** A client joining while another is connected gets the newest snapshot at once. */
test("state stream primes a second client from the newest snapshot", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const f = fixture();
  const first = fakeClient();
  await f.stream.addClient(first.req, first.res);

  const second = fakeClient();
  await f.stream.addClient(second.req, second.res);

  assert.equal(second.snapshots().length, 1);
  assert.equal(f.collections(), 1);
});
