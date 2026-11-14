// Find npm publish jobs in GitHub Actions workflows and check the job side of trusted publishing.
import fs from "node:fs";
import path from "node:path";
import { loadYaml, lineOfKey, lineOfItem } from "./yamlload.js";
import { findPublishes, findDistTag, findNpmUpgrade } from "./detect.js";
import { finding } from "./rules.js";
import { readPackage } from "./pkg.js";
import {
  resolveNodeSpec, bundledNpmSupportsOidc, nodeMeetsMinimum, resolveNpmSpec, npmSupportsOidc, npmSupportsDistTag, bundledNpm, fmt,
} from "./versions.js";

const TOKEN_ENV = /^(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN|NPM_CONFIG__AUTH|NPM_CONFIG_TOKEN|npm_config__authToken)$/i;

export function loadWorkflows(root) {
  const dir = path.join(root, ".github", "workflows");
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort(); } catch { return out; }
  for (const f of files) {
    const abs = path.join(dir, f);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const text = fs.readFileSync(abs, "utf8");
    try {
      out.push({ file: f, rel, text, data: loadYaml(text) || {} });
    } catch (e) {
      out.push({ file: f, rel, text, data: null, error: e.message, errorLine: e.line });
    }
  }
  return out;
}

function triggers(wf) {
  const on = wf.data && (wf.data.on !== undefined ? wf.data.on : wf.data.true); // YAML 1.1 "on" -> true in some parsers
  if (!on) return [];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
}

/** Does a `permissions:` value grant id-token: write? true / false / undefined (not set). */
function grantsIdToken(perms) {
  if (perms === undefined) return undefined;
  if (perms === null) return false;
  if (typeof perms === "string") return perms === "write-all";
  if (typeof perms === "object") return perms["id-token"] === "write";
  return false;
}

function envTokens(envObj, file, lineBase) {
  const hits = [];
  if (!envObj || typeof envObj !== "object") return hits;
  for (const [k, v] of Object.entries(envObj)) {
    if (TOKEN_ENV.test(k) && /secrets\./.test(String(v))) hits.push({ name: k, value: String(v), file, line: lineOfKey(envObj, k) || lineBase });
  }
  return hits;
}

function runsOnLabels(runsOn) {
  if (!runsOn) return [];
  if (typeof runsOn === "string") return [runsOn];
  if (Array.isArray(runsOn)) return runsOn.map(String);
  if (typeof runsOn === "object") {
    const labels = runsOn.labels ? [].concat(runsOn.labels) : [];
    if (runsOn.group) labels.push(`group:${runsOn.group}`);
    return labels.map(String);
  }
  return [String(runsOn)];
}

function readNodeVersionFile(root, file) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, "utf8");
  if (path.basename(file) === "package.json") {
    try {
      const pj = JSON.parse(text);
      return (pj.volta && pj.volta.node) || (pj.devEngines && pj.devEngines.runtime && pj.devEngines.runtime.version) || (pj.engines && pj.engines.node) || null;
    } catch { return null; }
  }
  if (path.basename(file) === ".tool-versions") {
    const m = text.match(/^\s*(?:nodejs|node)\s+(\S+)/m);
    return m ? m[1] : null;
  }
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return first || null;
}

function matrixValues(job, expr) {
  const m = String(expr).match(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/);
  if (!m || !job.strategy || !job.strategy.matrix || typeof job.strategy.matrix !== "object") return null;
  const key = m[1];
  const vals = [];
  const mx = job.strategy.matrix;
  if (Array.isArray(mx[key])) vals.push(...mx[key]);
  else if (mx[key] !== undefined && typeof mx[key] !== "object") vals.push(mx[key]);
  for (const inc of [].concat(mx.include || [])) if (inc && inc[key] !== undefined) vals.push(inc[key]);
  return vals.length ? vals.map(String) : null;
}

/** Steps of a local composite action, with ${{ inputs.x }} replaced by the input defaults. */
function loadLocalAction(root, uses) {
  const dir = path.resolve(root, uses.replace(/@.*$/, ""));
  for (const name of ["action.yml", "action.yaml"]) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    try {
      const a = loadYaml(fs.readFileSync(f, "utf8")) || {};
      if (!a.runs || a.runs.using !== "composite" || !Array.isArray(a.runs.steps)) return null;
      const defaults = {};
      for (const [k, v] of Object.entries(a.inputs || {})) if (v && v.default !== undefined) defaults[k] = String(v.default);
      const sub = (v) => (typeof v === "string" ? v.replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (m, k) => (k in defaults ? defaults[k] : m)) : v);
      return { steps: a.runs.steps.map((st) => {
        if (!st || typeof st !== "object") return {};
        const w = {};
        for (const [k, v] of Object.entries(st.with || {})) w[k] = sub(v);
        return { ...st, with: w, run: sub(st.run) };
      }) };
    } catch { return null; }
  }
  return null;
}

/** Work out Node and npm for the publish step at index `upto` of a job. */
export function toolchain(root, job, upto) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const res = { nodeSpecs: [], nodeSource: null, npmUpgrade: null, npmUpgradeLine: null, registryUrl: null, setupNodeLine: null };
  const image = job.container ? (typeof job.container === "string" ? job.container : job.container.image) : null;
  if (image) {
    const m = String(image).match(/(?:^|\/)node:([\w.-]+)/);
    if (m) { res.nodeSpecs = [m[1].replace(/-(alpine|slim|bookworm|bullseye|trixie|buster).*$/, "")]; res.nodeSource = `container ${image}`; }
  }
  // expand local composite actions (uses: ./.github/actions/x) in place
  const flat = [];
  for (let i = 0; i <= upto && i < steps.length; i++) {
    const s = steps[i] || {};
    const local = typeof s.uses === "string" && s.uses.startsWith("./") ? loadLocalAction(root, s.uses) : null;
    if (local) for (const cs of local.steps) flat.push({ step: cs, line: lineOfItem(steps, i), via: s.uses });
    else flat.push({ step: s, line: lineOfItem(steps, i) });
  }
  for (const { step: s, line, via } of flat) {
    if (typeof s.uses === "string" && /^actions\/setup-node@/i.test(s.uses)) {
      const w = s.with || {};
      res.setupNodeLine = line;
      res.setupNodeVia = via;
      res.registryUrl = w["registry-url"] || null;
      if (w["node-version"] !== undefined) {
        const spec = String(w["node-version"]);
        res.nodeSpecs = matrixValues(job, spec) || [spec];
        res.nodeSource = `actions/setup-node node-version: ${spec}${via ? ` in ${via}` : ""}`;
      } else if (w["node-version-file"]) {
        const v = readNodeVersionFile(root, String(w["node-version-file"]));
        res.nodeSpecs = v ? [v] : [];
        res.nodeSource = `actions/setup-node node-version-file: ${w["node-version-file"]}${v ? ` (${v})` : " (not found)"}${via ? ` in ${via}` : ""}`;
      } else {
        res.nodeSpecs = [];
        res.nodeSource = "actions/setup-node without node-version (uses the runner's Node)";
      }
    }
    const up = findNpmUpgrade(s.run);
    if (up) { res.npmUpgrade = up; res.npmUpgradeLine = line; }
  }
  return res;
}

function workingDir(root, wfData, job, step) {
  const d = (step && step["working-directory"]) || (job.defaults && job.defaults.run && job.defaults.run["working-directory"]) ||
    (wfData.defaults && wfData.defaults.run && wfData.defaults.run["working-directory"]) || ".";
  return /\$\{\{/.test(String(d)) ? root : path.resolve(root, String(d));
}

/** Entry workflows (what npm sees as the "workflow filename") for a workflow, following local `uses:` callers. */
function entryChains(wf, callers, seen = new Set()) {
  const list = callers.get(wf.file) || [];
  if (!list.length || seen.has(wf.file)) return [[]];
  seen.add(wf.file);
  const out = [];
  for (const c of list) for (const chain of entryChains(c.wf, callers, new Set(seen))) out.push([...chain, c]);
  return out;
}

export function analyzeGithub(root) {
  const workflows = loadWorkflows(root);
  const findings = [];
  const sites = [];
  const callers = new Map();
  for (const wf of workflows) {
    if (wf.error) {
      findings.push(finding("PR002", { file: wf.rel, line: wf.errorLine, detail: wf.error }));
      continue;
    }
    for (const [jobId, job] of Object.entries((wf.data && wf.data.jobs) || {})) {
      if (job && typeof job.uses === "string") {
        const m = job.uses.match(/^\.\/\.github\/workflows\/([^@\s]+\.ya?ml)$/);
        if (m) {
          if (!callers.has(m[1])) callers.set(m[1], []);
          callers.get(m[1]).push({ wf, jobId, job, line: lineOfKey(wf.data.jobs, jobId) });
        }
      }
    }
  }
  const rootPkg = readPackage(root);
  for (const wf of workflows) {
    if (!wf.data || !wf.data.jobs) continue;
    for (const [jobId, job] of Object.entries(wf.data.jobs)) {
      if (!job || !Array.isArray(job.steps)) continue;
      job.steps.forEach((step, idx) => {
        if (!step) return;
        const wd = workingDir(root, wf.data, job, step);
        const pkg = readPackage(wd) || rootPkg;
        const scripts = (pkg && pkg.data && pkg.data.scripts) || {};
        let pubs = findPublishes(step.run, scripts);
        const csPublish = step.with && (step.with.publish || step.with["publish-script"]);
        if (typeof step.uses === "string" && /^changesets\/action@/i.test(step.uses) && csPublish) {
          pubs = findPublishes(String(csPublish), scripts).map((p) => ({ ...p, via: ["changesets/action", ...p.via], wrapper: "changesets/action" }));
        }
        if (typeof step.uses === "string" && /^JS-DevTools\/npm-publish@/i.test(step.uses)) {
          pubs = [{ tool: "action", command: step.uses, via: [], wrapper: step.uses }];
        }
        if (!pubs.length) return;
        sites.push({ wf, jobId, job, step, stepIndex: idx, line: lineOfItem(job.steps, idx), workdir: wd, pkg, pubs });
      });
    }
  }

  const trusted = [];
  for (const site of sites) {
    const { wf, jobId, job, step, stepIndex } = site;
    const at = { file: wf.rel, line: site.line, job: jobId };
    const isReusable = triggers(wf).includes("workflow_call");
    const chains = isReusable ? entryChains(wf, callers) : [[]];
    const environment = job.environment ? (typeof job.environment === "string" ? job.environment : job.environment.name) : null;
    site.environment = environment;

    // permissions: job-level wins over workflow-level; a reusable workflow is capped by its caller.
    const own = grantsIdToken(job.permissions) ?? grantsIdToken(wf.data.permissions);
    if (own === false) {
      findings.push(finding("PR010", { ...at, line: lineOfKey(job, "permissions") || lineOfKey(wf.data, "permissions") || at.line,
        detail: `job "${jobId}" sets permissions without \`id-token: write\`, so npm can't get an OIDC token and falls back to token auth (E404 / ENEEDAUTH).`,
        fix: `add to job "${jobId}":\n  permissions:\n    contents: read\n    id-token: write` }));
    } else if (own === undefined && !(isReusable && chains.some((c) => c.length))) {
      findings.push(finding("PR010", { ...at, line: lineOfKey(wf.data.jobs, jobId),
        detail: `no permissions block grants \`id-token: write\`; GitHub only hands out an OIDC token when a permissions block asks for it.`,
        fix: `add to job "${jobId}":\n  permissions:\n    contents: read\n    id-token: write` }));
    }
    const entries = [];
    if (isReusable) {
      const real = chains.filter((c) => c.length);
      if (!real.length) {
        findings.push(finding("PR013", { ...at, detail: `${wf.file} only runs via workflow_call and nothing in this repo calls it. If it's called from another repository, npm needs that repository and workflow filename, and package.json repository.url must match the repository whose workflow runs.` }));
        entries.push({ file: wf.file, rel: wf.rel });
      }
      for (const chain of real) {
        const top = chain[0];
        entries.push({ file: top.wf.file, rel: top.wf.rel });
        for (const c of chain) {
          const g = grantsIdToken(c.job.permissions) ?? grantsIdToken(c.wf.data.permissions);
          if (g !== true) {
            findings.push(finding("PR011", { file: c.wf.rel, line: c.line, job: c.jobId,
              detail: `job "${c.jobId}" calls ${wf.file} but ${g === false ? "its permissions leave out" : "nothing grants"} \`id-token: write\`; a called workflow can't get more permissions than its caller gives it.`,
              fix: `add to job "${c.jobId}" in ${c.wf.file}:\n  permissions:\n    contents: read\n    id-token: write` }));
          }
        }
        findings.push(finding("PR012", { ...at,
          detail: `${wf.file} is a reusable workflow called from ${top.wf.file}. The OIDC token names the top-level workflow, so the trusted publisher on npmjs.com must say "${top.wf.file}", not "${wf.file}".` }));
      }
    } else {
      entries.push({ file: wf.file, rel: wf.rel });
    }
    site.entries = entries;

    // runner
    const labels = runsOnLabels(job["runs-on"]);
    if (labels.some((l) => /self-hosted/i.test(l))) {
      findings.push(finding("PR020", { ...at, line: lineOfKey(job, "runs-on"), detail: `runs-on: ${labels.join(", ")}. npm only accepts OIDC tokens from GitHub-hosted runners today.`, fix: "publish from a GitHub-hosted runner (ubuntu-latest), e.g. a separate small publish job." }));
    }

    // toolchain
    const tc = toolchain(root, job, stepIndex);
    site.toolchain = tc;
    const npmFromNpx = site.pubs.map((p) => p.npmSpec).find(Boolean);
    const upgrade = npmFromNpx || tc.npmUpgrade;
    const upgradedTo = upgrade ? resolveNpmSpec(upgrade) : null;
    const usesNpmCli = site.pubs.some((p) => ["npm", "npm-stage", "changeset", "lerna", "semantic-release"].includes(p.tool));
    if (!tc.nodeSpecs.length) {
      if (usesNpmCli && !(upgradedTo && npmSupportsOidc(upgradedTo))) {
        findings.push(finding("PR032", { ...at, detail: `${tc.nodeSource || "no actions/setup-node step or node container"}, so the publish runs on whatever Node the runner image ships (ubuntu images have shipped Node 20 + npm 10, which can't do OIDC).`,
          fix: "add before the publish step:\n  - uses: actions/setup-node@v6\n    with:\n      node-version: 24\n      registry-url: https://registry.npmjs.org" }));
      }
    } else {
      const bad = [];
      const badNpm = [];
      const unknown = [];
      for (const spec of tc.nodeSpecs) {
        const node = resolveNodeSpec(spec);
        if (node.unknown) { unknown.push(spec); continue; }
        if (nodeMeetsMinimum(node) === false) bad.push(spec);
        else if (usesNpmCli && !upgradedTo && bundledNpmSupportsOidc(node) === false) badNpm.push(`${spec} (bundles npm ${fmt(bundledNpm(node))})`);
      }
      if (bad.length) {
        findings.push(finding("PR030", { ...at, line: tc.setupNodeLine || at.line, detail: `publish runs on Node ${bad.join(", ")} (${tc.nodeSource}); trusted publishing needs Node 22.14.0+ and npm 11.5.1+. With an older npm the publish silently uses token auth and fails with E404 "Not found".`,
          fix: "use node-version: 24 (or newer) in actions/setup-node for the publish job" }));
      } else if (badNpm.length) {
        findings.push(finding("PR031", { ...at, line: tc.setupNodeLine || at.line, detail: `Node ${badNpm.join(", ")}; npm needs 11.5.1+ for OIDC. Node 22 ships npm 10.9, so it publishes with token auth and fails with E404.`,
          fix: "use node-version: 24 (or newer), or add `- run: npm install -g npm@latest` before publishing" }));
      }
      if (unknown.length && !bad.length && !badNpm.length && usesNpmCli && !(upgradedTo && npmSupportsOidc(upgradedTo))) {
        findings.push(finding("PR032", { ...at, line: tc.setupNodeLine || at.line, detail: `couldn't resolve node-version ${unknown.join(", ")}.`, fix: "make sure it resolves to Node 24+ for the publish job" }));
      }
    }
    if (upgradedTo && npmSupportsOidc(upgradedTo) === false && usesNpmCli) {
      findings.push(finding("PR031", { ...at, line: tc.npmUpgradeLine || at.line, detail: `the workflow pins npm@${upgrade}; OIDC needs npm 11.5.1+.`, fix: "npm install -g npm@latest" }));
    }
    // dist-tag over OIDC
    const steps = job.steps;
    for (let i = 0; i < steps.length; i++) {
      const dt = findDistTag(steps[i] && steps[i].run);
      if (!dt) continue;
      const nodes = tc.nodeSpecs.map(resolveNodeSpec);
      const npmV = upgradedTo || (nodes.length ? nodes.map(bundledNpm).filter(Boolean).sort()[0] : null);
      if (npmSupportsDistTag(npmV) !== true) {
        findings.push(finding("PR033", { file: wf.rel, line: lineOfItem(steps, i), job: jobId, detail: `\`${dt}\` with npm ${npmV ? fmt(npmV) : "(unknown)"}; dist-tag over OIDC needs npm 11.21.0+ (12.2.0+ on 12.x), and "Allow npm dist-tag" ticked on the trusted publisher. No Node release bundles that npm yet.`,
          fix: "add `- run: npm install -g npm@latest` before it" }));
      }
    }
    // static tokens
    const tokens = [
      ...envTokens(wf.data.env, wf.rel, lineOfKey(wf.data, "env")),
      ...envTokens(job.env, wf.rel, lineOfKey(job, "env")),
      ...envTokens(step.env, wf.rel, site.line),
    ];
    if (tokens.length) {
      const t = tokens[0];
      findings.push(finding("PR040", { file: t.file, line: t.line, job: jobId,
        detail: `${tokens.map((x) => `${x.name}: ${x.value}`).join(", ")} is set for the publish step. If that secret is expired or revoked, npm reports "Access token expired or revoked" / E404 instead of using OIDC, and once you switch the package to "disallow tokens" it's dead weight.`,
        fix: "remove the token env from the publish step (keep a read-only token only on `npm ci` if you have private deps), then revoke the token on npmjs.com" }));
    }
    for (let i = 0; i <= stepIndex; i++) {
      const r = steps[i] && steps[i].run;
      if (r && /_authToken\s*=|npm\s+config\s+set\s+\S*_authToken/.test(r) && /npmjs/.test(r)) {
        findings.push(finding("PR041", { file: wf.rel, line: lineOfItem(steps, i), job: jobId, detail: "this step writes an npm auth token into .npmrc before publishing; npm will use it instead of trusted publishing.", fix: "delete the step (setup-node's registry-url is enough)" }));
      }
    }
    // tools
    for (const p of site.pubs) {
      const via = p.via && p.via.length ? `${p.via.join(" → ")} → ` : "";
      if (p.tool === "yarn-classic") {
        findings.push(finding("PR050", { ...at, detail: `${via}\`${p.command}\`: Yarn 1 publishes with its own client and has no trusted-publishing support.`, fix: "publish with `npm publish` (run it in the package directory) on Node 24+" }));
      } else if (["yarn-berry", "pnpm", "bun"].includes(p.tool)) {
        findings.push(finding("PR051", { ...at, detail: `${via}\`${p.command}\`: npm's docs only cover the npm CLI. pubready can't confirm your ${p.tool.replace("-berry", " (Berry)")} version does the OIDC exchange; if you see E404/ENEEDAUTH, publish the packed tarball with \`npm publish\` instead.` }));
      } else if (p.tool === "lerna") {
        const v = site.pkg && site.pkg.data && ((site.pkg.data.devDependencies || {}).lerna || (site.pkg.data.dependencies || {}).lerna);
        const major = v ? Number((String(v).match(/\d+/) || [])[0]) : null;
        if (major && major < 9) findings.push(finding("PR050", { ...at, detail: `${via}\`${p.command}\` with lerna ${v}; lerna only supports OIDC trusted publishing from v9.`, fix: "upgrade lerna to 9+, or run `lerna exec --no-private -- npm publish`" }));
        else findings.push(finding("PR051", { ...at, detail: `${via}\`${p.command}\`: lerna supports OIDC from v9 (${v ? `you have ${v}` : "version not found in package.json"}). Some users still hit E404 with \`lerna publish\` and switched to \`lerna exec --no-private -- npm publish\`.` }));
      } else if (p.tool === "semantic-release" || p.tool === "action") {
        findings.push(finding("PR052", { ...at, detail: `${via}\`${p.command}\`: publishing goes through ${p.tool === "action" ? "an action" : "semantic-release's npm plugin"}; pubready checked the job (permissions, Node, tokens, package.json) but not the wrapper's own auth handling. Make sure your version supports trusted publishing.` }));
      } else if (p.wrapper === "changesets/action") {
        findings.push(finding("PR052", { ...at, detail: `changesets/action runs \`${p.command}\`; pubready checked the job but not the action's own .npmrc handling. If it complains about NPM_TOKEN, upgrade the action.` }));
      }
    }
    if (site.pubs.some((p) => p.tool === "npm" || p.tool === "changeset" || p.tool === "lerna")) {
      site.direct = true;
    }
    trusted.push(site);
  }
  if (sites.some((s) => s.direct)) {
    const s = sites.find((x) => x.direct);
    findings.push(finding("PR060", { file: s.wf.rel, line: s.line, job: s.jobId,
      detail: "This workflow publishes directly (`npm publish`). Trusted publishers created after 3 Sep 2026 only allow `npm stage publish` by default: tick \"Allow npm publish\" on the trusted publisher, or switch to `npm stage publish` and approve releases on npmjs.com." }));
  }
  return { workflows, sites: trusted, findings };
}
