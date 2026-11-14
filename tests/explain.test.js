import { test } from "node:test";
import assert from "node:assert/strict";
import { explainText } from "../src/explain.js";

const ids = (t) => explainText(t).diagnoses.map((d) => d.id);

test("E422 casing (npm/cli#8036 log)", () => {
  const log = `npm notice publish Signed provenance statement with source and build information from GitHub Actions
npm error code E422
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/create-creator - Error verifying sigstore provenance bundle: Failed to validate repository information: package.json: "repository.url" is "git+https://github.com/frontenddev-org/create-creator.git", expected to match "https://github.com/FrontEndDev-org/create-creator" from provenance`;
  const r = explainText(log);
  assert.equal(r.diagnoses[0].id, "repository-url");
  assert.match(r.diagnoses[0].title, /letter case/);
  assert.equal(r.diagnoses[0].line, 3);
});

test("E422 missing repository and fork", () => {
  assert.match(explainText(`"repository.url" is "", expected to match "https://github.com/a/b" from provenance`).diagnoses[0].title, /no repository/);
  assert.match(explainText(`"repository.url" is "git+https://github.com/orig/b.git", expected to match "https://github.com/fork/b" from provenance`).diagnoses[0].title, /different repo/);
});

test("E404 with npm 10 in the log points at the npm version first", () => {
  const log = `Environment details
  node: v20.19.6
  npm: 10.8.2
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/@sass%2ftypes - Not found`;
  const r = explainText(log);
  assert.deepEqual(r.npm, [10, 8, 2]);
  assert.equal(r.diagnoses[0].id, "put-404");
  assert.match(r.diagnoses[0].causes[0], /npm 10\.8\.2/);
  assert.match(r.diagnoses[0].title, /@sass\/types/);
});

test("E404 with a stale token", () => {
  const log = "npm notice Access token expired or revoked. Please try logging in again.\nnpm error 404 Not Found - PUT https://registry.npmjs.org/x - Not found";
  const r = explainText(log);
  assert.deepEqual(r.diagnoses.map((d) => d.id), ["put-404"]);
  assert.match(r.diagnoses[0].causes[0], /long-lived token/);
});

test("other known failures", () => {
  assert.deepEqual(ids("npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in to https://registry.npmjs.org/"), ["eneedauth"]);
  assert.deepEqual(ids("Error: Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable"), ["id-token"]);
  assert.deepEqual(ids("npm error 403 403 Forbidden - PUT https://registry.npmjs.org/x - You cannot publish over the previously published versions: 1.2.3."), ["republish"]);
  assert.deepEqual(ids("npm error 402 Payment Required - PUT https://registry.npmjs.org/@a%2fb - You must sign up for private packages"), ["payment"]);
  assert.deepEqual(ids("Unsupported GitHub Actions source repository visibility: private"), ["private-provenance"]);
  assert.deepEqual(ids("everything is fine"), []);
});

test("an npm self-upgrade in the log replaces the bundled npm version", () => {
  const log = `  node: v22.19.0
  npm: 10.9.3
##[group]Run npm install -g npm@11.21.2
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/`;
  const r = explainText(log);
  assert.deepEqual(r.npm, [11, 21, 2]);
  assert.ok(!r.diagnoses[0].causes.some((c) => /can't do OIDC/.test(c)));
  assert.ok(r.diagnoses[0].causes.some((c) => /Allow npm publish/.test(c)));
});
