// Map a failed publish log to what actually went wrong.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseVer, cmp, MIN_NPM, fmt } from "./versions.js";

const STALE_TOKEN = /Access token expired or revoked/i;

const DIAGNOSES = [
  {
    id: "repository-url",
    re: /"repository\.url" is "([^"]*)", expected to match "([^"]+)" from provenance/,
    build(m) {
      const [, got, want] = m;
      const norm = (u) => u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/$/, "");
      if (!got) return { title: "package.json has no repository.url (E422)", causes: [`npm wants repository.url to match ${want}, the repo named in the provenance.`], fixes: [`add to package.json:\n  "repository": { "type": "git", "url": "git+${want}.git" }`, "monorepo packages also need \"directory\": \"packages/<name>\""] };
      if (norm(got).toLowerCase() === norm(want).toLowerCase()) {
        return { title: "repository.url has the wrong letter case (E422)", causes: [`package.json: ${got}`, `GitHub:       ${want}`, "npm compares them case-sensitively (npm/cli#8036)."], fixes: [`set repository.url to "git+${want}.git"`] };
      }
      return { title: "repository.url points at a different repo (E422)", causes: [`package.json: ${got}`, `published from: ${want}`, "Typical after forking or renaming a repo."], fixes: [`set repository.url to "git+${want}.git"`] };
    },
  },
  {
    id: "put-404",
    re: /404 Not Found - PUT (https?:\/\/\S+)/,
    build(m, ctx) {
      const causes = [];
      if (ctx.staleToken) causes.unshift("npm used a long-lived token (\"Access token expired or revoked\" is in the log) instead of OIDC: remove NODE_AUTH_TOKEN/NPM_TOKEN from the publish step.");
      if (ctx.npm && cmp(ctx.npm, MIN_NPM) < 0) causes.unshift(`npm ${fmt(ctx.npm)} is in the log: OIDC needs npm 11.5.1+ (Node 24+, or \`npm install -g npm@latest\`). This is the most common cause.`);
      causes.push(
        "the job lacks `permissions: id-token: write`",
        "the trusted publisher on npmjs.com doesn't match exactly: owner/repo case, workflow filename (.yml vs .yaml), environment",
        "the publish runs inside a reusable workflow: npm needs the *calling* workflow's filename",
        "the package doesn't exist on npm yet (first publish must be manual)",
        "trusted publisher created after 3 Sep 2026 without \"Allow npm publish\" (only `npm stage publish` allowed)",
      );
      return { title: `npm says 404 on publish (${decodeURIComponent(m[1].split("/").pop())}): it didn't authenticate with OIDC`, causes, fixes: ["run `npx github:hamarshehmhmd/pubready` in the repo to see which of these applies"] };
    },
  },
  {
    id: "eneedauth",
    re: /code ENEEDAUTH|need auth This command requires you to be logged in|requires you to be logged in/,
    build(m, ctx) {
      const causes = [];
      if (ctx.npm && cmp(ctx.npm, MIN_NPM) < 0) causes.push(`npm ${fmt(ctx.npm)} can't do OIDC (needs 11.5.1+)`);
      causes.push("no `id-token: write` permission", "workflow filename / repo / environment on npmjs.com don't match (all case-sensitive)", "trusted publisher created after 3 Sep 2026 allows only `npm stage publish` until you tick \"Allow npm publish\"", "trusted publisher config expired: it must complete a first publish within 2 days of creation", "self-hosted runner (not supported)");
      return { title: "ENEEDAUTH: npm had no credentials, so the OIDC exchange didn't happen", causes, fixes: ["run `npx github:hamarshehmhmd/pubready` in the repo to rule out the workflow side, then re-check the trusted publisher on npmjs.com"] };
    },
  },
  {
    id: "id-token",
    re: /ACTIONS_ID_TOKEN_REQUEST_URL|requires "write" access to the "id-token" permission/,
    build: () => ({ title: "The job can't mint an OIDC token", causes: ["`id-token: write` is missing from the job's (or calling workflow's) permissions"], fixes: ["permissions:\n  contents: read\n  id-token: write"] }),
  },
  {
    id: "stale-token",
    re: STALE_TOKEN,
    build: () => ({ title: "A stale npm token was used", causes: ["NODE_AUTH_TOKEN / NPM_TOKEN or an .npmrc _authToken is still set, and npm tried it"], fixes: ["remove the token from the publish step; with npm 11.5.1+ and id-token: write, OIDC needs no token"] }),
  },
  {
    id: "private-provenance",
    re: /Unsupported GitHub Actions source repository visibility: private|provenance.*private repositor/i,
    build: () => ({ title: "Provenance from a private repository", causes: ["npm can't generate provenance for private repos, but --provenance / publishConfig.provenance asked for it"], fixes: ["drop --provenance (or set NPM_CONFIG_PROVENANCE=false)"] }),
  },
  {
    id: "republish",
    re: /cannot publish over the previously published versions?(?::\s*(\S+))?/i,
    build: (m) => ({ title: `Version already on npm${m[1] ? ` (${m[1]})` : ""} (E403)`, causes: ["the version in package.json was published before"], fixes: ["bump the version"] }),
  },
  {
    id: "two-factor",
    re: /Two-factor authentication or granular access token with bypass 2fa enabled is required/i,
    build: () => ({ title: "npm got a token, not OIDC (E403 2FA)", causes: ["a token without bypass-2FA was used, often because OIDC didn't kick in (npm < 11.5.1, no id-token permission)"], fixes: ["make OIDC work and remove the token"] }),
  },
  {
    id: "payment",
    re: /402 Payment Required|You must sign up for private packages/i,
    build: () => ({ title: "Scoped package published as private (E402)", causes: ["scoped packages default to restricted access on first publish"], fixes: ['"publishConfig": { "access": "public" } or npm publish --access public'] }),
  },
  {
    id: "dist-tag",
    re: /cannot manage dist-tags/i,
    build: () => ({ title: "Trusted publisher isn't allowed to manage dist-tags", causes: ["\"Allow npm dist-tag\" is off for this trusted publisher (it's off by default)"], fixes: ["tick \"Allow npm dist-tag\" on npmjs.com and use npm 11.21.0+"] }),
  },
  {
    id: "stage-only",
    re: /(only|not) (allowed|permitted).{0,60}(stage publish|publish directly)|stage publish.{0,60}(only|required)/i,
    build: () => ({ title: "Trusted publisher only allows staged publishing", causes: ["publishers created after 3 Sep 2026 allow `npm stage publish` by default"], fixes: ["tick \"Allow npm publish\" or run `npm stage publish`"] }),
  },
];

function versions(text) {
  const npm = text.match(/(?:\bnpm:\s*|npm\/|npm v)(\d+\.\d+\.\d+)/);
  const node = text.match(/(?:\bnode:\s*v?|node\/v|Node\.js v)(\d+\.\d+\.\d+)/);
  let npmV = npm ? parseVer(npm[1]) : null;
  // a later `npm install -g npm@X` in the log replaces the bundled npm
  const ups = [...text.matchAll(/npm\s+(?:i|install|update)\s+(?:-g|--global)\s+npm(?:@(\S+))?|npm\s+(?:i|install)\s+npm(?:@(\S+))?\s+(?:-g|--global)/g)];
  let upgraded = null;
  if (ups.length) {
    const spec = ups[ups.length - 1][1] || ups[ups.length - 1][2] || "latest";
    upgraded = spec;
    const v = parseVer(spec);
    npmV = v && v[1] != null ? [v[0], v[1], v[2] || 0] : null;
  }
  return { npm: npmV, node: node ? parseVer(node[1]) : null, npmUpgrade: upgraded };
}

export function explainText(text) {
  const lines = String(text).split(/\r?\n/);
  const ctx = { ...versions(text), staleToken: STALE_TOKEN.test(text) };
  const found = [];
  for (const d of DIAGNOSES) {
    const idx = lines.findIndex((l) => d.re.test(l));
    if (idx < 0) continue;
    if (d.id === "stale-token" && found.some((f) => f.id === "put-404")) continue;
    const m = lines[idx].match(d.re);
    found.push({ id: d.id, line: idx + 1, evidence: lines[idx].replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "").trim().slice(0, 300), ...d.build(m, ctx) });
  }
  return { npm: ctx.npm, node: ctx.node, npmUpgrade: ctx.npmUpgrade, diagnoses: found };
}

export function loadLog(src) {
  if (src === "-") return fs.readFileSync(0, "utf8");
  const m = String(src).match(/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  if (m) {
    const args = m[3] ? ["run", "view", "--repo", m[1], "--job", m[3], "--log-failed"] : ["run", "view", m[2], "--repo", m[1], "--log-failed"];
    try {
      return execFileSync("gh", args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
    } catch (e) {
      throw new Error(`couldn't fetch the run log with gh (${(e.stderr || e.message).toString().trim().split("\n")[0]}); download it and pass the file instead`);
    }
  }
  return fs.readFileSync(src, "utf8");
}
