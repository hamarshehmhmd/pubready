// GitLab CI: npm trusted publishing needs an id_token NPM_ID_TOKEN with aud "npm:registry.npmjs.org".
import fs from "node:fs";
import path from "node:path";
import { loadYaml, lineOfKey } from "./yamlload.js";
import { findPublishes, findNpmUpgrade } from "./detect.js";
import { finding } from "./rules.js";
import { readPackage } from "./pkg.js";
import { resolveNodeSpec, nodeMeetsMinimum, bundledNpmSupportsOidc, resolveNpmSpec, npmSupportsOidc, bundledNpm, fmt } from "./versions.js";

const RESERVED = new Set(["stages", "variables", "default", "include", "workflow", "image", "services", "before_script", "after_script", "cache", "spec"]);

function scriptText(v) {
  if (!v) return "";
  return Array.isArray(v) ? v.flat(Infinity).map(String).join("\n") : String(v);
}

export function analyzeGitlab(root) {
  const file = path.join(root, ".gitlab-ci.yml");
  const out = { sites: [], findings: [] };
  if (!fs.existsSync(file)) return out;
  let data;
  try {
    data = loadYaml(fs.readFileSync(file, "utf8")) || {};
  } catch (e) {
    out.findings.push(finding("PR002", { file: ".gitlab-ci.yml", line: e.line, detail: e.message }));
    return out;
  }
  const pkg = readPackage(root);
  const scripts = (pkg && pkg.data && pkg.data.scripts) || {};
  const defaults = data.default || {};
  for (const [name, job] of Object.entries(data)) {
    if (RESERVED.has(name) || name.startsWith(".") || !job || typeof job !== "object" || Array.isArray(job)) continue;
    const text = [scriptText(job.before_script || defaults.before_script), scriptText(job.script)].join("\n");
    const pubs = findPublishes(text, scripts);
    if (!pubs.length) continue;
    const at = { file: ".gitlab-ci.yml", line: lineOfKey(data, name), job: name };
    const site = { provider: "gitlab", jobId: name, job, pubs, line: at.line, pkg, environment: job.environment ? (typeof job.environment === "string" ? job.environment : job.environment.name) : null };
    out.sites.push(site);
    const ids = job.id_tokens || defaults.id_tokens || {};
    const npmTok = ids.NPM_ID_TOKEN;
    const aud = npmTok && (Array.isArray(npmTok.aud) ? npmTok.aud : [npmTok.aud]);
    if (!npmTok || !aud.includes("npm:registry.npmjs.org")) {
      out.findings.push(finding("PR201", { ...at, detail: npmTok ? `NPM_ID_TOKEN has aud ${JSON.stringify(npmTok.aud)}; npm only accepts "npm:registry.npmjs.org".` : `job "${name}" runs \`${pubs[0].command}\` but doesn't request an NPM_ID_TOKEN, so npm can't use trusted publishing.`,
        fix: `add to job "${name}":\n  id_tokens:\n    NPM_ID_TOKEN:\n      aud: "npm:registry.npmjs.org"\n    SIGSTORE_ID_TOKEN:\n      aud: sigstore` }));
    } else if (!ids.SIGSTORE_ID_TOKEN) {
      out.findings.push(finding("PR202", { ...at, detail: "without SIGSTORE_ID_TOKEN (aud: sigstore) the package publishes without a provenance attestation." }));
    }
    const image = job.image || data.image || defaults.image;
    const imageName = image ? (typeof image === "string" ? image : image.name) : null;
    const m = imageName && String(imageName).match(/(?:^|\/)node:([\w.-]+)/);
    const upgrade = findNpmUpgrade(text);
    const upgradedTo = upgrade ? resolveNpmSpec(upgrade) : null;
    if (m) {
      const spec = m[1].replace(/-(alpine|slim|bookworm|bullseye|trixie|buster).*$/, "").replace(/\$\{?NODE_VERSION\}?/, String((data.variables || {}).NODE_VERSION || "$NODE_VERSION"));
      const node = resolveNodeSpec(spec);
      if (nodeMeetsMinimum(node) === false) out.findings.push(finding("PR030", { ...at, detail: `image ${imageName}: trusted publishing needs Node 22.14.0+ and npm 11.5.1+.`, fix: "use image: node:24" }));
      else if (!upgradedTo && bundledNpmSupportsOidc(node) === false) out.findings.push(finding("PR031", { ...at, detail: `image ${imageName} bundles npm ${fmt(bundledNpm(node))}; OIDC needs 11.5.1+.`, fix: "use image: node:24, or `npm install -g npm@latest` first" }));
    } else if (!(upgradedTo && npmSupportsOidc(upgradedTo))) {
      out.findings.push(finding("PR032", { ...at, detail: `image ${imageName || "(runner default)"}: can't tell which Node/npm publishes.`, fix: "use image: node:24" }));
    }
    const vars = { ...(data.variables || {}), ...(job.variables || {}) };
    const tokVars = Object.keys(vars).filter((k) => /^(NPM_TOKEN|NODE_AUTH_TOKEN)$/.test(k));
    if (tokVars.length) out.findings.push(finding("PR040", { ...at, detail: `${tokVars.join(", ")} set on the publish job.`, fix: "remove it once trusted publishing works, and revoke the token" }));
  }
  return out;
}
