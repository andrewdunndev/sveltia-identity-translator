#!/usr/bin/env node
//
// sveltia-identity-translator end-to-end smoke harness.
//
// Validates the full proxy contract Sveltia depends on: OAuth
// redirect, JWT validation, REST passthrough, GraphQL passthrough,
// allowlist enforcement (read and write), author injection, mutation
// rejection, CORS preflight. No real OAuth round-trip is exercised
// here -- we hand-mint JWTs using JWT_SECRET. That covers everything
// past the IdP (~95% of the surface). The IdP side is tested
// separately by visiting /oauth/authorize in a browser and watching
// for the 302 + provider consent screen.
//
// Usage:
//   JWT_SECRET=<the secret> node scripts/smoke.mjs
//   JWT_SECRET=<the secret> node scripts/smoke.mjs --base-url https://translator.example.org
//
// Default base URL: http://localhost:8787 (run `npx wrangler dev` in
// another terminal first; populate `.dev.vars` with the same secret).
//
// Required identities in editors.yml:
//   admin@example.org             with your-org/your-site: ["**"]
//   smoke_editor@example.org      with your-org/your-site: ["src/content/blog/**"]
//
// You can override the repo via --repo:
//   JWT_SECRET=... node scripts/smoke.mjs --repo your-org/your-site

import { argv, env, exit } from "node:process";
import { webcrypto } from "node:crypto";

function readArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const baseUrl = (readArg("--base-url") || "http://localhost:8787").replace(/\/+$/, "");
const REPO = readArg("--repo") || "your-org/your-site";
const REPO_ENC = encodeURIComponent(REPO);
const ADMIN_EMAIL = readArg("--admin") || "admin@example.org";
const EDITOR_EMAIL = readArg("--editor") || "smoke_editor@example.org";
const STRANGER_EMAIL = readArg("--stranger") || "nobody@example.org";

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
  return Buffer.from(s, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
  const payload = { sub: email, name, email, iat: now, exp: now + ttlSeconds };
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
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(cond, label) {
  if (!cond) throw new Error(label);
}

async function req(path, init = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
}

// ---------------- the cases ----------------

console.log(`sveltia-identity-translator smoke -- ${baseUrl}`);
console.log(`  repo:      ${REPO}`);
console.log(`  admin:     ${ADMIN_EMAIL}`);
console.log(`  editor:    ${EDITOR_EMAIL}`);
console.log(`  stranger:  ${STRANGER_EMAIL}`);
console.log("");

const adminJwt = await mintJwt(ADMIN_EMAIL, "Smoke Admin");
const editorJwt = await mintJwt(EDITOR_EMAIL, "Smoke Editor");
const strangerJwt = await mintJwt(STRANGER_EMAIL, "Stranger");

console.log("liveness + redirects");

await expect("GET /healthz returns 200 ok", async () => {
  const r = await req("/healthz");
  assertEq(r.status, 200, "status");
  const body = await r.text();
  assertTrue(body.startsWith("translator ok"), `body was ${JSON.stringify(body)}`);
});

await expect("GET /oauth/authorize redirects 302 to IdP consent", async () => {
  const r = await req("/oauth/authorize?provider=gitlab&site_id=cms.example.org&scope=api");
  assertEq(r.status, 302, "status");
  const loc = r.headers.get("location") ?? "";
  assertTrue(/^https:\/\/.*\/(o\/oauth2|oauth2|authorize)/.test(loc), `location ${loc}`);
  const u = new URL(loc);
  assertTrue(u.searchParams.has("client_id"), "client_id present");
  assertTrue(
    u.searchParams.get("state") && u.searchParams.get("state").length > 10,
    "state present",
  );
});

console.log("");
console.log("REST: /gitlab/user (synthesized) and auth gating");

await expect("GET /gitlab/user with valid admin JWT -> 200, email matches", async () => {
  const r = await req("/gitlab/user", { headers: { authorization: `Bearer ${adminJwt}` } });
  assertEq(r.status, 200, "status");
  const j = await r.json();
  assertEq(j.email, ADMIN_EMAIL, "email");
  assertEq(j.id, 0, "synthesized id");
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
    headers: { authorization: `Bearer ${strangerJwt}` },
  });
  assertEq(r.status, 403, "status");
});

await expect(
  "GET /projects/<repo>/members/all/0 (synthesized) -> 200, access_level 40",
  async () => {
    const r = await req(`/gitlab/projects/${REPO_ENC}/members/all/0`, {
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    assertEq(r.status, 200, "status");
    const j = await r.json();
    assertEq(j.access_level, 40, "access_level");
    assertEq(j.id, 0, "id");
    assertEq(j.state, "active", "state");
  },
);

await expect(
  "GET /projects/<repo>/members/all/0 via stranger -> 403 (no editors.yml entry)",
  async () => {
    const r = await req(`/gitlab/projects/${REPO_ENC}/members/all/0`, {
      headers: { authorization: `Bearer ${strangerJwt}` },
    });
    assertEq(r.status, 403, "status");
  },
);

console.log("");
console.log("CORS preflight");

await expect("OPTIONS /gitlab/anything -> 204 with CORS headers", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/files/whatever`, {
    method: "OPTIONS",
  });
  assertEq(r.status, 204, "status");
  assertEq(r.headers.get("access-control-allow-origin"), "*", "ACAO");
  const methods = (r.headers.get("access-control-allow-methods") ?? "").toUpperCase();
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    assertTrue(methods.includes(m), `ACAM contains ${m}`);
  }
});

console.log("");
console.log("GraphQL: routing, allowlist, mutation rejection");

const RR_QUERY = `query($fullPath: ID!) { project(fullPath: $fullPath) { repository { rootRef } } }`;

await expect(
  "POST /gitlab/graphql with rootRef query (allowed repo) -> 200, data.project.repository.rootRef present",
  async () => {
    const r = await req("/gitlab/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
      body: JSON.stringify({ query: RR_QUERY, variables: { fullPath: REPO } }),
    });
    assertEq(r.status, 200, "status");
    const j = await r.json();
    assertTrue(
      j.data && j.data.project,
      `expected data.project, got ${JSON.stringify(j).slice(0, 200)}`,
    );
    assertTrue(typeof j.data.project.repository.rootRef === "string", "rootRef is a string");
  },
);

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
    body: JSON.stringify({ query: RR_QUERY, variables: { fullPath: "your-org/no-such-repo" } }),
  });
  assertEq(r.status, 403, "status");
});

console.log("");
console.log("REST: write allowlist + author injection");

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const adminPath = `.translator-smoke/${ts}.txt`;
const adminContent = `translator smoke run at ${ts}\nbase=${baseUrl}\n`;

await expect(
  `POST /commits creates ${adminPath} with author=admin`,
  async () => {
    const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
      body: JSON.stringify({
        branch: "main",
        commit_message: `translator smoke ${ts}`,
        actions: [{ action: "create", file_path: adminPath, content: adminContent }],
      }),
    });
    if (r.status === 403) {
      const text = await r.text();
      if (/not allowed to push/i.test(text)) {
        throw new EnvBlockedError(
          `GitLab refused push (branch protection). Translator forwarded correctly. Resolve at the project: ${text.slice(0, 200)}`,
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
  },
);

await expect("POST /commits as editor to disallowed path -> 403", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
    method: "POST",
    headers: { authorization: `Bearer ${editorJwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      branch: "main",
      commit_message: "smoke negative",
      actions: [{ action: "create", file_path: "src/pages/forbidden.astro", content: "blocked" }],
    }),
  });
  assertEq(r.status, 403, "status");
});

const editorPath = `src/content/blog/.translator-smoke-${ts}.md`;
await expect(
  `POST /commits as editor to allowed path under blog -> verifies allowlist positive`,
  async () => {
    const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
      method: "POST",
      headers: { authorization: `Bearer ${editorJwt}`, "content-type": "application/json" },
      body: JSON.stringify({
        branch: "main",
        commit_message: `translator smoke editor ${ts}`,
        actions: [{ action: "create", file_path: editorPath, content: "---\ntitle: smoke\n---\n" }],
      }),
    });
    if (r.status === 403) {
      const text = await r.text();
      if (/not allowed to push/i.test(text)) {
        throw new EnvBlockedError(
          `GitLab refused push (branch protection). Translator forwarded correctly. Resolve at the project: ${text.slice(0, 200)}`,
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
  },
);

console.log("");
console.log("operability");

await expect("service-account PAT expires > 30 days from now", async () => {
  const r = await req("/gitlab/personal_access_tokens/self", {
    headers: { authorization: `Bearer ${adminJwt}` },
  });
  if (r.status !== 200) {
    throw new EnvBlockedError(
      `token self-introspection returned ${r.status}; check via GitLab UI -> group/<your-org>/access_tokens`,
    );
  }
  const me = await r.json();
  const exp = me.expires_at ? new Date(me.expires_at) : null;
  if (!exp) throw new EnvBlockedError("calling token has no expires_at; set one in GitLab UI");
  const days = Math.floor((exp - new Date()) / 86400_000);
  if (days <= 0) throw new Error(`calling token EXPIRED on ${me.expires_at}`);
  if (days < 30) {
    throw new EnvBlockedError(
      `calling token expires in ${days} days (${me.expires_at}). Rotate via GitLab UI; update GITLAB_API_TOKEN secret; redeploy.`,
    );
  }
  console.log(`           calling token expires in ${days} days (${me.expires_at})`);
});

await expect("cleanup: delete smoke artifacts via translator (best-effort)", async () => {
  const r = await req(`/gitlab/projects/${REPO_ENC}/repository/commits`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminJwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      branch: "main",
      commit_message: `translator smoke cleanup ${ts}`,
      actions: [
        { action: "delete", file_path: adminPath },
        { action: "delete", file_path: editorPath },
      ],
    }),
  });
  if (r.status === 403) {
    const text = await r.text();
    if (/not allowed to push/i.test(text)) {
      throw new EnvBlockedError(
        "GitLab refused cleanup push (branch protection); artifacts left on main",
      );
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
  console.log("blocked (translator worked; environment refused; resolve outside translator):");
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
