// Put it together: publish sites -> packages -> package.json checks -> online checks -> trusted publisher settings.
import fs from "node:fs";
import path from "node:path";
import { analyzeGithub } from "./github.js";
import { analyzeGitlab } from "./gitlab.js";
import { finding } from "./rules.js";
import { readPackage, parseRepository, gitRoot, gitRemote, workspaceDirs, npmrcTokens, isScoped, jsonKeyLine } from "./pkg.js";
import { githubRepo, npmPackage } from "./online.js";

const LEVEL_ORDER = { error: 0, warn: 1, note: 2 };

function publishTargetDirs(root, site) {
  const dirs = new Set();
  const wide = site.pubs.some((p) => p.workspaces || ["changeset", "lerna"].includes(p.tool));
  site.wide = wide;
  if (wide) {
    for (const d of workspaceDirs(root)) dirs.add(d);
    if (!dirs.size) dirs.add(root);
    return [...dirs];
  }
  for (const p of site.pubs) {
    const m = p.command.match(/\bpublish\s+((?:\.{0,2}\/)?[\w@./-]+)/);
    if (m && !m[1].startsWith("-")) {
      const cand = path.resolve(site.workdir || root, m[1]);
      if (fs.existsSync(path.join(cand, "package.json"))) { dirs.add(cand); continue; }
    }
    dirs.add(site.workdir || root);
  }
  return [...dirs];
}

export function repoIdentity(root, opts = {}) {
  const spec = opts.repo || process.env.GITHUB_REPOSITORY;
  if (spec && /^[\w.-]+\/[\w.-]+$/.test(spec)) {
    const [owner, repo] = spec.split("/");
    return { host: "github.com", owner, repo, source: opts.repo ? "--repo" : "GITHUB_REPOSITORY" };
  }
  if (process.env.CI_PROJECT_PATH && process.env.CI_SERVER_HOST) {
    const parts = process.env.CI_PROJECT_PATH.split("/");
    return { host: process.env.CI_SERVER_HOST, repo: parts.pop(), owner: parts.join("/"), source: "CI_PROJECT_PATH" };
  }
  const r = gitRemote(root);
  if (r && r.owner) return { ...r, source: "git remote origin" };
  return null;
}

export async function check(dir, opts = {}) {
  const start = path.resolve(dir || ".");
  const hasCi = fs.existsSync(path.join(start, ".github", "workflows")) || fs.existsSync(path.join(start, ".gitlab-ci.yml"));
  const root = opts.root || (hasCi ? start : gitRoot(start) || start);
  const gh = analyzeGithub(root);
  const gl = analyzeGitlab(root);
  const findings = [...gh.findings, ...gl.findings];
  const sites = [...gh.sites.map((s) => ({ ...s, provider: "github" })), ...gl.sites];
  const ident = repoIdentity(root, opts);
  const online = opts.online !== false;
  const notes = [];
  let canonical = null;

  if (!sites.length) {
    findings.push(finding("PR001", { file: ".github/workflows", detail: "pubready looks for `npm publish` / `npm stage publish` / pnpm / yarn / lerna / changeset / semantic-release in GitHub Actions workflows and .gitlab-ci.yml (following package.json scripts). A custom script that calls npm publish from code isn't followed." }));
  }

  if (online && ident && ident.host === "github.com" && sites.some((s) => s.provider === "github")) {
    const r = await githubRepo(ident.owner, ident.repo);
    if (r.error) notes.push(`GitHub lookup skipped: ${r.error}`);
    else if (r.missing) notes.push(`GitHub says ${ident.owner}/${ident.repo} doesn't exist (or is private and no GITHUB_TOKEN was given)`);
    else canonical = r;
  }
  const want = canonical ? { host: "github.com", owner: canonical.owner, repo: canonical.repo } : ident;

  // package checks
  const pkgs = new Map();
  for (const site of sites) {
    site.packages = [];
    for (const d of publishTargetDirs(root, site)) {
      const p = readPackage(d);
      if (!p) continue;
      site.packages.push(p);
      if (!pkgs.has(p.file)) pkgs.set(p.file, { pkg: p, sites: [] });
      pkgs.get(p.file).sites.push(site);
    }
  }
  const tokenHits = npmrcTokens([root, ...[...pkgs.values()].map((x) => x.pkg.dir)]);
  for (const h of tokenHits) {
    findings.push(finding("PR041", { file: path.relative(root, h.file) || ".npmrc", line: h.line, detail: `\`${h.text}\`: a static token in .npmrc wins over trusted publishing.`, fix: "remove the auth line from the committed .npmrc" }));
  }

  const packages = [];
  for (const { pkg, sites: pSites } of pkgs.values()) {
    const rel = path.relative(root, pkg.file).split(path.sep).join("/");
    const d = pkg.data || {};
    const info = { name: d.name, version: d.version, file: rel, sites: pSites };
    packages.push(info);
    if (pkg.error) { findings.push(finding("PR002", { file: rel, detail: pkg.error })); continue; }
    if (d.private === true && pSites.every((s) => s.wide)) { info.skipped = true; continue; }
    if (d.private === true) { findings.push(finding("PR112", { file: rel, detail: `${d.name || rel} has "private": true, so npm refuses to publish it.` })); info.skipped = true; continue; }
    const reg = d.publishConfig && d.publishConfig.registry;
    if (reg && !/registry\.npmjs\.org/.test(reg)) { info.skipped = true; continue; }
    const provider = pSites[0].provider;
    const at = { file: rel, line: jsonKeyLine(pkg.text, "repository") || jsonKeyLine(pkg.text, "name") };
    const repo = parseRepository(d.repository);
    const subdir = path.relative(root, pkg.dir).split(path.sep).join("/");
    const wantUrl = want ? `git+https://${want.host}/${want.owner}/${want.repo}.git` : null;
    const fixJson = wantUrl ? `"repository": {\n  "type": "git",\n  "url": "${wantUrl}"${subdir ? `,\n  "directory": "${subdir}"` : ""}\n}` : undefined;
    if (!repo || !repo.url) {
      findings.push(finding("PR101", { ...at, detail: `${d.name}: npm checks repository.url against the repository in the OIDC/provenance claims and rejects the publish with E422 ("repository.url" is "", expected to match ...) when it's missing.`, fix: fixJson }));
    } else if (want) {
      if (repo.host && repo.host !== want.host) {
        findings.push(finding("PR102", { ...at, detail: `${d.name}: repository.url is ${repo.url} (host ${repo.host}) but it publishes from ${want.host}/${want.owner}/${want.repo}.`, fix: fixJson }));
      } else if (repo.owner && (repo.owner !== want.owner || repo.repo !== want.repo)) {
        const sameIgnoringCase = repo.owner.toLowerCase() === want.owner.toLowerCase() && repo.repo.toLowerCase() === want.repo.toLowerCase();
        if (sameIgnoringCase && canonical) {
          findings.push(finding("PR104", { ...at, detail: `${d.name}: repository.url says ${repo.owner}/${repo.repo}, GitHub's canonical name is ${canonical.fullName}. npm compares them case-sensitively and fails with E422 "expected to match https://github.com/${canonical.fullName} from provenance".`, fix: fixJson }));
        } else if (sameIgnoringCase) {
          findings.push(finding("PR103", { ...at, detail: `${d.name}: repository.url says ${repo.owner}/${repo.repo}, the ${ident.source} says ${want.owner}/${want.repo}. npm's check is case-sensitive; run with --online to compare against GitHub's canonical name.`, fix: fixJson }));
        } else {
          findings.push(finding("PR103", { ...at, detail: `${d.name}: repository.url says ${repo.owner}/${repo.repo} but the publish runs in ${want.owner}/${want.repo} (${canonical ? "GitHub" : ident.source}). Forks and renamed repos hit this: npm rejects it with E422.`, fix: fixJson }));
        }
      }
    }
    if (repo && repo.url && subdir && !repo.directory) {
      findings.push(finding("PR105", { ...at, detail: `${d.name} lives in ${subdir}/ but repository.directory isn't set, so the provenance/package page link points at the repo root.`, fix: fixJson }));
    }
    const flagPublic = pSites.some((s) => s.pubs.some((p) => p.accessPublic));
    const access = d.publishConfig && d.publishConfig.access;
    info.needsPublicAccess = isScoped(d.name) && access !== "public" && !flagPublic;
    const explicitProv = (d.publishConfig && d.publishConfig.provenance === true) || pSites.some((s) => s.pubs.some((p) => p.provenance));
    if (canonical && canonical.private) {
      if (explicitProv) findings.push(finding("PR070", { ...at, detail: `${d.name}: provenance is requested (--provenance or publishConfig.provenance) but ${canonical.fullName} is private. npm can't generate provenance for private repos and the publish fails.`, fix: "drop --provenance / publishConfig.provenance (trusted publishing still works without it)" }));
      else findings.push(finding("PR071", { ...at, detail: `${canonical.fullName} is private, so ${d.name} will publish without a provenance attestation.` }));
    }
    if (online && d.name) {
      const r = await npmPackage(d.name);
      if (r.error) notes.push(`npm lookup for ${d.name} skipped: ${r.error}`);
      else if (!r.exists) {
        info.firstPublish = true;
        findings.push(finding("PR110", { file: rel, line: jsonKeyLine(pkg.text, "name"), detail: `${d.name} isn't on npm yet. The trusted publisher form lives in the package's settings, which only exist after a first publish, so OIDC can't create the package.`,
          fix: `publish the first version by hand: npm publish${info.needsPublicAccess ? " --access public" : ""} (with 2FA), then add the trusted publisher and finish a CI publish within 2 days` }));
      } else if (d.version && r.versions.has(d.version) && !pSites.some((s) => s.pubs.some((p) => ["changeset", "lerna", "semantic-release", "pnpm", "yarn-berry"].includes(p.tool)))) {
        findings.push(finding("PR111", { file: rel, line: jsonKeyLine(pkg.text, "version"), detail: `${d.name}@${d.version} is already published (latest: ${r.latest}); publishing it again fails with E403 "You cannot publish over the previously published versions".`, fix: "bump the version before tagging" }));
      }
    }
    if (info.needsPublicAccess && (!online || info.firstPublish)) {
      findings.push(finding("PR106", { file: rel, line: jsonKeyLine(pkg.text, "name"), detail: `${d.name} is scoped and has no publishConfig.access "public" or --access public; a first publish defaults to restricted (private), which needs a paid org and fails with E402.`, fix: '"publishConfig": { "access": "public" }' }));
    }
  }

  // what to type into npmjs.com
  const settings = [];
  const seen = new Set();
  for (const site of sites) {
    for (const p of site.packages || []) {
      const d = p.data || {};
      if (d.private === true || !d.name) continue;
      if (site.provider === "github") {
        for (const e of site.entries || []) {
          const key = [d.name, e.file, site.environment].join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          settings.push({ package: d.name, provider: "GitHub Actions", owner: want ? want.owner : "?", repo: want ? want.repo : "?", workflow: e.file, environment: site.environment || null });
        }
      } else {
        const key = [d.name, "gitlab", site.environment].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        settings.push({ package: d.name, provider: "GitLab CI/CD", owner: want ? want.owner : "?", repo: want ? want.repo : "?", workflow: ".gitlab-ci.yml", environment: site.environment || null });
      }
    }
  }

  // big monorepos: one finding per code instead of forty
  for (const code of ["PR101", "PR103", "PR104", "PR105", "PR106", "PR111", "PR112"]) {
    const same = findings.filter((f) => f.code === code);
    if (same.length <= 3) continue;
    const names = same.map((f) => f.file);
    const first = same[0];
    const merged = { ...first, detail: `${same.length} packages: ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, … (+${names.length - 8} more)` : ""}.\n${first.detail}`, also: names };
    for (const f of same) findings.splice(findings.indexOf(f), 1);
    findings.push(merged);
  }
  findings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
  const counts = { error: 0, warn: 0, note: 0 };
  for (const f of findings) counts[f.level]++;
  return { root, repo: want, repoSource: canonical ? "GitHub API" : ident && ident.source, online, sites, packages, findings, settings, notes, counts };
}

export function exitCode(report, strict = false) {
  if (report.counts.error) return 1;
  if (strict && report.counts.warn) return 1;
  return 0;
}
