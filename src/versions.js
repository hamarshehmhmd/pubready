// Node.js / npm version facts that matter for npm trusted publishing.
// Data checked against https://nodejs.org/dist/index.json and docs.npmjs.com in Nov 2026.

export const MIN_NPM = [11, 5, 1]; // trusted publishing (OIDC) needs npm CLI >= 11.5.1
export const MIN_NODE = [22, 14, 0]; // ...and Node >= 22.14.0
export const MIN_NPM_DISTTAG = [[11, 21, 0], [12, 2, 0]]; // `npm dist-tag` over OIDC: 11.21.0+ on 11.x, 12.2.0+ on 12.x

// First Node release of each major whose bundled npm is >= 11.5.1. Majors below 24 never bundle it.
export const FIRST_NODE_WITH_OIDC_NPM = { 24: [24, 5, 0], 25: [25, 0, 0], 26: [26, 0, 0], 27: [27, 0, 0] };
// npm bundled with the newest release of each major (what `node-version: <major>` resolves to today).
export const LATEST_BUNDLED_NPM = {
  18: [10, 8, 2], 20: [10, 8, 2], 22: [10, 9, 9], 23: [10, 9, 2], 24: [11, 19, 1], 25: [11, 12, 1], 26: [11, 20, 0],
};
export const CURRENT_LTS = 26; // "lts/*" (Lithium) as of Nov 2026
const LTS_NAMES = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24, lithium: 26 };

export function parseVer(s) {
  const m = String(s).trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  if (!m) return null;
  const n = (x) => (x === undefined || x === "x" || x === "*" ? null : Number(x));
  return [Number(m[1]), n(m[2]), n(m[3])];
}

export function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export const fmt = (v) => (v ? v.map((x) => (x == null ? "x" : x)).join(".") : "?");

/** Resolve a setup-node `node-version` / docker tag / .nvmrc spec. Returns {major, exact, floating, label} or {unknown}. */
export function resolveNodeSpec(spec) {
  if (spec === undefined || spec === null) return { unknown: true, label: "unset" };
  const raw = String(spec).trim();
  const label = raw;
  if (!raw) return { unknown: true, label };
  if (/\$\{\{/.test(raw)) return { unknown: true, label, expression: true };
  const low = raw.toLowerCase();
  if (["latest", "node", "current"].includes(low)) return { major: 99, floating: true, label };
  if (low === "lts/*" || low === "lts" || low === "lts/-0") return { major: CURRENT_LTS, floating: true, label };
  const lts = low.match(/^lts\/([a-z]+)$/);
  if (lts && LTS_NAMES[lts[1]]) return { major: LTS_NAMES[lts[1]], floating: true, label };
  const cleaned = low.replace(/^(>=|\^|~|=)\s*/, "");
  const ge = /^>=/.test(low);
  const v = parseVer(cleaned);
  if (!v) return { unknown: true, label };
  if (ge) return { major: 99, floating: true, label, atLeast: v };
  const exact = v[1] != null && v[2] != null && !/^[\^~]/.test(low);
  return { major: v[0], exact: exact ? v : null, floating: !exact, label, partial: v };
}

/** Does this Node spec bring an npm >= 11.5.1 without an explicit npm upgrade? true / false / null (unknown). */
export function bundledNpmSupportsOidc(node) {
  if (!node || node.unknown) return null;
  if (node.major >= 25) return true;
  if (node.major === 24) {
    if (node.exact) return cmp(node.exact, FIRST_NODE_WITH_OIDC_NPM[24]) >= 0;
    if (node.partial && node.partial[1] != null && node.partial[1] < 5 && !/^[\^~]/.test(node.label)) {
      return node.partial[1] >= 5; // "24.4" floats within 24.4.x only
    }
    return true;
  }
  return false;
}

export function nodeMeetsMinimum(node) {
  if (!node || node.unknown) return null;
  if (node.major > MIN_NODE[0]) return true;
  if (node.major < MIN_NODE[0]) return false;
  if (node.exact) return cmp(node.exact, MIN_NODE) >= 0;
  if (node.partial && node.partial[1] != null && !/^[\^~]/.test(node.label)) return node.partial[1] >= 14;
  return true; // "22" floats to the newest 22.x
}

/** npm version we expect after `npm i -g npm@<spec>`. Returns a version triple (lower bound) or null when unknown. */
export function resolveNpmSpec(spec) {
  const s = String(spec == null ? "latest" : spec).trim().toLowerCase();
  if (s === "" || s === "latest" || s === "next" || /^next-1[1-9]$/.test(s)) return [12, 2, 2];
  const lo = s.replace(/^(>=|\^|~|=)\s*/, "");
  const v = parseVer(lo);
  if (!v) return null;
  // A bare major ("11") or a caret range floats to the newest release in that major.
  if (v[1] == null || /^\^/.test(s)) return v[0] === 11 ? [11, 21, 0] : v[0] >= 12 ? [12, 2, 2] : [v[0], 99, 0];
  if (/^>=/.test(s)) return [99, 0, 0];
  return [v[0], v[1] || 0, v[2] || 0];
}

export function npmSupportsOidc(v) {
  return v ? cmp(v, MIN_NPM) >= 0 : null;
}

export function npmSupportsDistTag(v) {
  if (!v) return null;
  if (v[0] === 11) return cmp(v, MIN_NPM_DISTTAG[0]) >= 0;
  if (v[0] === 12) return cmp(v, MIN_NPM_DISTTAG[1]) >= 0;
  return v[0] > 12;
}

/** Bundled npm for a resolved Node spec (approximate, newest patch of the major). */
export function bundledNpm(node) {
  if (!node || node.unknown) return null;
  if (node.major >= 27) return [12, 2, 2];
  return LATEST_BUNDLED_NPM[node.major] || (node.major > 26 ? [12, 0, 0] : null);
}
