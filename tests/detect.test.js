import { test } from "node:test";
import assert from "node:assert/strict";
import { findPublishes, findNpmUpgrade, findDistTag } from "../src/detect.js";
import { loadYaml, lineOfKey, lineOfItem } from "../src/yamlload.js";
import { parseRepository } from "../src/pkg.js";

test("finds publish commands for each tool", () => {
  const tool = (s) => (findPublishes(s)[0] || {}).tool;
  assert.equal(tool("npm publish --access public"), "npm");
  assert.equal(tool("npm stage publish"), "npm-stage");
  assert.equal(tool("npx -y npm@11.6.2 publish"), "npm");
  assert.equal(tool("pnpm -r publish --no-git-checks"), "pnpm");
  assert.equal(tool("yarn npm publish"), "yarn-berry");
  assert.equal(tool("yarn workspaces foreach -A npm publish"), "yarn-berry");
  assert.equal(tool("yarn publish --non-interactive"), "yarn-classic");
  assert.equal(tool("npx lerna publish from-package --yes"), "lerna");
  assert.equal(tool("pnpm changeset publish"), "changeset");
  assert.equal(tool("npx semantic-release"), "semantic-release");
  assert.equal(tool("bun publish"), "bun");
});

test("ignores dry runs, comments and lookalikes", () => {
  assert.deepEqual(findPublishes("npm publish --dry-run"), []);
  assert.deepEqual(findPublishes("# npm publish"), []);
  assert.deepEqual(findPublishes("npm run publish-docs"), []);
  assert.deepEqual(findPublishes("echo pnpm"), []);
});

test("follows package.json scripts including pre/post hooks", () => {
  const scripts = { release: "npm run build && changeset publish", build: "tsc", "postci:publish": "npm publish", "ci:publish": "echo hi" };
  const [p] = findPublishes("npm run release", scripts);
  assert.equal(p.tool, "changeset");
  assert.deepEqual(p.via, ["npm run release"]);
  const [h] = findPublishes("pnpm ci:publish", scripts);
  assert.equal(h.tool, "npm");
  assert.match(h.via[0], /postci:publish/);
});

test("script recursion terminates", () => {
  assert.deepEqual(findPublishes("npm run a", { a: "npm run b", b: "npm run a" }), []);
});

test("flags", () => {
  const [p] = findPublishes("npm publish --provenance --access public --workspaces");
  assert.equal(p.provenance, true);
  assert.equal(p.accessPublic, true);
  assert.equal(p.workspaces, true);
});

test("npm self-upgrade and dist-tag", () => {
  assert.equal(findNpmUpgrade("npm install -g npm@latest"), "latest");
  assert.equal(findNpmUpgrade("npm i --global npm@11.6.0"), "11.6.0");
  assert.equal(findNpmUpgrade("npm install npm@11 -g"), "11");
  assert.equal(findNpmUpgrade("npm install -g pnpm"), null);
  assert.equal(findDistTag("npm dist-tag add pkg@1.0.0 next"), "npm dist-tag add pkg@1.0.0 next");
});

test("yaml loader keeps line numbers and merges anchors", () => {
  const y = loadYaml("x: &a\n  k: 1\ny:\n  <<: *a\n  z: 2\nlist:\n  - one\n  - two\n");
  assert.deepEqual(y.y, { k: 1, z: 2 });
  assert.equal(lineOfKey(y, "y"), 3);
  assert.equal(lineOfItem(y.list, 1), 8);
});

test("repository parsing keeps case", () => {
  assert.deepEqual(
    (({ host, owner, repo }) => ({ host, owner, repo }))(parseRepository("git+https://github.com/FrontEndDev-org/create-creator.git")),
    { host: "github.com", owner: "FrontEndDev-org", repo: "create-creator" });
  assert.equal(parseRepository("github:Acme/w").owner, "Acme");
  assert.equal(parseRepository("Acme/w").host, "github.com");
  assert.equal(parseRepository({ url: "git@github.com:Acme/w.git", directory: "packages/w" }).directory, "packages/w");
  assert.equal(parseRepository("https://gitlab.com/group/sub/proj").owner, "group/sub");
  assert.equal(parseRepository(undefined), null);
});

test("a script literally named publish is followed with an explicit run", () => {
  const [p] = findPublishes("npm run publish", { publish: "changeset publish" });
  assert.equal(p.tool, "changeset");
});

test("script names that start with publish are scripts, not publishes", () => {
  assert.deepEqual(findPublishes("yarn publish-version 1.2.3"), []);
  assert.equal(findPublishes("yarn publish-version 1.2.3", { "publish-version": "npm publish --workspaces" })[0].tool, "npm");
  assert.deepEqual(findPublishes("npm publish:all"), []);
});
