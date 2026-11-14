import { test } from "node:test";
import assert from "node:assert/strict";
import { check, exitCode } from "../src/check.js";
import { makeRepo, codes, GOOD_WORKFLOW, GOOD_PKG } from "./helpers.js";

const opts = { online: false, repo: "Acme/widget" };

test("a correct setup has no errors or warnings", async () => {
  const dir = makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW });
  const r = await check(dir, opts);
  assert.deepEqual(codes(r), []);
  assert.equal(exitCode(r), 0);
  assert.deepEqual(r.settings, [{ package: "widget", provider: "GitHub Actions", owner: "Acme", repo: "widget", workflow: "release.yml", environment: null }]);
});

test("missing id-token permission (workflow-level permissions without it)", async () => {
  const wf = GOOD_WORKFLOW.replace("  id-token: write\n", "");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.ok(codes(r).includes("PR010"));
  assert.equal(r.findings.find((f) => f.code === "PR010").line, 5);
});

test("missing id-token permission (no permissions anywhere)", async () => {
  const wf = GOOD_WORKFLOW.replace("permissions:\n  contents: read\n  id-token: write\n", "");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.deepEqual(codes(r), ["PR010"]);
});

test("job-level permissions override the workflow's", async () => {
  const wf = GOOD_WORKFLOW.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.ok(codes(r).includes("PR010"));
});

test("write-all grants id-token", async () => {
  const wf = GOOD_WORKFLOW.replace("permissions:\n  contents: read\n  id-token: write\n", "permissions: write-all\n");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.ok(!codes(r).includes("PR010"));
});

test("Node 20 is too old, Node 22 bundles npm 10, an npm upgrade fixes 22", async () => {
  const r20 = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW.replace("'24'", "20") }), opts);
  assert.ok(codes(r20).includes("PR030"));
  const r22 = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW.replace("'24'", "22") }), opts);
  assert.deepEqual(codes(r22), ["PR031"]);
  const fixed = GOOD_WORKFLOW.replace("'24'", "22").replace("      - run: npm ci\n", "      - run: npm ci\n      - run: npm install -g npm@latest\n");
  const r22b = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": fixed }), opts);
  assert.deepEqual(codes(r22b), []);
});

test("an npm pin below 11.5.1 is flagged", async () => {
  const wf = GOOD_WORKFLOW.replace("      - run: npm ci\n", "      - run: npm i -g npm@11.4.2\n");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.ok(codes(r).includes("PR031"));
});

test("matrix node versions are all checked", async () => {
  const wf = GOOD_WORKFLOW.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20, 24]\n").replace("'24'", "${{ matrix.node }}");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.ok(codes(r).includes("PR030"));
});

test("node-version-file is read", async () => {
  const wf = GOOD_WORKFLOW.replace("node-version: '24'", "node-version-file: .nvmrc");
  const bad = await check(makeRepo({ "package.json": GOOD_PKG, ".nvmrc": "v20.11.0\n", ".github/workflows/release.yml": wf }), opts);
  assert.ok(codes(bad).includes("PR030"));
  const good = await check(makeRepo({ "package.json": GOOD_PKG, ".nvmrc": "24\n", ".github/workflows/release.yml": wf }), opts);
  assert.deepEqual(codes(good), []);
});

test("no setup-node means the Node version is unknown", async () => {
  const wf = GOOD_WORKFLOW.replace(/      - uses: actions\/setup-node@v6\n        with:\n.*\n.*\n/, "");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.deepEqual(codes(r), ["PR032"]);
});

test("node container image is used", async () => {
  const wf = GOOD_WORKFLOW.replace(/      - uses: actions\/setup-node@v6\n        with:\n.*\n.*\n/, "").replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    container: node:20-alpine\n");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.ok(codes(r).includes("PR030"));
});

test("self-hosted runners are rejected", async () => {
  const wf = GOOD_WORKFLOW.replace("runs-on: ubuntu-latest", "runs-on: [self-hosted, linux]");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.deepEqual(codes(r), ["PR020"]);
});

test("leftover tokens: env on the step, and .npmrc", async () => {
  const wf = GOOD_WORKFLOW.replace("      - run: npm stage publish\n", "      - run: npm stage publish\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf, ".npmrc": "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n" }), opts);
  assert.deepEqual(codes(r), ["PR040", "PR041"]);
  assert.equal(r.findings.find((f) => f.code === "PR040").line, 20);
});

test("a step that writes _authToken into .npmrc", async () => {
  const wf = GOOD_WORKFLOW.replace("      - run: npm ci\n", '      - run: echo "//registry.npmjs.org/:_authToken=${{ secrets.NPM_TOKEN }}" > ~/.npmrc\n');
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.ok(codes(r).includes("PR041"));
});

test("reusable workflow: filename is the caller's, caller must grant id-token", async () => {
  const callee = GOOD_WORKFLOW.replace("on:\n  push:\n    tags: ['v*']\n", "on:\n  workflow_call:\n");
  const caller = "on:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    uses: ./.github/workflows/publish.yml\n";
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/publish.yml": callee, ".github/workflows/release.yml": caller }), opts);
  assert.deepEqual(codes(r), ["PR011", "PR012"]);
  assert.equal(r.settings[0].workflow, "release.yml");
  const caller2 = caller.replace("    uses:", "    permissions:\n      contents: read\n      id-token: write\n    uses:");
  const r2 = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/publish.yml": callee, ".github/workflows/release.yml": caller2 }), opts);
  assert.deepEqual(codes(r2), ["PR012"]);
});

test("reusable workflow with no caller in the repo", async () => {
  const callee = GOOD_WORKFLOW.replace("on:\n  push:\n    tags: ['v*']\n", "on:\n  workflow_call:\n");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/publish.yml": callee }), opts);
  assert.deepEqual(codes(r), ["PR013"]);
});

test("environment is reported for the trusted publisher form", async () => {
  const wf = GOOD_WORKFLOW.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment:\n      name: npm\n      url: https://npmjs.com\n");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.equal(r.settings[0].environment, "npm");
});

test("direct npm publish gets the allowed-actions note", async () => {
  const wf = GOOD_WORKFLOW.replace("npm stage publish", "npm publish");
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.deepEqual(codes(r), ["PR060"]);
  assert.equal(exitCode(r), 0);
});

test("dist-tag needs a newer npm than Node bundles", async () => {
  const wf = GOOD_WORKFLOW + "      - run: npm dist-tag add widget@1.0.1 next\n";
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), opts);
  assert.deepEqual(codes(r), ["PR033"]);
  const wf2 = GOOD_WORKFLOW.replace("      - run: npm ci\n", "      - run: npm ci\n      - run: npm install -g npm@latest\n") + "      - run: npm dist-tag add widget@1.0.1 next\n";
  const r2 = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf2 }), opts);
  assert.deepEqual(codes(r2), []);
});

test("publish tools: yarn 1 can't, pnpm/yarn berry unverified, old lerna can't", async () => {
  const y1 = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW.replace("npm stage publish", "yarn publish --non-interactive") }), opts);
  assert.ok(codes(y1).includes("PR050"));
  const pn = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW.replace("npm stage publish", "pnpm publish --no-git-checks") }), opts);
  assert.deepEqual(codes(pn), ["PR051"]);
  const lerna = await check(makeRepo({ "package.json": { ...GOOD_PKG, devDependencies: { lerna: "^8.1.0" } }, ".github/workflows/release.yml": GOOD_WORKFLOW.replace("npm stage publish", "npx lerna publish from-package --yes") }), opts);
  assert.ok(codes(lerna).includes("PR050"));
});

test("changesets/action publish input is followed through package scripts", async () => {
  const wf = GOOD_WORKFLOW.replace("      - run: npm stage publish\n", "      - uses: changesets/action@v1\n        with:\n          publish: npm run release\n");
  const pkg = { ...GOOD_PKG, scripts: { release: "changeset publish" } };
  const r = await check(makeRepo({ "package.json": pkg, ".github/workflows/release.yml": wf }), opts);
  assert.equal(r.sites.length, 1);
  assert.deepEqual(r.sites[0].pubs[0].via, ["changesets/action", "npm run release"]);
});

test("unparseable workflow is reported, others still checked", async () => {
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": GOOD_WORKFLOW, ".github/workflows/broken.yml": "jobs: [\n" }), opts);
  assert.deepEqual(codes(r), ["PR002"]);
});

test("no publish anywhere", async () => {
  const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n" }), opts);
  assert.deepEqual(codes(r), ["PR001"]);
});

test("changesets/action v2 publish-script input", async () => {
  const wf = GOOD_WORKFLOW.replace("      - run: npm stage publish\n", "      - uses: changesets/action@v2\n        with:\n          publish-script: bun run publish:ci\n");
  const pkg = { ...GOOD_PKG, scripts: { "publish:ci": "bun run build && changeset publish" } };
  const r = await check(makeRepo({ "package.json": pkg, ".github/workflows/release.yml": wf }), opts);
  assert.equal(r.sites.length, 1);
  assert.equal(r.sites[0].pubs[0].tool, "changeset");
});
