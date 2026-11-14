import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNodeSpec, nodeMeetsMinimum, bundledNpmSupportsOidc, resolveNpmSpec, npmSupportsOidc, npmSupportsDistTag } from "../src/versions.js";

test("node specs that can and can't publish with OIDC", () => {
  const ok = (s) => nodeMeetsMinimum(resolveNodeSpec(s)) && bundledNpmSupportsOidc(resolveNodeSpec(s));
  for (const s of ["24", "24.x", "v24", "lts/*", "latest", "node", "26", ">=22", "lts/krypton", "24.5.0", "25.1.0", 24]) assert.equal(ok(s), true, s);
  for (const s of ["20", "18.x", "lts/iron", "22", "22.14.0", "24.4.0", "24.4", "lts/jod"]) assert.equal(ok(s), false, s);
});

test("Node 22.14 meets the Node minimum but bundles npm 10", () => {
  assert.equal(nodeMeetsMinimum(resolveNodeSpec("22.14.0")), true);
  assert.equal(nodeMeetsMinimum(resolveNodeSpec("22.13.1")), false);
  assert.equal(nodeMeetsMinimum(resolveNodeSpec("22")), true);
  assert.equal(bundledNpmSupportsOidc(resolveNodeSpec("22")), false);
});

test("unresolvable specs are unknown, not wrong", () => {
  assert.equal(resolveNodeSpec("${{ matrix.node }}").unknown, true);
  assert.equal(nodeMeetsMinimum(resolveNodeSpec("")), null);
});

test("npm upgrade specs", () => {
  assert.equal(npmSupportsOidc(resolveNpmSpec("latest")), true);
  assert.equal(npmSupportsOidc(resolveNpmSpec("11")), true);
  assert.equal(npmSupportsOidc(resolveNpmSpec("11.5.1")), true);
  assert.equal(npmSupportsOidc(resolveNpmSpec("11.4.2")), false);
  assert.equal(npmSupportsOidc(resolveNpmSpec("10")), false);
  assert.equal(npmSupportsDistTag(resolveNpmSpec("11.20.0")), false);
  assert.equal(npmSupportsDistTag(resolveNpmSpec("11.21.0")), true);
  assert.equal(npmSupportsDistTag(resolveNpmSpec("12.1.0")), false);
  assert.equal(npmSupportsDistTag(resolveNpmSpec("latest")), true);
});
