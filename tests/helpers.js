import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";


// tests must not pick up the CI run's own repo identity
delete process.env.GITHUB_REPOSITORY;
delete process.env.CI_PROJECT_PATH;
delete process.env.PUBREADY_FIXTURE;
export const BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "bin", "pubready.js");

/** Make a throwaway repo from {relpath: content}; objects are JSON-encoded. */
export function makeRepo(files, { remote } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pubready-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

export function fixtureFile(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pubready-fx-")), "online.json");
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

export const GOOD_WORKFLOW = `name: release
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm stage publish
`;

export const GOOD_PKG = {
  name: "widget",
  version: "1.0.1",
  repository: { type: "git", url: "git+https://github.com/Acme/widget.git" },
};

export function codes(report) {
  return report.findings.map((f) => f.code).sort();
}

export function run(args, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], { cwd: opts.cwd, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "", GITHUB_REPOSITORY: "", ...(opts.env || {}) }, input: opts.input, stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out: out.toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "").toString(), err: (e.stderr || "").toString() };
  }
}
