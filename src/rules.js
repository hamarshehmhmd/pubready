// Every finding pubready can report. Levels: error (will fail the publish), warn (likely to bite), note (worth knowing).
export const RULES = {
  PR001: ["error", "No npm publish step found"],
  PR002: ["warn", "Workflow file could not be parsed"],
  PR010: ["error", "Publish job can't request an OIDC token (no `id-token: write`)"],
  PR011: ["error", "Calling workflow doesn't grant `id-token: write` to the reusable publish workflow"],
  PR012: ["note", "Reusable workflow: npm must be configured with the calling workflow's filename"],
  PR013: ["warn", "Reusable publish workflow has no caller in this repo"],
  PR020: ["error", "Self-hosted runner (trusted publishing only works on GitHub-hosted runners)"],
  PR030: ["error", "Node.js older than 22.14.0"],
  PR031: ["error", "npm CLI older than 11.5.1 (no OIDC support)"],
  PR032: ["warn", "Can't tell which Node/npm the publish step runs"],
  PR033: ["error", "`npm dist-tag` over OIDC needs npm 11.21.0+ (or 12.2.0+)"],
  PR040: ["warn", "Long-lived npm token still wired into the publish job"],
  PR041: ["warn", "An .npmrc auth token is committed or written by the workflow"],
  PR050: ["error", "Publish tool can't use npm trusted publishing"],
  PR051: ["warn", "Publish tool's OIDC support can't be verified"],
  PR052: ["note", "Publish goes through a wrapper"],
  PR060: ["note", "Direct `npm publish` must be an allowed action on the trusted publisher"],
  PR070: ["error", "Provenance requested from a private repository"],
  PR071: ["note", "Private repository: no provenance will be generated"],
  PR101: ["error", "package.json has no repository.url"],
  PR102: ["error", "repository.url points to a different host"],
  PR103: ["error", "repository.url doesn't match the repository that publishes"],
  PR104: ["error", "repository.url casing differs from GitHub's canonical name"],
  PR105: ["warn", "Package in a subdirectory without repository.directory"],
  PR106: ["warn", "Scoped package without public access"],
  PR110: ["error", "Package doesn't exist on npm yet (first publish can't use trusted publishing)"],
  PR111: ["warn", "This version is already on npm"],
  PR112: ["note", "Private package skipped"],
  PR201: ["error", "GitLab job has no NPM_ID_TOKEN id_token with aud npm:registry.npmjs.org"],
  PR202: ["note", "GitLab job has no SIGSTORE_ID_TOKEN (no provenance)"],
};

export function finding(code, fields) {
  const [level, title] = RULES[code];
  return { code, level, title, ...fields };
}
