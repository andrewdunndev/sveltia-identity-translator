#!/usr/bin/env node
//
// sveltia-identity-translator end-to-end smoke harness.
//
// Validates the full proxy contract Sveltia depends on: OAuth
// redirect, JWT validation, REST passthrough, GraphQL passthrough,
// allowlist enforcement (read and write), author injection, mutation
// rejection, CORS preflight. No real OAuth round-trip is
// exercised here -- we hand-mint JWTs using JWT_SECRET. That
// covers everything past the IdP (~95% of the surface). The IdP
// side is tested separately by visiting /oauth/authorize in a
// browser and watching for the 302 + consent screen.
//
// Usage:
//   JWT_SECRET=<the secret> node scripts/smoke.mjs
//   JWT_SECRET=<the secret> node scripts/smoke.mjs --base-url https://translator.example.org
//
// Default base URL: http://localhost:8787 (run `npx wrangler dev` in
// another terminal first; populate `.dev.vars` with the same secret).
//
// Options (defaults in parentheses):
//   --base-url      Worker origin (http://localhost:8787)
//   --repo          GitLab project path to exercise (example-org/website)
//   --admin         identity with write access to every write root of --repo
//                   (admin@example.org)
//   --editor        identity limited to ["src/content/blog/**"] on --repo
//                   (editor@example.org)
//   --stranger      identity with no editors.yml entry (stranger@example.org)
//   --domain        ALLOWED_DOMAIN of the deployment (the --admin email domain)
//   --site          a hostname in ALLOWED_SITES (the --domain value)
//   --token-name    name of the GitLab access token behind GITLAB_API_TOKEN;
//                   labels the expiry check (translator)

import { argv, env, exit } from "node:process";
import { webcrypto } from "node:crypto";

function readArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const baseUrl = (readArg("--base-url") || "http://localhost:8787").replace(/\/+$/, "");
const REPO = readArg("--repo") || "example-org/website";
const REPO_ENC = encodeURIComponent(REPO);
const GROUP = REPO.split("/")[0];
const ADMIN_EMAIL = readArg("--admin") || "admin@example.org";
const EDITOR_EMAIL = readArg("--editor") || "editor@example.org";
const STRANGER_EMAIL = readArg("--stranger") || "stranger@example.org";
const DOMAIN = readArg("--domain") || ADMIN_EMAIL.split("@")[1];
const SITE = readArg("--site") || DOMAIN;
const TOKEN_NAME = readArg("--token-name") || "translator";

const SECRET = env.JWT_SECRET;
if (!SECRET) {
  console.error("JWT_SECRET not set in env. Aborting.");
  exit(2);
}

// ---------------- JWT minting (mirrors src/jwt.ts) ----------------

const enc = new TextEncoder();

function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return Buffer.from(s, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlString(s) {
  return b64url(enc.encode(s));
}

async function importKey(secret, usage) {
  return webcrypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function mintJwt(email, name, ttlSeconds = 600) {
  const now = Math.floor(Date.now() / 1000);
  const origin = new URL(baseUrl).origin;
  const payload = { sub: email, name, email, iss: origin, aud: origin, iat: now, exp: now + ttlSeconds };
  const header = b64urlString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlString(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await importKey(SECRET, "sign");
  const sig = await webcrypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

// ---------------- assertion helpers ----------------

let pass = 0;
let fail = 0;
let blocked = 0;
const failures = [];
const blockers = [];

class EnvBlockedError extends Error {}

async function expect(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  pass     ${name}`);
  } catch (err) {
    if (err instanceof EnvBlockedError) {
      blocked++;
      blockers.push({ name, err });
      console.log(`  BLOCKED  ${name}`);
      console.log(`           ${err.message}`);
    } else {
      fail++;
      failures.push({ name, err });
      console.log(`  FAIL     ${name}`);
      console.log(`           ${err.message}`);
    }
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, label) {
  if (!cond) throw new Error(label);
}

async function req(path, init = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
}

// ---------------- the cases ----------------

console.log(`smoke -- ${baseUrl}`);
console.log("");

const adminJwt = await mintJwt(ADMIN_EMAIL, "Smoke Admin");
const editorJwt = await mintJwt(EDITOR_EMAIL, "Smoke Editor");
const stranger = await mintJwt(STRANGER_EMAIL, "Stranger");

console.log("liveness + redirects");

await expect("GET /healthz returns 200 ok", async () => {
  const r = await req("/healthz");
  assertEq(r.status, 200, "status");
  const body = await r.text();
  assertTrue(body.endsWith(" ok\n"), `body was ${JSON.stringify(body)}`);
});

await expect("GET /oauth/authorize with an unlisted site_id -> 400, no redirect", async () => {
  const r = await req("/oauth/authorize?provider=gitlab&site_id=evil.example&scope=api");
  assertEq(r.status, 400, "status");
  assertEq(r.headers.get("location"), null, "location");
});

await expect("GET /oauth/authorize redirects 302 to Google", async () => {
  const r = await req(`/oauth/authorize?provider=gitlab&site_id=${SITE}&scope=api`);
  assertEq(r.status, 302, "status");
  const loc = r.headers.get("location") ?? "";
  assertTrue(loc.startsWith("https://accounts.google.com/"), `location ${loc}`);
  const u = new URL(loc);
  assertTrue(u.searchParams.has("client_id"), "client_id present");
  assertEq(u.searchParams.get("hd"), DOMAIN, "hd param");
  assertEq(u.searchParams.get("code_challenge_method"), "S256", "PKCE method");
  assertTrue((r.headers.get("set-cookie") ?? "").startsWith("__Host-translator_pkce="), "PKCE cookie");
  assertTrue(u.searchParams.get("state") && u.searchParams.get("state").length > 10, "state present");
});

console.log("");
console.log("REST: /gitlab/user (synthesized) and auth gating");

await expect("GET /gitlab/user with valid admin JWT -> 200, email matches", async () => {
  const r = await req("/gitlab/user", { headers: { authorization: `Bearer ${adminJwt}` } });
  assertEq(r.status, 200, "status");
  const j = await r.json();
  assertEq(j.email, ADMIN_EMAIL, "email");
});

await expect("GET /gitlab/user without JWT -> 401", async () => {
  const r = await req("/gitlab/user");
  assertEq(r.status, 401, "status");
});

await expect("GET /gitlab/user with malformed JWT -> 401", async () => {
  const r = await req("/gitlab/user", { headers: { authorization: "Bearer not-a-jwt" } });
  assertEq(r.status, 401, "status");
});

console.log("");
console.log("REST: read-side allowlist enforcement");

await expect("GET branches via admin JWT (allowed repo) -> 200", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/branches`, {
    headers: { authorization: `Bearer ${adminJwt}` },
  });
  assertEq(r.status, 200, "status");
  const j = await r.json();
  assertTrue(Array.isArray(j) && j.length > 0, "non-empty branches array");
});

await expect("GET branches via stranger JWT (no entry) -> 403", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/branches`, {
    headers: { authorization: `Bearer ${stranger}` },
  });
  assertEq(r.status, 403, "status");
});

await expect("GET /projects/<repo>/members/all/0 (synthesized) -> 200, access_level 40", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/members/all/0`, {
    headers: { authorization: `Bearer ${adminJwt}` },
  });
  assertEq(r.status, 200, "status");
  const j = await r.json();
  assertEq(j.access_level, 40, "access_level");
  assertEq(j.id, 0, "id");
  assertEq(j.state, "active", "state");
});

await expect("GET /projects/<repo>/members/all/0 via stranger -> 403 (no editors.yml entry)", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/members/all/0`, {
    headers: { authorization: `Bearer ${stranger}` },
  });
  assertEq(r.status, 403, "status");
});

// Sveltia asserts the users list contains its own account id; the
// synthesized editor (id 0) never appears upstream.
await expect("GET /projects/<repo>/users?search (synthesized) -> 200, list contains id 0", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/users?search=smoke`, {
    headers: { authorization: `Bearer ${adminJwt}` },
  });
  assertEq(r.status, 200, "status");
  const j = await r.json();
  assertTrue(Array.isArray(j), "response is an array");
  assertTrue(
    j.some((u) => u.id === 0),
    "list contains the synthesized editor (id 0)",
  );
});

await expect("GET /projects/<repo>/users?search via stranger -> 403 (no editors.yml entry)", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/users?search=nobody`, {
    headers: { authorization: `Bearer ${stranger}` },
  });
  assertEq(r.status, 403, "status");
});

console.log("");
console.log("REST: default-deny");

await expect("GET /gitlab//projects/<repo>/... (empty segment) -> 400/403, never 2xx", async () => {
  const file = encodeURIComponent("src/content/blog/x.md");
  const r = await req(`/gitlab//projects/${REPO_ENC}/repository/files/${file}/raw?ref=main`, {
    headers: { authorization: `Bearer ${stranger}` },
  });
  assertTrue(r.status === 400 || r.status === 403, `status ${r.status}`);
});

await expect("GET a path outside the route table -> 403", async () => {
  const r = await req(`/gitlab/groups/${GROUP}`, {
    headers: { authorization: `Bearer ${adminJwt}` },
  });
  assertEq(r.status, 403, "status");
});

await expect("GET /projects/constructor/... -> 403 (not an allowlisted repo)", async () => {
  const r = await req("/gitlab/projects/constructor/repository/tree", {
    headers: { authorization: `Bearer ${adminJwt}` },
  });
  assertEq(r.status, 403, "status");
});

console.log("");
console.log("CORS preflight");

await expect("OPTIONS /gitlab/anything from an allowed origin -> 204 with CORS headers", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/files/whatever`, {
    method: "OPTIONS",
    headers: { origin: `https://${SITE}` },
  });
  assertEq(r.status, 204, "status");
  assertEq(r.headers.get("access-control-allow-origin"), `https://${SITE}`, "ACAO");
  const methods = (r.headers.get("access-control-allow-methods") ?? "").toUpperCase();
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    assertTrue(methods.includes(m), `ACAM contains ${m}`);
  }
});

await expect("OPTIONS /gitlab/anything from an unlisted origin -> no ACAO", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/files/whatever`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  });
  assertEq(r.headers.get("access-control-allow-origin"), null, "ACAO");
});

console.log("");
console.log("GraphQL: routing, allowlist, mutation rejection");

const RR_QUERY = `query($fullPath: ID!) { project(fullPath: $fullPath) { repository { rootRef } } }`;

await expect("POST /gitlab/graphql with rootRef query (allowed repo) -> 200, data.project.repository.rootRef present", async () => {
  const r = await req("/gitlab/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
    body: JSON.stringify({ query: RR_QUERY, variables: { fullPath: REPO } }),
  });
  assertEq(r.status, 200, "status");
  const j = await r.json();
  assertTrue(j.data && j.data.project, `expected data.project, got ${JSON.stringify(j).slice(0, 200)}`);
  assertTrue(typeof j.data.project.repository.rootRef === "string", "rootRef is a string");
});

await expect("POST /gitlab/graphql with mutation in body -> 403", async () => {
  const r = await req("/gitlab/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: `mutation Q($i: CommitCreateInput!) { commitCreate(input: $i) { __typename } }`,
      variables: { fullPath: REPO },
    }),
  });
  assertEq(r.status, 403, "status");
});

await expect("POST /gitlab/graphql missing variables.fullPath -> 400", async () => {
  const r = await req("/gitlab/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
    body: JSON.stringify({ query: RR_QUERY, variables: {} }),
  });
  assertEq(r.status, 400, "status");
});

await expect("POST /gitlab/graphql with disallowed fullPath -> 403", async () => {
  const r = await req("/gitlab/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
    body: JSON.stringify({ query: RR_QUERY, variables: { fullPath: `${GROUP}/no-such-repo` } }),
  });
  assertEq(r.status, 403, "status");
});

console.log("");
console.log("REST: write allowlist + author injection");

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const smokePath = `src/content/blog/.translator-smoke-admin-${ts}.md`;
const smokeContent = `translator smoke run at ${ts}\nbase=${baseUrl}\n`;

await expect(`POST /commits creates ${smokePath} with author=${ADMIN_EMAIL}`, async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      branch: "main",
      commit_message: `translator smoke ${ts}`,
      actions: [
        {
          action: "create",
          file_path: smokePath,
          content: smokeContent,
        },
      ],
    }),
  });
  if (r.status === 403) {
    const text = await r.text();
    if (/not allowed to push/i.test(text)) {
      throw new EnvBlockedError(
        `GitLab refused push (branch protection). The translator forwarded correctly. Resolve at the project: ${text.slice(0, 200)}`,
      );
    }
    throw new Error(`translator returned 403: ${text.slice(0, 300)}`);
  }
  if (r.status !== 201) {
    const text = await r.text();
    throw new Error(`expected 201, got ${r.status}: ${text.slice(0, 300)}`);
  }
  const j = await r.json();
  assertEq(j.author_email, ADMIN_EMAIL, "commit.author_email");
  assertEq(j.author_name, "Smoke Admin", "commit.author_name");
});

await expect(`POST /commits as the editor to disallowed path -> 403`, async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
    method: "POST",
    headers: { authorization: `Bearer ${editorJwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      branch: "main",
      commit_message: "smoke negative",
      actions: [
        {
          action: "create",
          file_path: "src/pages/forbidden.astro",
          content: "blocked",
        },
      ],
    }),
  });
  assertEq(r.status, 403, "status");
});

for (const [label, file_path] of [
  ["a build file", "package.json"],
  ["an svg upload", "public/images/blog/translator-smoke/x.svg"],
]) {
  await expect(`POST /commits as the admin to ${label} -> 403 (write roots bind every identity)`, async () => {
    const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
      body: JSON.stringify({
        branch: "main",
        commit_message: "smoke negative",
        actions: [{ action: "create", file_path, content: "blocked" }],
      }),
    });
    assertEq(r.status, 403, "status");
  });
}

const editorPath = `src/content/blog/.translator-smoke-${ts}.md`;
await expect(`POST /commits as the editor to allowed path under blog -> verifies allowlist positive`, async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
    method: "POST",
    headers: { authorization: `Bearer ${editorJwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      branch: "main",
      commit_message: `translator smoke editor ${ts}`,
      actions: [
        {
          action: "create",
          file_path: editorPath,
          content: "---\ntitle: smoke\n---\n",
        },
      ],
    }),
  });
  if (r.status === 403) {
    const text = await r.text();
    if (/not allowed to push/i.test(text)) {
      throw new EnvBlockedError(
        `GitLab refused push (branch protection). The translator forwarded correctly. Resolve at the project: ${text.slice(0, 200)}`,
      );
    }
    throw new Error(`translator returned 403: ${text.slice(0, 300)}`);
  }
  if (r.status !== 201) {
    const text = await r.text();
    throw new Error(`expected 201, got ${r.status}: ${text.slice(0, 300)}`);
  }
  const j = await r.json();
  assertEq(j.author_email, EDITOR_EMAIL, "commit.author_email");
});

console.log("");
console.log("operability");

// Group access token expiry early-warning. The token authenticates
// as itself via /personal_access_tokens/self -- returns the calling
// token's metadata regardless of role. Falls back BLOCKED if the
// endpoint shape changes; non-fatal so smoke still validates the
// rest of the contract.
await expect(`group access token '${TOKEN_NAME}' expires > 30 days from now`, async () => {
  const r = await req("/gitlab/personal_access_tokens/self", {
    headers: { authorization: `Bearer ${adminJwt}` },
  });
  if (r.status !== 200) {
    throw new EnvBlockedError(
      `token self-introspection returned ${r.status}; check via GitLab UI -> group ${GROUP} access tokens`,
    );
  }
  const me = await r.json();
  const exp = me.expires_at ? new Date(me.expires_at) : null;
  if (!exp) throw new EnvBlockedError("calling token has no expires_at; set one in GitLab UI");
  const days = Math.floor((exp - new Date()) / 86400_000);
  if (days <= 0) throw new Error(`calling token EXPIRED on ${me.expires_at}`);
  if (days < 30) {
    throw new EnvBlockedError(
      `calling token expires in ${days} days (${me.expires_at}). Rotate via GitLab UI; update GITLAB_API_TOKEN CI variable; push to redeploy.`,
    );
  }
  console.log(`           calling token expires in ${days} days (${me.expires_at})`);
});

// Cleanup: delete the artifacts this run created so smoke runs leave
// no trace on the branch. Done via a single multi-action commit
// as the admin (the editor only has blog scope). We tolerate failure
// here -- the commits did happen, and a dotfile under src/content/blog
// that the collection glob skips is not a production problem.
//
// The delete list is built by SWEEPING for every .translator-smoke artifact,
// not just this run's `ts`, so a run that dies between create and
// cleanup does not orphan its files: the next run sweeps them.
async function listSmokeArtifacts() {
  const r = await req(
    `/gitlab/projects/${REPO_ENC}/repository/tree?path=src%2Fcontent%2Fblog&per_page=100`,
    { headers: { authorization: `Bearer ${adminJwt}` } },
  );
  if (r.status !== 200) return [];
  const entries = await r.json();
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e.type === "blob" && (e.name || "").startsWith(".translator-smoke-"))
    .map((e) => e.path);
}

await expect("cleanup: sweep all smoke artifacts via the translator (best-effort)", async () => {
  const found = await listSmokeArtifacts();
  // Always include this run's two paths even if the tree listing missed
  // them (eventual consistency right after the create commits).
  const targets = [...new Set([...found, smokePath, editorPath])];
  const orphans = targets.filter((p) => !p.includes(ts));
  if (orphans.length > 0) {
    console.log(`           sweeping ${orphans.length} orphaned artifact(s) from earlier runs:`);
    for (const o of orphans) console.log(`             ${o}`);
  }
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      branch: "main",
      commit_message: `translator smoke cleanup ${ts}`,
      actions: targets.map((file_path) => ({ action: "delete", file_path })),
    }),
  });
  if (r.status === 403) {
    const text = await r.text();
    if (/not allowed to push/i.test(text)) {
      throw new EnvBlockedError("GitLab refused cleanup push (branch protection); artifacts left on main");
    }
  }
  if (r.status !== 201) {
    const text = await r.text();
    throw new Error(`cleanup expected 201, got ${r.status}: ${text.slice(0, 300)}`);
  }
});

// ---------------- summary ----------------

console.log("");
console.log(`pass=${pass}  blocked=${blocked}  fail=${fail}`);
if (blocked > 0) {
  console.log("");
  console.log("blocked (the translator worked; environment refused; resolve outside it):");
  for (const b of blockers) {
    console.log(`  - ${b.name}`);
    console.log(`    ${b.err.message}`);
  }
}
if (fail > 0) {
  console.log("");
  console.log("failures (translator defects):");
  for (const f of failures) {
    console.log(`  - ${f.name}`);
    console.log(`    ${f.err.message}`);
  }
}
exit(fail === 0 ? 0 : 1);
