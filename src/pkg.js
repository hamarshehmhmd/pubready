// package.json, workspaces, .npmrc and git remote helpers.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadYaml } from "./yamlload.js";

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readPackage(dir) {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { dir, file, error: e.message, data: {} };
  }
  return { dir, file, text, data };
}

/** Line (1-based) of the first occurrence of `"key"` in a JSON text, for annotations. */
export function jsonKeyLine(text, key) {
  if (!text) return undefined;
  const i = text.indexOf(`"${key}"`);
  if (i < 0) return undefined;
  return text.slice(0, i).split("\n").length;
}

/** Parse anything npm accepts as a repository into {host, owner, repo, url} (owner/repo keep their case). */
export function parseRepository(repo) {
  if (!repo) return null;
  let url = typeof repo === "string" ? repo : repo.url;
  if (!url || typeof url !== "string") return null;
  url = url.trim();
  const shorthand = url.match(/^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (shorthand && !url.includes("://") && !url.startsWith("git@")) {
    const host = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" }[(shorthand[1] || "github").toLowerCase()];
    return { host, owner: shorthand[2], repo: shorthand[3], url, directory: typeof repo === "object" ? repo.directory : undefined };
  }
  const m = url.match(/^(?:git\+)?(?:(?:https?|git|ssh|git\+ssh):\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/i);
  if (!m) return { url, host: null };
  const parts = m[2].split("/").filter(Boolean);
  if (parts.length < 2) return { url, host: m[1].toLowerCase() };
  const repoName = parts.pop();
  return { host: m[1].toLowerCase(), owner: parts.join("/"), repo: repoName, url, directory: typeof repo === "object" ? repo.directory : undefined };
}

export function gitRoot(dir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

export function gitRemote(dir) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return parseRepository(url);
  } catch {
    return null;
  }
}

function expandPattern(root, pattern) {
  const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (clean.startsWith("!")) return [];
  const star = clean.indexOf("*");
  if (star < 0) return [path.join(root, clean)];
  const base = path.join(root, clean.slice(0, star).replace(/\/$/, ""));
  const deep = clean.includes("**");
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      out.push(p);
      if (deep && depth < 3) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return out;
}

/** All workspace package dirs (npm/yarn `workspaces`, pnpm-workspace.yaml, lerna.json). */
export function workspaceDirs(root) {
  const pkg = readPackage(root);
  let patterns = [];
  if (pkg && pkg.data) {
    const ws = pkg.data.workspaces;
    if (Array.isArray(ws)) patterns.push(...ws);
    else if (ws && Array.isArray(ws.packages)) patterns.push(...ws.packages);
  }
  const pnpmWs = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmWs)) {
    try {
      const y = loadYaml(fs.readFileSync(pnpmWs, "utf8"));
      if (y && Array.isArray(y.packages)) patterns.push(...y.packages);
    } catch { /* ignore */ }
  }
  const lerna = readJson(path.join(root, "lerna.json"));
  if (lerna && Array.isArray(lerna.packages)) patterns.push(...lerna.packages);
  const dirs = new Set();
  for (const p of patterns) for (const d of expandPattern(root, String(p))) if (fs.existsSync(path.join(d, "package.json"))) dirs.add(d);
  return [...dirs].sort();
}

/** Lines of .npmrc files (repo root / package dir) that wire a static auth token. */
export function npmrcTokens(dirs) {
  const hits = [];
  const seen = new Set();
  for (const d of dirs) {
    const f = path.join(d, ".npmrc");
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (/^\s*[;#]/.test(line)) return;
      if (/_authToken\s*=|_auth\s*=|_password\s*=/.test(line)) hits.push({ file: f, line: i + 1, text: line.trim().replace(/=(.{4}).+$/, "=$1…") });
    });
  }
  return hits;
}

export function isScoped(name) {
  return typeof name === "string" && name.startsWith("@");
}
