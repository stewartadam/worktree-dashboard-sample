import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_PORT_ENV,
  basePortFromEnv,
  SERVICE_CATALOG,
  SERVICE_DEFINITIONS,
  SERVICE_SELECTORS,
  SERVICES,
  serviceArgs,
  servicePortFromEnv,
  servicesForTarget,
  vitePortFromEnv,
} from "../worktree-dashboard/services.mjs";
import { PORT_BLOCK_SIZE } from "./setup-env.mjs";

test("service ports are the base port plus their offset", () => {
  const env = { [BASE_PORT_ENV]: "3410" };
  assert.equal(servicePortFromEnv("backend", env), 3410);
  assert.equal(servicePortFromEnv("ui", env), 3411);
});

test("Vite's port follows the base port, then the default", () => {
  assert.equal(vitePortFromEnv({ [BASE_PORT_ENV]: "3410" }), 3411);
  assert.equal(vitePortFromEnv({}), 3031);
});

test("an invalid base port gives no service port", () => {
  assert.equal(basePortFromEnv({}), null);
  assert.equal(basePortFromEnv({ [BASE_PORT_ENV]: "abc" }), null);
  assert.equal(servicePortFromEnv("backend", {}), null);
  assert.equal(servicePortFromEnv("no-such-service", {}), null);
});

test("every port offset is unique and fits the port block", () => {
  const offsets = Object.values(SERVICE_DEFINITIONS)
    .map((definition) => definition.portOffset)
    .filter((offset) => offset !== undefined);
  assert.equal(new Set(offsets).size, offsets.length);
  for (const offset of offsets) {
    assert.ok(offset >= 0 && offset < PORT_BLOCK_SIZE);
  }
});

test("selectors name only real services", () => {
  for (const members of Object.values(SERVICE_SELECTORS)) {
    for (const member of members) assert.ok(SERVICES.includes(member));
  }
});

test("servicesForTarget expands groups and rejects unknown or inherited names", () => {
  assert.deepEqual(servicesForTarget("ui"), ["ui"]);
  assert.deepEqual(servicesForTarget("both"), ["backend", "ui"]);
  assert.deepEqual(servicesForTarget("all"), SERVICES);
  assert.equal(servicesForTarget("nope"), null);
  assert.equal(servicesForTarget("constructor"), null);
});

test("serviceArgs returns static arguments", () => {
  assert.deepEqual(serviceArgs("ui", {}), ["run", "dev"]);
});

test("the catalog describes each service without its command", () => {
  assert.deepEqual(
    SERVICE_CATALOG.map((entry) => entry.name),
    SERVICES,
  );
  for (const entry of SERVICE_CATALOG) {
    assert.equal(entry.command, undefined);
    assert.equal(typeof entry.label, "string");
  }
});
