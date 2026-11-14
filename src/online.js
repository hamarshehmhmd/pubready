// Optional network lookups: GitHub's canonical repo name/visibility and the npm registry.
import fs from "node:fs";

const TIMEOUT = 8000;

function fixture() {
  const f = process.env.PUBREADY_FIXTURE;
  if (!f) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

async function getJson(url, headers = {}) {
  const fx = fixture();
  if (fx) {
    if (!(url in fx)) return { status: 404, body: null };
    const v = fx[url];
    if (v && typeof v === "object" && "__status" in v) return { status: v.__status, body: v.body || null };
    return { status: 200, body: v };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { "user-agent": "pubready", ...headers }, signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** {fullName, private, owner, repo} or {missing:true} or {error}. */
export async function githubRepo(owner, repo) {
  const headers = { accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const r = await getJson(`https://api.github.com/repos/${owner}/${repo}`, headers);
    if (r.status === 404) return { missing: true };
    if (r.status !== 200 || !r.body) return { error: `GitHub API HTTP ${r.status}` };
    const [o, n] = String(r.body.full_name).split("/");
    return { fullName: r.body.full_name, owner: o, repo: n, private: !!r.body.private, archived: !!r.body.archived };
  } catch (e) {
    return { error: e.name === "AbortError" ? "GitHub API timed out" : e.message };
  }
}

/** {exists, versions:Set, latest} or {error}. */
export async function npmPackage(name, registry = "https://registry.npmjs.org") {
  const enc = name.startsWith("@") ? name.replace("/", "%2f") : name;
  try {
    const r = await getJson(`${registry.replace(/\/$/, "")}/${enc}`, { accept: "application/vnd.npm.install-v1+json" });
    if (r.status === 404) return { exists: false };
    if (r.status !== 200 || !r.body) return { error: `npm registry HTTP ${r.status}` };
    return { exists: true, versions: new Set(Object.keys(r.body.versions || {})), latest: (r.body["dist-tags"] || {}).latest };
  } catch (e) {
    return { error: e.name === "AbortError" ? "npm registry timed out" : e.message };
  }
}
