import assert from "node:assert/strict";
import { test } from "node:test";
import { PORT_BLOCK_SIZE, pickPortBlock } from "./setup-env.mjs";

test("pickPortBlock maps the random value across the free blocks", () => {
  assert.equal(
    pickPortBlock([], () => 0),
    3000,
  );
  assert.equal(
    pickPortBlock([], () => 0.999),
    3990,
  );
});

test("pickPortBlock skips aligned and unaligned taken ports", () => {
  assert.equal(
    pickPortBlock([3000], () => 0),
    3010,
  );
  // A port taken at 3005 is assumed to own 3005-3014, overlapping two blocks.
  assert.equal(
    pickPortBlock([3005], () => 0),
    3020,
  );
});

test("pickPortBlock never overlaps a taken block", () => {
  for (let i = 0; i < 200; i += 1) {
    const base = pickPortBlock([3030, 3517, 3988]);
    assert.equal(base % PORT_BLOCK_SIZE, 0);
    for (const taken of [3030, 3517, 3988]) {
      assert.ok(
        base + PORT_BLOCK_SIZE <= taken || taken + PORT_BLOCK_SIZE <= base,
      );
    }
  }
});

test("pickPortBlock fails with a remedy when every block is taken", () => {
  const everyBlock = Array.from({ length: 100 }, (_, i) => 3000 + i * 10);
  assert.throws(() => pickPortBlock(everyBlock), /set WORKTREE_APP_PORT/);
});
