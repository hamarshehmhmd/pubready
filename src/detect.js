// Find publish commands in shell snippets, following package.json scripts.
const TOOLS = [
  { tool: "yarn-berry", re: /\byarn\s+(?:workspaces\s+foreach\b.*?\s)?npm\s+publish(?![\w:-])/ },
  { tool: "npm-stage", re: /\bnpm\s+(?:-\S+\s+)*stage\s+publish(?![\w:-])/ },
  { tool: "npm", re: /\bnpx\s+(?:-y\s+|--yes\s+)?npm@\S+\s+(?:-\S+\s+)*publish(?![\w:-])/ },
  { tool: "npm", re: /\bnpm\s+(?:-\S+\s+)*publish(?![\w:-])/ },
  { tool: "pnpm", re: /\bpnpm\s+(?:(?:-r|--recursive|--filter[= ]\S+|-F\s+\S+|-C\s+\S+|--dir[= ]\S+)\s+)*publish(?![\w:-])/ },
  { tool: "yarn-classic", re: /\byarn\s+publish(?![\w:-])/ },
  { tool: "lerna", re: /\blerna\s+publish(?![\w:-])/ },
  { tool: "changeset", re: /\bchangeset\s+publish(?![\w:-])/ },
  { tool: "semantic-release", re: /\bsemantic-release(?![\w:-])/ },
  { tool: "bun", re: /\bbun\s+publish(?![\w:-])/ },
];
const SCRIPT_CALL = /\b(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.@/-]+)/g;
const BUILTIN = new Set(["install", "i", "ci", "add", "remove", "publish", "pack", "exec", "dlx", "x", "config", "init", "audit", "version", "view", "dist-tag", "whoami", "stage", "npm", "workspaces", "set", "login", "link", "rebuild", "update", "up", "outdated", "-g", "--global"]);

function stripComment(line) {
  const t = line.trim();
  return t.startsWith("#") ? "" : t;
}

export function flagsOf(line) {
  return {
    provenance: /--provenance(?!=false)\b/.test(line),
    noProvenance: /--provenance=false|--no-provenance/.test(line),
    accessPublic: /--access[= ]public\b/.test(line),
    workspaces: /--workspaces\b|\s-ws\b|--workspace[= ]|\s-w\s|\s(-r|--recursive)\b/.test(line),
    npmSpec: (line.match(/\bnpx\s+(?:-y\s+|--yes\s+)?npm@(\S+)/) || [])[1],
  };
}

/**
 * Publish invocations inside a shell snippet.
 * @param {string} text   the `run:` / `script:` text
 * @param {object} scripts package.json "scripts" to follow (`npm run release` -> its body)
 */
export function findPublishes(text, scripts = {}, via = [], depth = 0) {
  const out = [];
  if (!text || depth > 4) return out;
  for (const raw of String(text).split(/\r?\n|&&|\|\||;/)) {
    const line = stripComment(raw);
    if (!line || /--dry-run\b/.test(line)) continue;
    let matched = false;
    for (const t of TOOLS) {
      if (t.re.test(line)) {
        out.push({ tool: t.tool, command: line, via, ...flagsOf(line) });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const callRe = new RegExp(SCRIPT_CALL.source, "g");
    let m;
    while ((m = callRe.exec(line))) {
      const [, runner, name] = m;
      const explicitRun = /\srun(?:-script)?\s/.test(line.slice(m.index, m.index + m[0].length + 1));
      if ((!explicitRun && BUILTIN.has(name)) || name.startsWith("-")) continue;
      if (runner === "npm" && !explicitRun && name !== "test" && name !== "start") continue;
      if (scripts && typeof scripts[name] === "string") {
        out.push(...findPublishes(scripts[name], scripts, [...via, `${runner} run ${name}`], depth + 1));
        // npm/pnpm/yarn run pre<name> and post<name> hooks too
        for (const hook of [`pre${name}`, `post${name}`]) {
          if (typeof scripts[hook] === "string") out.push(...findPublishes(scripts[hook], scripts, [...via, `${runner} run ${name} (${hook})`], depth + 1));
        }
      }
    }
  }
  return out;
}

export function findDistTag(text) {
  if (!text) return null;
  const m = String(text).match(/\bnpm\s+(?:-\S+\s+)*dist-tag\s+(add|rm|remove|ls|list)\b[^\n]*/);
  return m ? m[0].trim() : null;
}

/** `npm i -g npm@X` in a snippet -> "X" ("latest" when no version is given), else null. */
export function findNpmUpgrade(text) {
  if (!text) return null;
  let spec = null;
  for (const raw of String(text).split(/\r?\n|&&|;/)) {
    const line = stripComment(raw);
    const m = line.match(/\bnpm\s+(?:i|install|update|up|add)\s+(.*)$/);
    if (!m || !/(^|\s)(-g|--global)(\s|$)/.test(m[1])) continue;
    for (const tok of m[1].split(/\s+/)) {
      const t = tok.replace(/^['"]|['"]$/g, "");
      const mm = t.match(/^npm(?:@(.+))?$/);
      if (mm) spec = mm[1] || "latest";
    }
  }
  return spec;
}
