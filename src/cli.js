import fs from "node:fs";
import { check, exitCode } from "./check.js";
import { renderText, renderJson, renderGithub, renderRules, renderExplain } from "./report.js";
import { explainText, loadLog } from "./explain.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `pubready ${VERSION}: preflight for npm trusted publishing (OIDC)

usage:
  pubready [check] [dir]        check the repo's publish workflows + package.json files
  pubready explain <log|-|url>  explain a failed npm publish log (file, stdin, or a GitHub Actions run URL via gh)
  pubready rules                list every check

options (check):
  --offline         skip GitHub/npm lookups (canonical repo casing, private repo, package exists, version taken)
  --repo OWNER/NAME the GitHub repo that publishes (default: $GITHUB_REPOSITORY, else git remote origin)
  --format F        text (default), json, github (workflow annotations + text)
  --strict          exit 1 on warnings too
  --no-color
  -h, --help, -V, --version

exit codes: 0 ready, 1 problems found, 2 usage error`;

function parse(argv) {
  const o = { cmd: "check", args: [], online: true, format: "text", strict: false, color: undefined, repo: undefined };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-V" || a === "--version") o.version = true;
    else if (a === "--offline") o.online = false;
    else if (a === "--online") o.online = true;
    else if (a === "--strict") o.strict = true;
    else if (a === "--no-color") o.color = false;
    else if (a === "--color") o.color = true;
    else if (a === "--repo") o.repo = rest.shift();
    else if (a.startsWith("--repo=")) o.repo = a.slice(7);
    else if (a === "--format") o.format = rest.shift();
    else if (a.startsWith("--format=")) o.format = a.slice(9);
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown option ${a}`);
    else o.args.push(a);
  }
  if (["check", "explain", "rules"].includes(o.args[0])) o.cmd = o.args.shift();
  if (!["text", "json", "github"].includes(o.format)) throw new Error(`--format must be text, json or github`);
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try {
    o = parse(argv);
  } catch (e) {
    process.stderr.write(`pubready: ${e.message}\n\n${HELP}\n`);
    return 2;
  }
  if (o.help) { process.stdout.write(HELP + "\n"); return 0; }
  if (o.version) { process.stdout.write(VERSION + "\n"); return 0; }
  const color = o.color !== undefined ? o.color : (!!process.stdout.isTTY && !process.env.NO_COLOR) || !!process.env.FORCE_COLOR;
  if (o.cmd === "rules") { process.stdout.write(renderRules() + "\n"); return 0; }
  if (o.cmd === "explain") {
    if (!o.args[0]) { process.stderr.write("pubready explain: give a log file, - for stdin, or a GitHub Actions run URL\n"); return 2; }
    let text;
    try { text = loadLog(o.args[0]); } catch (e) { process.stderr.write(`pubready: ${e.message}\n`); return 2; }
    const res = explainText(text);
    process.stdout.write((o.format === "json" ? JSON.stringify(res, null, 2) : renderExplain(res, { color })) + "\n");
    return res.diagnoses.length ? 1 : 0;
  }
  const dir = o.args[0] || ".";
  if (!fs.existsSync(dir)) { process.stderr.write(`pubready: ${dir}: no such directory\n`); return 2; }
  const report = await check(dir, { online: o.online, repo: o.repo });
  const text = o.format === "json" ? renderJson(report) : o.format === "github" ? renderGithub(report) : renderText(report, { color });
  process.stdout.write(text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY && o.format === "github") {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + renderText(report, { color: false }) + "\n```\n"); } catch { /* ignore */ }
  }
  return exitCode(report, o.strict);
}
