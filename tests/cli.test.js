import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo, run, GOOD_WORKFLOW, GOOD_PKG } from "./helpers.js";

test("--version and --help", () => {
  assert.equal(run(["--version"]).out.trim(), JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).version);
  assert.match(run(["--help"]).out, /trusted publishing/);
  assert.equal(run(["--bogus"]).code, 2);
});

test("exit codes and text output", () => {
  const good = makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW });
  const r = run(["check", good, "--offline", "--repo", "Acme/widget"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /ready for trusted publishing/);
  assert.match(r.out, /Workflow filename\s+release\.yml/);
  const bad = makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW.replace("'24'", "20") });
  const b = run([bad, "--offline", "--repo", "Acme/widget"]);
  assert.equal(b.code, 1);
  assert.match(b.out, /PR030/);
});

test("--strict fails on warnings", () => {
  const dir = makeRepo({ "package.json": { ...GOOD_PKG, name: "@acme/w" }, ".github/workflows/release.yml": GOOD_WORKFLOW });
  assert.equal(run([dir, "--offline", "--repo", "Acme/widget"]).code, 0);
  assert.equal(run([dir, "--offline", "--repo", "Acme/widget", "--strict"]).code, 1);
});

test("json and github formats", () => {
  const dir = makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW.replace("  id-token: write\n", "") });
  const j = JSON.parse(run([dir, "--offline", "--repo", "Acme/widget", "--format", "json"]).out);
  assert.equal(j.counts.error, 1);
  assert.equal(j.findings[0].code, "PR010");
  assert.deepEqual(j.publishSteps[0].trustedPublisherWorkflow, ["release.yml"]);
  const g = run([dir, "--offline", "--repo", "Acme/widget", "--format=github"]);
  assert.match(g.out, /^::error file=\.github\/workflows\/release\.yml,line=5,title=PR010 /m);
});

test("GITHUB_REPOSITORY is used as the repo identity", () => {
  const dir = makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW });
  const r = run([dir, "--offline"], { env: { GITHUB_REPOSITORY: "Other/widget" } });
  assert.equal(r.code, 1);
  assert.match(r.out, /PR103/);
});

test("explain from a file and from stdin", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pubready-log-")), "publish.log");
  fs.writeFileSync(f, 'npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/x - "repository.url" is "", expected to match "https://github.com/a/x" from provenance\n');
  const r = run(["explain", f]);
  assert.equal(r.code, 1);
  assert.match(r.out, /no repository\.url/);
  const s = run(["explain", "-"], { input: "all good\n" });
  assert.equal(s.code, 0);
  assert.match(s.out, /No known npm publish failure/);
});

test("rules lists every code", () => {
  const out = run(["rules"]).out;
  for (const c of ["PR010", "PR104", "PR110", "PR201"]) assert.match(out, new RegExp(c));
});

test("a subdirectory with its own workflows is checked on its own, not as part of the outer repo", () => {
  const outer = makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW, "examples/x/package.json": { name: "x", version: "1.0.0" }, "examples/x/.github/workflows/r.yml": GOOD_WORKFLOW });
  const j = JSON.parse(run([path.join(outer, "examples", "x"), "--offline", "--repo", "Acme/widget", "--format", "json"]).out);
  assert.deepEqual(j.publishSteps.map((s) => s.packages[0]), ["x"]);
});
