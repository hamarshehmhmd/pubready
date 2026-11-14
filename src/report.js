// Text / JSON / GitHub-annotation output.
import { RULES } from "./rules.js";

export function colors(enabled) {
  const c = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { red: c("31"), yellow: c("33"), cyan: c("36"), green: c("32"), dim: c("2"), bold: c("1"), magenta: c("35") };
}

const ICON = { error: "✖", warn: "▲", note: "•" };

function plural(n, w) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

export function renderText(r, opts = {}) {
  const k = colors(opts.color);
  const lvl = { error: k.red, warn: k.yellow, note: k.cyan };
  const out = [];
  const repo = r.repo ? `${r.repo.host}/${r.repo.owner}/${r.repo.repo}` : "repository unknown";
  out.push(`${k.bold("pubready")}  ${repo}  ${k.dim(`(${r.repoSource || "no remote"}; online checks ${r.online ? "on" : "off"})`)}`);
  if (r.sites.length) {
    out.push("");
    out.push(k.bold("publish steps"));
    for (const s of r.sites) {
      const where = s.provider === "github" ? `${s.wf.rel}:${s.line || "?"}` : `.gitlab-ci.yml:${s.line || "?"}`;
      for (const p of s.pubs) {
        const via = p.via && p.via.length ? k.dim(`${p.via.join(" → ")} → `) : "";
        out.push(`  ${where}  job ${s.jobId}  ${via}${p.command}`);
      }
      const names = (s.packages || []).map((p) => (p.data && p.data.name) || p.file).join(", ");
      if (names) out.push(k.dim(`    publishes ${names}`));
    }
  }
  if (r.findings.length) out.push("");
  for (const f of r.findings) {
    const loc = f.file ? k.dim(`${f.file}${f.line ? `:${f.line}` : ""}`) : "";
    out.push(`${lvl[f.level](`${ICON[f.level]} ${f.code}`)} ${k.bold(f.title)}  ${loc}`);
    if (f.detail) for (const l of wrap(f.detail, 92)) out.push(`    ${l}`);
    if (f.fix) {
      const [first, ...rest] = String(f.fix).split("\n");
      const firstLines = wrap(first, 87);
      out.push(`    ${k.green("fix:")} ${firstLines[0]}`);
      for (const l of firstLines.slice(1)) out.push(`         ${l}`);
      for (const l of rest) out.push(`         ${k.green(l)}`);
    }
  }
  if (r.settings.length) {
    out.push("");
    const groups = new Map();
    for (const s of r.settings) {
      const key = [s.provider, s.owner, s.repo, s.workflow, s.environment].join("|");
      if (!groups.has(key)) groups.set(key, { ...s, packages: [] });
      groups.get(key).packages.push(s.package);
    }
    for (const s of groups.values()) {
      const pk = s.packages.length > 1 ? `{${s.packages.slice(0, 4).join(", ")}${s.packages.length > 4 ? `, +${s.packages.length - 4} more` : ""}}` : s.packages[0];
      out.push(k.bold(`npmjs.com → ${pk} → Settings → Trusted publishing → ${s.provider}`));
      if (s.provider === "GitHub Actions") {
        out.push(`  Organization or user  ${k.magenta(s.owner)}`);
        out.push(`  Repository            ${k.magenta(s.repo)}`);
        out.push(`  Workflow filename     ${k.magenta(s.workflow)}`);
      } else {
        out.push(`  Namespace             ${k.magenta(s.owner)}`);
        out.push(`  Project name          ${k.magenta(s.repo)}`);
        out.push(`  Top-level CI file     ${k.magenta(s.workflow)}`);
      }
      out.push(`  Environment           ${s.environment ? k.magenta(s.environment) : k.dim("(leave empty)")}`);
    }
    out.push(k.dim("  All fields are case-sensitive and npm doesn't validate them when you save."));
  }
  for (const n of r.notes) out.push(k.dim(`note: ${n}`));
  out.push("");
  const c = r.counts;
  const summary = `${plural(c.error, "error")}, ${plural(c.warn, "warning")}, ${plural(c.note, "note")}`;
  if (r.findings.some((f) => f.code === "PR001")) out.push(k.yellow(`${summary}: nothing to check, no publish step found.`));
  else if (c.error) out.push(k.red(k.bold(`${summary}: trusted publishing will fail as configured.`)));
  else if (c.warn) out.push(k.yellow(`${summary}: should work, but look at the warnings.`));
  else out.push(k.green(`${summary}: ready for trusted publishing.`));
  return out.join("\n");
}

function wrap(text, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const w of para.split(" ")) {
      if (line && (line + " " + w).length > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
    }
    out.push(line);
  }
  return out;
}

export function renderJson(r) {
  return JSON.stringify({
    repo: r.repo, repoSource: r.repoSource, online: r.online, counts: r.counts,
    publishSteps: r.sites.map((s) => ({
      provider: s.provider, file: s.provider === "github" ? s.wf.rel : ".gitlab-ci.yml", line: s.line, job: s.jobId,
      commands: s.pubs.map((p) => ({ tool: p.tool, command: p.command, via: p.via })),
      packages: (s.packages || []).map((p) => p.data && p.data.name),
      trustedPublisherWorkflow: s.entries ? s.entries.map((e) => e.file) : [".gitlab-ci.yml"], environment: s.environment || null,
    })),
    findings: r.findings, trustedPublishers: r.settings, notes: r.notes,
  }, null, 2);
}

export function renderGithub(r) {
  const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const escProp = (s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  const lines = r.findings.map((f) => {
    const kind = f.level === "error" ? "error" : f.level === "warn" ? "warning" : "notice";
    const props = [f.file && !f.file.endsWith("/workflows") ? `file=${escProp(f.file)}` : null, f.line ? `line=${f.line}` : null, `title=${escProp(`${f.code} ${f.title}`)}`].filter(Boolean).join(",");
    return `::${kind} ${props}::${esc(f.detail + (f.fix ? `\nfix: ${f.fix}` : ""))}`;
  });
  return [...lines, renderText(r, { color: false })].join("\n");
}

export function renderRules() {
  return Object.entries(RULES).map(([code, [level, title]]) => `${code}  ${level.padEnd(5)}  ${title}`).join("\n");
}

export function renderExplain(res, opts = {}) {
  const k = colors(opts.color);
  const out = [];
  const v = [res.npm ? `npm ${res.npm.join(".")}${res.npmUpgrade ? " after npm install -g" : ""}` : res.npmUpgrade ? `npm@${res.npmUpgrade}` : null, res.node ? `node ${res.node.join(".")}` : null].filter(Boolean).join(", ");
  out.push(`${k.bold("pubready explain")}${v ? k.dim(`  (log mentions ${v})`) : ""}`);
  if (!res.diagnoses.length) {
    out.push("", "No known npm publish failure found in this log.");
    return out.join("\n");
  }
  for (const d of res.diagnoses) {
    out.push("", `${k.red("✖")} ${k.bold(d.title)}`);
    out.push(k.dim(`    log line ${d.line}: ${d.evidence}`));
    if (d.causes.length) {
      out.push("    likely causes:");
      d.causes.forEach((c, i) => out.push(`      ${i + 1}. ${c}`));
    }
    for (const f of d.fixes) {
      const [first, ...rest] = f.split("\n");
      out.push(`    ${k.green("fix:")} ${first}`);
      for (const l of rest) out.push(`         ${k.green(l)}`);
    }
  }
  return out.join("\n");
}
