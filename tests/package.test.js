import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/check.js";
import { makeRepo, codes, fixtureFile, GOOD_WORKFLOW, GOOD_PKG } from "./helpers.js";

const opts = { online: false, repo: "Acme/widget" };
const files = (pkg, extra = {}) => ({ "package.json": pkg, ".github/workflows/release.yml": GOOD_WORKFLOW, ...extra });

test("missing repository", async () => {
  const { repository, ...pkg } = GOOD_PKG;
  const r = await check(makeRepo(files(pkg)), opts);
  assert.deepEqual(codes(r), ["PR101"]);
  assert.match(r.findings[0].fix, /git\+https:\/\/github.com\/Acme\/widget.git/);
});

test("fork / renamed repo", async () => {
  const r = await check(makeRepo(files({ ...GOOD_PKG, repository: "github:someone-else/widget" })), opts);
  assert.deepEqual(codes(r), ["PR103"]);
});

test("wrong host", async () => {
  const r = await check(makeRepo(files({ ...GOOD_PKG, repository: "https://gitlab.com/Acme/widget" })), opts);
  assert.deepEqual(codes(r), ["PR102"]);
});

test("case-only difference offline vs online", async () => {
  const pkg = { ...GOOD_PKG, repository: "https://github.com/acme/widget" };
  const off = await check(makeRepo(files(pkg)), opts);
  assert.deepEqual(codes(off), ["PR103"]);
  process.env.PUBREADY_FIXTURE = fixtureFile({
    "https://api.github.com/repos/acme/widget": { full_name: "Acme/widget", private: false },
    "https://registry.npmjs.org/widget": { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } },
  });
  try {
    const on = await check(makeRepo(files(pkg)), { online: true, repo: "acme/widget" });
    assert.deepEqual(codes(on), ["PR104"]);
    assert.equal(on.settings[0].owner, "Acme");
  } finally {
    delete process.env.PUBREADY_FIXTURE;
  }
});

test("git remote is used when no --repo is given", async () => {
  const dir = makeRepo(files(GOOD_PKG), { remote: "git@github.com:Acme/widget.git" });
  const r = await check(dir, { online: false });
  assert.deepEqual(codes(r), []);
  assert.equal(r.repoSource, "git remote origin");
});

test("online: first publish, version already taken, private repo", async () => {
  const scoped = { ...GOOD_PKG, name: "@acme/widget" };
  process.env.PUBREADY_FIXTURE = fixtureFile({ "https://api.github.com/repos/Acme/widget": { full_name: "Acme/widget", private: false } });
  try {
    const first = await check(makeRepo(files(scoped)), { online: true, repo: "Acme/widget" });
    assert.deepEqual(codes(first), ["PR106", "PR110"]);
    assert.match(first.findings.find((f) => f.code === "PR110").fix, /--access public/);
  } finally { delete process.env.PUBREADY_FIXTURE; }

  process.env.PUBREADY_FIXTURE = fixtureFile({
    "https://api.github.com/repos/Acme/widget": { full_name: "Acme/widget", private: true },
    "https://registry.npmjs.org/widget": { "dist-tags": { latest: "1.0.1" }, versions: { "1.0.0": {}, "1.0.1": {} } },
  });
  try {
    const taken = await check(makeRepo(files({ ...GOOD_PKG, publishConfig: { provenance: true } })), { online: true, repo: "Acme/widget" });
    assert.deepEqual(codes(taken), ["PR070", "PR111"]);
    const noProv = await check(makeRepo(files({ ...GOOD_PKG, version: "1.0.2" })), { online: true, repo: "Acme/widget" });
    assert.deepEqual(codes(noProv), ["PR071"]);
  } finally { delete process.env.PUBREADY_FIXTURE; }
});

test("online lookups that fail become notes, not findings", async () => {
  process.env.PUBREADY_FIXTURE = fixtureFile({ "https://api.github.com/repos/Acme/widget": { __status: 403 }, "https://registry.npmjs.org/widget": { __status: 500 } });
  try {
    const r = await check(makeRepo(files(GOOD_PKG)), { online: true, repo: "Acme/widget" });
    assert.deepEqual(codes(r), []);
    assert.equal(r.notes.length, 2);
  } finally { delete process.env.PUBREADY_FIXTURE; }
});

test("scoped package offline without access public", async () => {
  const r = await check(makeRepo(files({ ...GOOD_PKG, name: "@acme/widget" })), opts);
  assert.deepEqual(codes(r), ["PR106"]);
  const ok = await check(makeRepo(files({ ...GOOD_PKG, name: "@acme/widget", publishConfig: { access: "public" } })), opts);
  assert.deepEqual(codes(ok), []);
});

test("monorepo: every workspace package is checked, private ones skipped", async () => {
  const wf = GOOD_WORKFLOW.replace("npm stage publish", "npm publish --workspaces");
  const dir = makeRepo({
    "package.json": { name: "root", private: true, workspaces: ["packages/*"] },
    "packages/a/package.json": { name: "a", version: "1.0.0", repository: { type: "git", url: "git+https://github.com/Acme/widget.git", directory: "packages/a" } },
    "packages/b/package.json": { name: "b", version: "1.0.0", repository: { type: "git", url: "git+https://github.com/Acme/widget.git" } },
    "packages/c/package.json": { name: "c", private: true },
    ".github/workflows/release.yml": wf,
  });
  const r = await check(dir, opts);
  assert.deepEqual(codes(r), ["PR060", "PR105"]);
  assert.deepEqual(r.settings.map((s) => s.package).sort(), ["a", "b"]);
});

test("pnpm-workspace.yaml + changeset publish", async () => {
  const wf = GOOD_WORKFLOW.replace("npm stage publish", "pnpm changeset publish");
  const dir = makeRepo({
    "package.json": { name: "root", private: true },
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "packages/x/package.json": { name: "x", version: "0.1.0" },
    ".github/workflows/release.yml": wf,
  });
  const r = await check(dir, opts);
  assert.ok(codes(r).includes("PR101"));
  assert.ok(r.settings.some((s) => s.package === "x"));
});

test("working-directory picks the right package", async () => {
  const wf = GOOD_WORKFLOW.replace("      - run: npm stage publish\n", "      - run: npm stage publish\n        working-directory: lib\n");
  const dir = makeRepo({ "package.json": { name: "root", private: true }, "lib/package.json": { ...GOOD_PKG, repository: { type: "git", url: "git+https://github.com/Acme/widget.git", directory: "lib" } }, ".github/workflows/release.yml": wf });
  const r = await check(dir, opts);
  assert.deepEqual(codes(r), []);
  assert.equal(r.settings[0].package, "widget");
});

test("GitLab CI: missing id_tokens, old image", async () => {
  const gl = "publish:\n  image: node:20\n  script:\n    - npm ci\n    - npm publish\n";
  const dir = makeRepo({ "package.json": { ...GOOD_PKG, repository: "https://gitlab.com/Acme/widget" }, ".gitlab-ci.yml": gl }, { remote: "https://gitlab.com/Acme/widget.git" });
  const r = await check(dir, { online: false });
  assert.deepEqual(codes(r), ["PR030", "PR201"]);
  assert.equal(r.settings[0].provider, "GitLab CI/CD");
  const good = gl.replace("node:20", "node:24") + '  id_tokens:\n    NPM_ID_TOKEN:\n      aud: "npm:registry.npmjs.org"\n    SIGSTORE_ID_TOKEN:\n      aud: sigstore\n';
  const r2 = await check(makeRepo({ "package.json": { ...GOOD_PKG, repository: "https://gitlab.com/Acme/widget" }, ".gitlab-ci.yml": good }, { remote: "https://gitlab.com/Acme/widget.git" }), { online: false });
  assert.deepEqual(codes(r2), []);
});

test("many packages with the same problem collapse into one finding", async () => {
  const wf = GOOD_WORKFLOW.replace("npm stage publish", "npm publish --workspaces");
  const files = { "package.json": { name: "root", private: true, workspaces: ["packages/*"] }, ".github/workflows/release.yml": wf };
  for (const n of ["a", "b", "c", "d", "e"]) files[`packages/${n}/package.json`] = { name: n, version: "1.0.0", repository: { type: "git", url: "git+https://github.com/Acme/widget.git" } };
  const r = await check(makeRepo(files), opts);
  assert.deepEqual(codes(r), ["PR060", "PR105"]);
  assert.match(r.findings.find((f) => f.code === "PR105").detail, /^5 packages/);
});

test("changeset publish skips already-published versions, so no PR111", async () => {
  const wf = GOOD_WORKFLOW.replace("npm stage publish", "npx changeset publish");
  process.env.PUBREADY_FIXTURE = fixtureFile({
    "https://api.github.com/repos/Acme/widget": { full_name: "Acme/widget", private: false },
    "https://registry.npmjs.org/widget": { "dist-tags": { latest: "1.0.1" }, versions: { "1.0.1": {} } },
  });
  try {
    const r = await check(makeRepo({ "package.json": GOOD_PKG, ".github/workflows/release.yml": wf }), { online: true, repo: "Acme/widget" });
    assert.ok(!codes(r).includes("PR111"));
  } finally { delete process.env.PUBREADY_FIXTURE; }
});
