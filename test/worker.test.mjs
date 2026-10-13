// Offline contract test for the Worker fetch handler. Upstream GitLab is a
// mocked global fetch; identities come from test/fixtures/editors.yml.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import { buildAuthorizer, buildBranchResolver } from "../src/authorize.ts";
import { createWorker } from "../src/worker.ts";

const FIXTURE = new URL("./fixtures/editors.yml", import.meta.url);
const worker = createWorker({ editors: readFileSync(FIXTURE, "utf8") });

const SECRET = "test-secret";
const env = {
  JWT_SECRET: SECRET,
  GITLAB_API_TOKEN: "pat-not-real",
  OAUTH_CLIENT_ID: "id",
  OAUTH_CLIENT_SECRET: "secret",
  ALLOWED_DOMAIN: "example.org",
  ALLOWED_SITES: "example.com",
};

const enc = new TextEncoder();
const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const ORIGIN = "https://translator.test";

async function mintJwt(email, name, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = { sub: email, name, email, iss: ORIGIN, aud: ORIGIN, iat: now, exp: now + 600, ...claims };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey(
    "raw",
    enc.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await webcrypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

const REPO = encodeURIComponent("example-org/website");
const FILE = encodeURIComponent("src/content/blog/post.md");

console.log = () => {};

let upstream;
const realFetch = globalThis.fetch;

beforeEach(() => {
  upstream = [];
  globalThis.fetch = async (url, init) => {
    upstream.push({ url: String(url), init });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(path, { method = "GET", jwt, body, raw, contentType = "application/json" } = {}) {
  const headers = { "content-type": contentType };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  return worker.fetch(
    new Request(`https://translator.test${path}`, {
      method,
      headers,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }),
    env,
  );
}

const commit = (...file_paths) => ({
  branch: "main",
  commit_message: "t",
  actions: file_paths.map((file_path) => ({ action: "create", file_path, content: "x" })),
});

describe("default-deny", () => {
  test("'//' prefix cannot skip the read allowlist", async () => {
    const jwt = await mintJwt("stranger@example.org", "Nobody");
    const r = await call(`/gitlab//projects/${REPO}/repository/files/${FILE}/raw`, { jwt });
    assert.ok([400, 403].includes(r.status), `status ${r.status}`);
    assert.equal(upstream.length, 0);
  });

  test("'//' prefix cannot skip the write allowlist", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const r = await call(`/gitlab//projects/${REPO}/repository/commits`, {
      method: "POST",
      jwt,
      body: commit("package.json"),
    });
    assert.ok([400, 403].includes(r.status), `status ${r.status}`);
    assert.equal(upstream.length, 0);
  });

  test("dot segments and backslashes never reach upstream", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    for (const p of [
      `/gitlab/projects/%2e%2e/${REPO}`,
      `/gitlab/projects/${REPO}/repository/tree/`,
    ]) {
      const r = await call(p, { jwt });
      assert.ok([400, 403].includes(r.status), `${p} -> ${r.status}`);
    }
    const r = await call(`/gitlab/projects/${REPO}%5Crepository/tree`, { jwt });
    assert.equal(r.status, 400);
    assert.equal(upstream.length, 0);
  });

  test("malformed percent-encoding in the repo segment is 400, not 500", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const r = await call("/gitlab/projects/%E0%A4%A/repository/tree", { jwt });
    assert.equal(r.status, 400);
  });

  test("a path no route covers is denied without calling upstream", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    for (const [method, p] of [
      ["GET", "/gitlab/groups/example-org"],
      ["GET", `/gitlab/projects/${REPO}/variables`],
      ["PUT", `/gitlab/projects/${REPO}/repository/files/${FILE}`],
      ["DELETE", `/gitlab/projects/${REPO}/repository/branches/main`],
      ["GET", `/gitlab/projects/${REPO}/repository%2Ftree`],
    ]) {
      const r = await call(p, { method, jwt });
      assert.equal(r.status, 403, `${method} ${p}`);
    }
    assert.equal(upstream.length, 0);
  });

  test("repo names that are Object.prototype keys are not allowlisted", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    for (const name of ["constructor", "__proto__", "toString"]) {
      const r = await call(`/gitlab/projects/${name}/repository/tree`, { jwt });
      assert.equal(r.status, 403, name);
    }
    assert.equal(upstream.length, 0);
  });

  test("an editor with no entry for the repo is denied reads", async () => {
    const jwt = await mintJwt("stranger@example.org", "Nobody");
    const r = await call(`/gitlab/projects/${REPO}/repository/tree`, { jwt });
    assert.equal(r.status, 403);
    assert.equal(upstream.length, 0);
  });

  test("commit outside the editor's globs is denied, including via previous_path", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const outside = await call(`/gitlab/projects/${REPO}/repository/commits`, {
      method: "POST",
      jwt,
      body: commit("package.json"),
    });
    assert.equal(outside.status, 403);
    const moved = await call(`/gitlab/projects/${REPO}/repository/commits`, {
      method: "POST",
      jwt,
      body: {
        branch: "main",
        commit_message: "t",
        actions: [{ action: "move", file_path: "src/content/blog/a.md", previous_path: "package.json" }],
      },
    });
    assert.equal(moved.status, 403);
    assert.equal(upstream.length, 0);
  });
});

describe("allowed traffic", () => {
  test("allowlisted file read is forwarded under the PAT", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const r = await call(`/gitlab/projects/${REPO}/repository/files/${FILE}/raw?ref=main`, { jwt });
    assert.equal(r.status, 200);
    assert.equal(upstream.length, 1);
    assert.equal(
      upstream[0].url,
      `https://gitlab.com/api/v4/projects/${REPO}/repository/files/${FILE}/raw?ref=main`,
    );
    assert.equal(upstream[0].init.headers.authorization, "Bearer pat-not-real");
  });

  test("commit inside the editor's globs is forwarded with the editor as author", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const r = await call(`/gitlab/projects/${REPO}/repository/commits`, {
      method: "POST",
      jwt,
      body: commit("src/content/blog/new.md"),
    });
    assert.equal(r.status, 200);
    const sent = JSON.parse(upstream[0].init.body);
    assert.equal(sent.author_email, "editor@example.org");
    assert.equal(sent.author_name, "Smoke Teacher");
  });

  test("users?search is synthesized for an allowlisted identity, never forwarded", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const r = await call(`/gitlab/projects/${REPO}/users?search=root`, { jwt });
    assert.equal(r.status, 200);
    const list = await r.json();
    assert.ok(list.some((u) => u.id === 0));
    assert.equal(upstream.length, 0);
  });

  test("users?search is denied for an identity with no entry", async () => {
    const jwt = await mintJwt("stranger@example.org", "Nobody");
    const r = await call(`/gitlab/projects/${REPO}/users?search=nobody`, { jwt });
    assert.equal(r.status, 403);
  });

  test("/user is synthesized from the JWT", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const r = await call("/gitlab/user", { jwt });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).email, "root@example.org");
    assert.equal(upstream.length, 0);
  });
});

describe("oauth", () => {
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  let googleUser;
  let idClaims;

  const idToken = (claims) =>
    ["{}", JSON.stringify(claims), "sig"].map((p) => Buffer.from(p).toString("base64url")).join(".");

  beforeEach(() => {
    idClaims = {};
    googleUser = { email: "root@example.org", email_verified: true, hd: "example.org" };
    globalThis.fetch = async (url, init) => {
      upstream.push({ url: String(url), init });
      if (String(url) === TOKEN_URL) {
        const claims = {
          iss: "https://accounts.google.com",
          aud: env.OAUTH_CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 3600,
          ...googleUser,
          ...idClaims,
        };
        return Response.json({ access_token: "at", id_token: idToken(claims) });
      }
      return new Response("unexpected", { status: 500 });
    };
  });

  async function authorize(e = env, site = "example.com") {
    const r = await worker.fetch(
      new Request(`${ORIGIN}/oauth/authorize?provider=gitlab&site_id=${encodeURIComponent(site)}&scope=api`),
      e,
    );
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get("location"));
    return { loc, state: loc.searchParams.get("state"), setCookie: r.headers.get("set-cookie") };
  }

  const cookieOf = (setCookie) => setCookie.split(";")[0];

  async function callback(state, cookie, e = env) {
    return worker.fetch(
      new Request(`${ORIGIN}/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
        headers: cookie ? { cookie } : {},
      }),
      e,
    );
  }

  async function signIn(e = env) {
    const { state, setCookie } = await authorize(e);
    return callback(state, cookieOf(setCookie), e);
  }

  const exchanged = () => upstream.some((u) => u.url === TOKEN_URL);
  const delivered = (html) => html.includes("authorization:gitlab:success");
  const scripts = (html) => html.match(/<script/gi)?.length ?? 0;

  test("authorize sends a PKCE S256 challenge and sets the verifier cookie", async () => {
    const { loc, setCookie } = await authorize();
    assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
    assert.match(loc.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
    assert.match(setCookie, /^__Host-translator_pkce=[A-Za-z0-9_-]{43};/);
    for (const attr of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=600"]) {
      assert.ok(setCookie.includes(`; ${attr}`), attr);
    }
    const verifier = cookieOf(setCookie).split("=")[1];
    assert.ok(!loc.href.includes(verifier));
  });

  test("a signed-in editor gets a JWT bound to the translator, with the verifier sent to the IdP", async () => {
    const { loc, state, setCookie } = await authorize();
    const r = await callback(state, cookieOf(setCookie));
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(delivered(html));
    assert.match(r.headers.get("set-cookie"), /^__Host-translator_pkce=; .*Max-Age=0/);

    const sent = new URLSearchParams(upstream.find((u) => u.url === TOKEN_URL).init.body);
    const verifier = cookieOf(setCookie).split("=")[1];
    assert.equal(sent.get("code_verifier"), verifier);
    const digest = await webcrypto.subtle.digest("SHA-256", enc.encode(verifier));
    assert.equal(b64url(new Uint8Array(digest)), loc.searchParams.get("code_challenge"));

    const jwt = html.match(/\\"token\\":\\"([^\\]+)\\"/)[1];
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
    assert.equal(claims.iss, ORIGIN);
    assert.equal(claims.aud, ORIGIN);
    assert.equal(claims.exp - claims.iat, 8 * 3600);
    assert.equal(claims.name, "root");
    assert.equal((await call("/gitlab/user", { jwt })).status, 200);
  });

  test("the callback page runs one nonce'd script under a strict CSP, whatever the origin holds", async () => {
    const site = "x</script><script>alert(1)</script><!--\u2028\u2029'\"&";
    const e = { ...env, ALLOWED_SITES: site };
    const { state, setCookie } = await authorize(e, site);
    const r = await callback(state, cookieOf(setCookie), e);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.equal(scripts(html), 1);
    assert.equal(html.match(/<\/script/gi).length, 1);
    assert.ok(!/[\u2028\u2029]/.test(html));
    const nonce = html.match(/<script nonce="([^"]+)">/)[1];
    assert.equal(
      r.headers.get("content-security-policy"),
      `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    );
    const body = html.slice(html.indexOf(">", html.indexOf("<script")) + 1, html.indexOf("</script>"));
    const origin = JSON.parse(body.match(/var origin = (.*);/)[1]);
    assert.equal(origin, `https://${site}`);
  });

  test("an unsigned state is refused before the code is exchanged", async () => {
    const forged = Buffer.from(
      JSON.stringify({
        origin: "https://example.com",
        nonce: "n",
        providerTag: "</script><script>alert(1)</script>\u2028'\"",
      }),
    ).toString("base64url");
    const { setCookie } = await authorize();
    const r = await callback(forged, cookieOf(setCookie));
    assert.equal(r.status, 400);
    const html = await r.text();
    assert.equal(scripts(html), 0);
    assert.ok(!exchanged());
  });

  test("a state with another flow's signature is refused", async () => {
    const a = await authorize();
    const b = await authorize();
    const [h, payload] = a.state.split(".");
    const spliced = `${h}.${payload}.${b.state.split(".")[2]}`;
    const r = await callback(spliced, cookieOf(a.setCookie));
    assert.equal(r.status, 400);
    assert.ok(!exchanged());
  });

  test("a three-part state with a garbage signature is refused", async () => {
    const a = await authorize();
    const [h, payload] = a.state.split(".");
    const r = await callback(`${h}.${payload}.AAAA`, cookieOf(a.setCookie));
    assert.equal(r.status, 400);
    assert.ok(!exchanged());
  });

  test("an id_token query parameter on the callback is ignored", async () => {
    const forgedClaims = idToken({ email: "attacker@evil.example", hd: "evil.example" });
    const bad = await authorize();
    const [h, payload] = bad.state.split(".");
    const refused = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/callback?code=c&state=${h}.${payload}.AAAA&id_token=${forgedClaims}`,
        { headers: { cookie: cookieOf(bad.setCookie) } },
      ),
      env,
    );
    assert.equal(refused.status, 400);
    assert.ok(!exchanged());
  });

  test("a token signed with the session key does not pass as state", async () => {
    const { loc, setCookie } = await authorize();
    const state = await mintJwt("x", "x", {
      origin: "https://example.com",
      challenge: loc.searchParams.get("code_challenge"),
    });
    const r = await callback(state, cookieOf(setCookie));
    assert.equal(r.status, 400);
    assert.ok(!exchanged());
  });

  test("a state for a site since removed from ALLOWED_SITES is refused", async () => {
    const e = { ...env, ALLOWED_SITES: "example.com,old.example" };
    const { state, setCookie } = await authorize(e, "old.example");
    const r = await callback(state, cookieOf(setCookie));
    assert.equal(r.status, 400);
    assert.ok(!exchanged());
  });

  test("an expired state is refused", async () => {
    const { state, setCookie } = await authorize();
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      const r = await callback(state, cookieOf(setCookie));
      assert.equal(r.status, 400);
    } finally {
      Date.now = realNow;
    }
    assert.ok(!exchanged());
  });

  test("a missing or mismatched verifier cookie is refused", async () => {
    const a = await authorize();
    const b = await authorize();
    assert.equal((await callback(a.state, null)).status, 400);
    assert.equal((await callback(a.state, cookieOf(b.setCookie))).status, 400);
    assert.ok(!exchanged());
  });

  test("an empty ALLOWED_DOMAIN refuses every sign-in before the code is exchanged", async () => {
    const r = await signIn({ ...env, ALLOWED_DOMAIN: "" });
    assert.notEqual(r.status, 200);
    assert.ok(!delivered(await r.text()));
    assert.ok(!exchanged());
  });

  for (const [label, user] of [
    ["hd from another domain", { email: "root@example.org", email_verified: true, hd: "evil.example" }],
    ["no hd", { email: "root@example.org", email_verified: true }],
    ["unverified email", { email: "root@example.org", email_verified: false, hd: "example.org" }],
    ["no editors.yml entry", { email: "stranger@example.org", email_verified: true, hd: "example.org" }],
  ]) {
    test(`${label} gets no JWT`, async () => {
      googleUser = user;
      const r = await signIn();
      assert.equal(r.status, 403);
      assert.ok(!delivered(await r.text()));
    });
  }

  for (const [label, claims] of [
    ["wrong aud", { aud: "someone-else" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 1 }],
    ["wrong iss", { iss: "https://evil.example" }],
  ]) {
    test(`an id_token with ${label} gets no JWT`, async () => {
      idClaims = claims;
      const r = await signIn();
      assert.equal(r.status, 403);
      assert.ok(!delivered(await r.text()));
    });
  }

  test("the bare accounts.google.com issuer and an aud array are accepted", async () => {
    idClaims = { iss: "accounts.google.com", aud: ["other", env.OAUTH_CLIENT_ID] };
    assert.ok(delivered(await (await signIn()).text()));
  });

  test("a token response without an id_token gets no JWT", async () => {
    const f = globalThis.fetch;
    globalThis.fetch = async (url, init) =>
      String(url) === TOKEN_URL ? Response.json({ access_token: "at" }) : f(url, init);
    const r = await signIn();
    assert.equal(r.status, 403);
    assert.ok(!delivered(await r.text()));
  });

  test("the callback page posts only to the allowlisted site origin", async () => {
    const { state, setCookie } = await authorize();
    const html = await (await callback(state, cookieOf(setCookie))).text();
    const body = html.slice(html.indexOf(">", html.indexOf("<script")) + 1, html.indexOf("</script>"));
    const calls = [...body.matchAll(/postMessage\(([^)]*)\)/g)];
    assert.equal(calls.length, 1);
    const target = calls[0][1].split(",").pop().trim();
    assert.equal(target, "origin");
    assert.equal(JSON.parse(body.match(/var origin = (.*);/)[1]), "https://example.com");
    assert.ok(!body.includes("'*'") && !body.includes('"*"'));
  });

  test("a throw inside the callback still clears the verifier cookie", async () => {
    const { state, setCookie } = await authorize();
    globalThis.fetch = async () => {
      throw new Error("network");
    };
    const r = await callback(state, cookieOf(setCookie));
    assert.equal(r.status, 500);
    assert.match(r.headers.get("set-cookie"), /^__Host-translator_pkce=; .*Max-Age=0/);
  });

  test("a non-editor is told who to ask, not why", async () => {
    googleUser = { email: "stranger@example.org", email_verified: true, hd: "example.org" };
    const html = await (await signIn()).text();
    assert.ok(html.includes("not set up as an editor"));
    assert.ok(!html.includes("nobody@"));
  });

  test("a JWT with the wrong issuer, audience or expiry is 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { iss: "https://elsewhere.test" },
      { aud: "https://elsewhere.test" },
      { iss: undefined, aud: undefined },
      { exp: now - 1 },
    ]) {
      const jwt = await mintJwt("root@example.org", "Root", claims);
      const r = await call("/gitlab/user", { jwt });
      assert.equal(r.status, 401, JSON.stringify(claims));
    }
  });
});

describe("sites", () => {
  test("unknown site_id is 400", async () => {
    const r = await call("/oauth/authorize?provider=gitlab&site_id=evil.example&scope=api");
    assert.equal(r.status, 400);
  });

  test("listed site_id redirects to the IdP", async () => {
    const r = await call("/oauth/authorize?provider=gitlab&site_id=example.com&scope=api");
    assert.equal(r.status, 302);
  });

  test("missing ALLOWED_SITES refuses every site instead of throwing", async () => {
    const r = await worker.fetch(
      new Request("https://translator.test/oauth/authorize?provider=gitlab&site_id=example.com&scope=api"),
      { ...env, ALLOWED_SITES: undefined },
    );
    assert.equal(r.status, 400);
  });
});

describe("commit body", () => {
  const COMMITS = `/gitlab/projects/${REPO}/repository/commits`;

  test("a form-encoded commit is refused and never forwarded", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const raw = new URLSearchParams({
      branch: "main",
      commit_message: "t",
      "actions[][action]": "create",
      "actions[][file_path]": "package.json",
      "actions[][content]": "x",
    }).toString();
    for (const contentType of ["application/x-www-form-urlencoded", "text/plain"]) {
      const r = await call(COMMITS, { method: "POST", jwt, raw, contentType });
      assert.equal(r.status, 400, contentType);
    }
    const smuggled = await call(COMMITS, {
      method: "POST",
      jwt,
      raw: JSON.stringify(commit("src/content/blog/a.md")),
      contentType: "text/plain",
    });
    assert.equal(smuggled.status, 400);
    assert.equal(upstream.length, 0);
  });

  test("the client query string never reaches the commit upstream", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const r = await call(
      `${COMMITS}?actions[][action]=create&actions[][file_path]=package.json&private_token=x`,
      { method: "POST", jwt, body: commit("src/content/blog/a.md") },
    );
    assert.equal(r.status, 200);
    assert.equal(upstream[0].url, `https://gitlab.com/api/v4/projects/${REPO}/repository/commits`);
    assert.equal(upstream[0].init.headers["content-type"], "application/json");
  });

  test("only the fields Sveltia sends are forwarded", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const r = await call(COMMITS, {
      method: "POST",
      jwt,
      body: {
        branch: "main",
        commit_message: "t",
        start_branch: "main",
        start_project: 1,
        force: true,
        author_email: "someone@else.example",
        actions: [
          {
            action: "update",
            file_path: "src/content/blog/a.md",
            content: "eA==",
            encoding: "base64",
            execute_filemode: true,
            last_commit_id: "abc",
          },
        ],
      },
    });
    assert.equal(r.status, 200);
    const sent = JSON.parse(upstream[0].init.body);
    assert.deepEqual(Object.keys(sent).sort(), [
      "actions",
      "author_email",
      "author_name",
      "branch",
      "commit_message",
    ]);
    assert.equal(sent.author_email, "editor@example.org");
    assert.deepEqual(sent.actions, [
      { action: "update", file_path: "src/content/blog/a.md", content: "eA==", encoding: "base64" },
    ]);
  });

  test("non-string file_path or previous_path is 403, not a 500 or a stringified array", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    for (const action of [
      { action: "create", file_path: { toString: "src/content/blog/a.md" }, content: "x" },
      { action: "create", file_path: ["src/content/blog/a.md"], content: "x" },
      { action: "create", file_path: ["src/content/blog/a.md", "package.json"], content: "x" },
      { action: "move", file_path: "src/content/blog/a.md", previous_path: ["package.json"] },
      { action: "move", file_path: "src/content/blog/a.md", previous_path: { p: "package.json" } },
      { action: "move", file_path: "src/content/blog/a.md", previous_path: null },
      { action: "create", file_path: "src/content/blog/a.md", content: ["x"] },
    ]) {
      const r = await call(COMMITS, {
        method: "POST",
        jwt,
        body: { branch: "main", commit_message: "t", actions: [action] },
      });
      assert.equal(r.status, 403, JSON.stringify(action));
    }
    assert.equal(upstream.length, 0);
  });

  test("an action Sveltia never sends, or no actions, is 403", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    for (const actions of [
      [{ action: "chmod", file_path: "src/content/blog/a.md", execute_filemode: true }],
      [],
      "create",
    ]) {
      const r = await call(COMMITS, {
        method: "POST",
        jwt,
        body: { branch: "main", commit_message: "t", actions },
      });
      assert.equal(r.status, 403, JSON.stringify(actions));
    }
    assert.equal(upstream.length, 0);
  });
});

describe("query strings and account routes", () => {
  test("parameters a route does not use are dropped", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const r = await call(
      `/gitlab/projects/${REPO}/repository/files/${FILE}/raw?private_token=x&ref=main&sudo=1&lfs=true`,
      { jwt },
    );
    assert.equal(r.status, 200);
    assert.equal(
      upstream[0].url,
      `https://gitlab.com/api/v4/projects/${REPO}/repository/files/${FILE}/raw?ref=main&lfs=true`,
    );
    await call(`/gitlab/projects/${REPO}/repository/branches/main?sudo=1`, { jwt });
    assert.equal(
      upstream[1].url,
      `https://gitlab.com/api/v4/projects/${REPO}/repository/branches/main`,
    );
  });

  test("/avatar and /personal_access_tokens/self need an editors.yml identity", async () => {
    const stranger = await mintJwt("stranger@example.org", "Nobody");
    for (const p of ["/gitlab/avatar?email=a%40b.c&size=48", "/gitlab/personal_access_tokens/self"]) {
      const r = await call(p, { jwt: stranger });
      assert.equal(r.status, 403, p);
    }
    assert.equal(upstream.length, 0);

    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const r = await call("/gitlab/avatar?email=a%40b.c&size=48&sudo=1", { jwt });
    assert.equal(r.status, 200);
    assert.equal(upstream[0].url, "https://gitlab.com/api/v4/avatar?email=a%40b.c&size=48");
  });
});

// Copied from @sveltia/cms (dist/sveltia-cms.js, GitLab backend) at the
// version website pins. Sveltia collapses whitespace and fills
// $fullPath and $branch before sending.
const SVELTIA_QUERIES = {
  rootRef: `
  query($fullPath: ID!) {
    project(fullPath: $fullPath) {
      repository {
        rootRef
      }
    }
  }
`,
  lastCommit: `
  query($fullPath: ID!, $branch: String!) {
    project(fullPath: $fullPath) {
      repository {
        tree(ref: $branch) {
          lastCommit {
            sha
            message
          }
        }
      }
    }
  }
`,
  fileList: `
  query($fullPath: ID!, $branch: String!, $cursor: String!) {
    project(fullPath: $fullPath) {
      repository {
        tree(ref: $branch, recursive: true) {
          blobs(after: $cursor) {
            nodes {
              type
              path
              sha
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    }
  }
`,
  blobs: `
  query($fullPath: ID!, $branch: String!, $paths: [String!]!) {
    project(fullPath: $fullPath) {
      repository {
        blobs(ref: $branch, paths: $paths) {
          nodes {
            rawTextBlob
          }
        }
      }
    }
  }
`,
  mergeRequestBlobs: `
  query($fullPath: ID!, $branch: String!, $paths: [String!]!) {
    project(fullPath: $fullPath) {
      repository {
        blobs(ref: $branch, paths: $paths) {
          nodes {
            path
            oid
            size
            rawTextBlob
          }
        }
      }
    }
  }
`,
};

const sveltiaVariables = (fullPath) => ({
  fullPath,
  branch: "main",
  cursor: "",
  paths: ["src/content/blog/a.md"],
});

async function gql(jwt, query, variables) {
  return call("/gitlab/graphql", { method: "POST", jwt, body: { query, variables } });
}

describe("commit guards", () => {
  const COMMITS_URL = `/gitlab/projects/${REPO}/repository/commits`;

  test("dot and empty path segments in file_path are denied without upstream", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    for (const p of [
      "src/content/blog/../../package.json",
      "src/content/blog/./a.md",
      "src/content/blog//a.md",
      "src/content/blog/a.md/",
      "./src/content/blog/a.md",
    ]) {
      const r = await call(COMMITS_URL, { method: "POST", jwt, body: commit(p) });
      assert.equal(r.status, 403, p);
    }
    assert.equal(upstream.length, 0);
  });

  test("a commit body over the cap is 413 without upstream", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const big = JSON.stringify({ ...commit("src/content/blog/a.md"), pad: "x".repeat(26 * 1024 * 1024) });
    const r = await call(COMMITS_URL, { method: "POST", jwt, raw: big });
    assert.equal(r.status, 413);
    assert.equal(upstream.length, 0);
  });

  test("a commit body with pathological nesting is 400 or 403, never a 500", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const depth = 50000;
    const raw = `{"branch":"main","commit_message":"t","actions":[{"action":"create","file_path":"src/content/blog/a.md","content":"x","pad":${"[".repeat(depth)}${"]".repeat(depth)}}]}`;
    const r = await call(COMMITS_URL, { method: "POST", jwt, raw });
    assert.ok([200, 400, 403].includes(r.status), `status ${r.status}`);
  });
});

describe("graphql", () => {
  test("Sveltia's queries are forwarded for an allowlisted repo, printed, with declared variables only", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    for (const [name, doc] of Object.entries(SVELTIA_QUERIES)) {
      const query = doc.replace(/\n\s*/g, " ");
      const r = await gql(jwt, query, { ...sveltiaVariables("example-org/website"), extra: "x" });
      assert.equal(r.status, 200, name);
      const sent = JSON.parse(upstream.at(-1).init.body);
      assert.equal(upstream.at(-1).url, "https://gitlab.com/api/graphql");
      assert.equal(sent.variables.fullPath, "example-org/website", name);
      assert.equal(sent.variables.extra, undefined, name);
      assert.deepEqual(
        Object.keys(sent.variables).sort(),
        [...query.matchAll(/\$(\w+):/g)].map((m) => m[1]).sort(),
        name,
      );
    }
    assert.equal(upstream.length, Object.keys(SVELTIA_QUERIES).length);
  });

  test("the forwarded query is the checked AST, not the client's text", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const query = SVELTIA_QUERIES.rootRef.replace("rootRef", "rootRef # c\n");
    const r = await gql(jwt, query, { fullPath: "example-org/website" });
    assert.equal(r.status, 200);
    const sent = JSON.parse(upstream[0].init.body);
    assert.ok(!sent.query.includes("#"), sent.query);
    assert.ok(sent.query.includes("rootRef"), sent.query);
  });

  test("Sveltia's queries are denied for a repo the identity has no entry for", async () => {
    const jwt = await mintJwt("editor@example.org", "Smoke Teacher");
    const stranger = await mintJwt("stranger@example.org", "Nobody");
    for (const doc of Object.values(SVELTIA_QUERIES)) {
      const query = doc.replace(/\n\s*/g, " ");
      assert.equal((await gql(jwt, query, sveltiaVariables("example-org/translator"))).status, 403);
      assert.equal((await gql(stranger, query, sveltiaVariables("example-org/website"))).status, 403);
    }
    assert.equal(upstream.length, 0);
  });

  test("a missing fullPath variable is 400", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const r = await gql(jwt, SVELTIA_QUERIES.rootRef, {});
    assert.equal(r.status, 400);
    assert.equal(upstream.length, 0);
  });

  test("every bypass shape is 403 with no upstream call", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const RR = "repository { rootRef }";
    const bypasses = [
      "mutation ,M{commitCreate(input:{projectPath:\"example-org/website\",branch:\"main\",commitMessage:\"x\",actions:[]}){errors}}",
      "mutation #c\nM{commitCreate(input:{}){errors}}",
      "mutation @a{commitCreate(input:{}){errors}}",
      "mutation{commitCreate(input:{}){errors}}",
      "query Q($fullPath: ID!) { project(fullPath: $fullPath) { " + RR + " } } mutation M { commitCreate(input:{}){errors} }",
      `query { project(fullPath: "example-org/meta") { ${RR} } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { ${RR} } other: project(fullPath: "example-org/meta") { ${RR} } }`,
      `query($fullPath: ID!) { p: project(fullPath: $fullPath) { ${RR} } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { ${RR} } projects { nodes { fullPath } } }`,
      `query($fullPath: ID!) { projects { nodes { fullPath } } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { group { projects { nodes { ${RR} } } } } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { repository { blobs(ref: "main", paths: ["a"]) { nodes { rawTextBlob } } } } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { repository { r: rootRef } } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { __typename ${RR} } }`,
      `query($fullPath: ID!) { ...F } fragment F on Query { project(fullPath: $fullPath) { ${RR} } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { ... on Project { ${RR} } } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) @include(if: true) { ${RR} } }`,
      `query($fullPath: ID! = "example-org/meta") { project(fullPath: $fullPath) { ${RR} } }`,
      `query($fullPath: ID!, $other: ID!) { project(fullPath: $other) { ${RR} } }`,
      `{ __schema { types { name } } }`,
      `subscription($fullPath: ID!) { project(fullPath: $fullPath) { ${RR} } }`,
      `query($fullPath: ID!) @live { project(fullPath: $fullPath) { ${RR} } }`,
      `query($fullPath: ID!) { group(fullPath: $fullPath) { ${RR} } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { repository { tree(ref: $fullPath, path: $fullPath) { lastCommit { sha } } } } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { repository { rootRef { sha } } } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { repository } }`,
      `query($fullPath: ID!) { project(fullPath: true) { ${RR} } }`,
      `query($a: ID!, $b: ID!) { project(fullPath: $a, fullPath: $b) { ${RR} } }`,
      `query($fullPath: ID!, $fullPath: ID!) { project(fullPath: $fullPath) { ${RR} } }`,
      `query($fullPath: ID!) { project(fullPath: $fullPath) { repository { tree(ref: $fullPath, ref: $fullPath) { lastCommit { sha } } } } }`,
    ];
    for (const query of bypasses) {
      const r = await gql(jwt, query, { fullPath: "example-org/website", other: "example-org/meta" });
      assert.equal(r.status, 403, query);
    }
    assert.equal(upstream.length, 0);
  });

  test("a document over the token limit is 400 with no upstream call", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const query = `query($fullPath: ID!) { project(fullPath: $fullPath) { repository { ${"rootRef ".repeat(1200)} } } }`;
    const r = await gql(jwt, query, { fullPath: "example-org/website" });
    assert.equal(r.status, 400);
    assert.equal(upstream.length, 0);
  });

  test("an oversized body is 413 by content-length and by read length", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const big = JSON.stringify({ query: SVELTIA_QUERIES.rootRef, variables: { pad: "x".repeat(300 * 1024) } });
    const r = await call("/gitlab/graphql", { method: "POST", jwt, raw: big });
    assert.equal(r.status, 413);
    const lying = await worker.fetch(
      new Request("https://translator.test/gitlab/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", "content-length": "999999999" },
        body: "{}",
      }),
      env,
    );
    assert.equal(lying.status, 413);
    assert.equal(upstream.length, 0);
  });

  test("deeply nested variables are 400, not an unhandled error", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const depth = 50000;
    const raw = `{"query":${JSON.stringify(SVELTIA_QUERIES.blobs)},"variables":{"fullPath":"example-org/website","paths":${"[".repeat(depth)}${"]".repeat(depth)}}}`;
    const r = await call("/gitlab/graphql", { method: "POST", jwt, raw });
    assert.ok([400, 413].includes(r.status), `status ${r.status}`);
    assert.equal(upstream.length, 0);
  });
});

const policy = parseYaml(readFileSync(FIXTURE, "utf8"));
const { repos: repoPolicies, ...editors } = policy;
const WEBSITE = "example-org/website";
const humans = Object.keys(editors).filter((e) => editors[e][WEBSITE]);
const WRITE_URL = `/gitlab/projects/${REPO}/repository/commits`;

async function commitAs(email, repo, ...paths) {
  const jwt = await mintJwt(email, "Editor");
  return call(`/gitlab/projects/${encodeURIComponent(repo)}/repository/commits`, {
    method: "POST",
    jwt,
    body: commit(...paths),
  });
}

describe("write roots", () => {
  test("the fixture reads every identity, root included", () => {
    assert.ok(humans.includes("root@example.org"));
    assert.ok(humans.length >= 4, humans.join());
  });

  test("no identity can write build, pipeline, page or admin files", async () => {
    for (const email of humans) {
      for (const path of [
        ".gitlab-ci.yml",
        "package.json",
        "astro.config.mjs",
        "wrangler.toml",
        "src/pages/x.astro",
        "public/admin/config.yml",
        "scripts/x.mjs",
        "src/content.config.ts",
        "src/content/private/x.md",
      ]) {
        const r = await commitAs(email, WEBSITE, path);
        assert.equal(r.status, 403, `${email} ${path}`);
      }
    }
    assert.equal(upstream.length, 0);
  });

  test("a forbidden path anywhere in a commit, or as previous_path, denies the whole commit", async () => {
    for (const email of humans) {
      const mixed = await commitAs(email, WEBSITE, "src/content/blog/ok.md", ".gitlab-ci.yml");
      assert.equal(mixed.status, 403, email);
      const jwt = await mintJwt(email, "Editor");
      const moved = await call(WRITE_URL, {
        method: "POST",
        jwt,
        body: {
          branch: "main",
          commit_message: "t",
          actions: [{ action: "move", file_path: "src/content/blog/a.md", previous_path: ".gitlab-ci.yml" }],
        },
      });
      assert.equal(moved.status, 403, email);
    }
    assert.equal(upstream.length, 0);
  });

  test("every identity can still write inside its own globs", async () => {
    for (const email of humans) {
      const globs = editors[email][WEBSITE];
      assert.ok(globs.length > 0, email);
      for (const glob of globs) {
        const path = glob.replace("**", glob.startsWith("public/") ? "probe.webp" : "probe.md");
        upstream.length = 0;
        const r = await commitAs(email, WEBSITE, path);
        assert.equal(r.status, 200, `${email} ${path}`);
        assert.equal(upstream.length, 1, `${email} ${path}`);
      }
    }
  });

  test("root writes content and media inside the roots", async () => {
    for (const path of [
      "src/content/blog/post.md",
      "src/content/classrooms/room.md",
      "src/content/people/p.yaml",
      "src/content/merch/m.yml",
      "src/content/merch/m.json",
      "public/images/uploads/a.jpg",
      "public/images/blog/post/a.webp",
      "public/images/blog/post/b.JPEG",
      "public/images/classrooms/a.png",
      "public/images/teachers/p/a.gif",
      "public/images/merch/a.avif",
      "public/images/blog/post/a.pdf",
      "src/content/blog/a.html.md",
      "src/content/blog/POST.MD",
    ]) {
      upstream.length = 0;
      const r = await commitAs("root@example.org", WEBSITE, path);
      assert.equal(r.status, 200, path);
      assert.equal(upstream.length, 1, path);
    }
  });

  test("types outside a root's allowlist are refused for every identity", async () => {
    for (const email of humans) {
      assert.ok(editors[email][WEBSITE].includes("src/content/blog/**"), email);
      for (const name of [
        "x.shtml",
        "x.xht",
        "x.xsl",
        "x.xsd",
        "x.rng",
        "x.rss",
        "x.svg",
        "x.html",
        "x.js",
        "x.mjs",
        "x.xml",
        "x.SVG",
        "x.Html",
        "x.svg.",
        "x.png",
        "x.jpg",
        "x.md.html",
        "x",
        ".md",
      ]) {
        const r = await commitAs(email, WEBSITE, `src/content/blog/${name}`);
        assert.equal(r.status, 403, `${email} ${name}`);
      }
    }
    for (const dir of ["uploads", "blog/post", "classrooms", "teachers/p", "merch"]) {
      for (const name of ["x.html", "x.svg", "x.js", "x.xml", "x.shtml", "x.md", "x.yml", "x"]) {
        const r = await commitAs("root@example.org", WEBSITE, `public/images/${dir}/${name}`);
        assert.equal(r.status, 403, `${dir}/${name}`);
      }
    }
    assert.equal(upstream.length, 0);
  });

  test("a repo with no write roots accepts no writes", async () => {
    for (const repo of ["example-org/design", "example-org/translator"]) {
      const r = await commitAs("root@example.org", repo, "editors.yml", "README.md");
      assert.equal(r.status, 403, repo);
    }
    assert.equal(upstream.length, 0);
  });
});

describe("commit branch pin", () => {
  const bodyWith = (extra) => ({ ...commit("src/content/blog/a.md"), ...extra });

  test("the configured branch commits; any other is refused before upstream", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const ok = await call(WRITE_URL, { method: "POST", jwt, body: bodyWith({}) });
    assert.equal(ok.status, 200);
    assert.equal(upstream.length, 1);
    upstream.length = 0;
    for (const branch of ["feature", "main2", "Main", "refs/heads/main", "main ", ""]) {
      const r = await call(WRITE_URL, { method: "POST", jwt, body: bodyWith({ branch }) });
      assert.equal(r.status, 403, JSON.stringify(branch));
    }
    assert.equal(upstream.length, 0);
  });

  test("start_branch cannot open a side branch and is never forwarded", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const r = await call(WRITE_URL, {
      method: "POST",
      jwt,
      body: bodyWith({ branch: "side", start_branch: "main" }),
    });
    assert.equal(r.status, 403);
    assert.equal(upstream.length, 0);
    const r2 = await call(WRITE_URL, { method: "POST", jwt, body: bodyWith({ start_branch: "other" }) });
    assert.equal(r2.status, 200);
    assert.equal(JSON.parse(upstream[0].init.body).start_branch, undefined);
  });

  test("a repo with no configured branch takes no commits", async () => {
    const jwt = await mintJwt("root@example.org", "Root");
    const r = await call(`/gitlab/projects/${encodeURIComponent("example-org/design")}/repository/commits`, {
      method: "POST",
      jwt,
      body: bodyWith({}),
    });
    assert.equal(r.status, 403);
    assert.equal(upstream.length, 0);
  });

  test("buildBranchResolver reads each repo's own branch", () => {
    const b = buildBranchResolver("repos:\n  g/r:\n    branch: trunk\n  g/s: {}\n");
    assert.equal(b("g/r"), "trunk");
    assert.equal(b("g/s"), undefined);
    assert.equal(b("constructor"), undefined);
  });
});

describe("buildAuthorizer", () => {
  const who = { email: "e@example.org", name: "E" };
  const ctx = (path, extra = {}) => ({ identity: who, repo: "g/r", method: "POST", path, ...extra });
  const build = (roots, globs) =>
    buildAuthorizer(
      `${roots ? `repos:\n  g/r:\n    write_roots: {${roots}}\n` : ""}e@example.org:\n  g/r: [${globs}]\n`,
    );

  test("write needs both a root and an identity glob", () => {
    const a = build('"c/**": [md], "m/**": [md]', '"c/**", "x/**"');
    assert.equal(a(ctx("c/a.md")), true);
    assert.equal(a(ctx("m/a.md")), false, "root but not the identity's glob");
    assert.equal(a(ctx("x/a.md")), false, "the identity's glob but not a root");
  });

  test("a '**' grant is clipped to the roots", () => {
    const a = build('"c/**": [md]', '"**"');
    assert.equal(a(ctx("c/a.md")), true);
    assert.equal(a(ctx("package.json")), false);
    assert.equal(a(ctx("*")), false);
  });

  test("a repo with a grant but no roots, or empty roots, takes no writes", () => {
    assert.equal(build(null, '"**"')(ctx("c/a.md")), false);
    assert.equal(build("", '"**"')(ctx("c/a.md")), false);
    const keyless = buildAuthorizer('repos:\n  g/r: {}\ne@example.org:\n  g/r: ["**"]\n');
    assert.equal(keyless(ctx("c/a.md")), false);
    assert.equal(build(null, '"**"')(ctx("c/a.md", { method: "GET" })), true);
  });

  test("reads need only the repo entry", () => {
    const a = build('"c/**": [md]', '"c/**"');
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.equal(a(ctx("package.json", { method })), true, method);
    }
    assert.equal(a(ctx("c/a.md", { method: "GET", repo: "g/other" })), false);
  });

  test("non-canonical paths cannot ride a root's glob", () => {
    const a = build('"c/**": [md]', '"**"');
    for (const path of ["c/../package.json", "c//a.md", "c/./a.md", "c/..", "c/a\\..\\x.md"]) {
      assert.equal(a(ctx(path)), false, path);
    }
  });

  test("control characters are refused in any path", () => {
    const a = build('"c/**": [md], "m/**": [png]', '"**"');
    for (const path of ["c/x.svg\u0000.md", "c/a\u0001.md", "m/a\u0000.png", "m/a\u007f.png", "c/a\n.md"]) {
      assert.equal(a(ctx(path)), false, JSON.stringify(path));
    }
  });

  test("a 'c/**' root and grant do not match siblings or traversal", () => {
    for (const globs of ['"c/**"', '"**"']) {
      const a = build('"c/**": [md]', globs);
      assert.equal(a(ctx("c/a.md")), true);
      for (const path of ["c-evil/a.md", "c/../x.md", "cc/a.md", "c.md"]) {
        assert.equal(a(ctx(path)), false, `${globs} ${path}`);
      }
    }
  });

  test("each root allows only its own extensions, case-insensitively", () => {
    const a = build('"c/**": [md], "m/**": [PNG]', '"**"');
    for (const method of ["POST", "PUT", "DELETE"]) {
      assert.equal(a(ctx("c/a.md", { method })), true, method);
      assert.equal(a(ctx("c/a.svg", { method })), false, method);
    }
    assert.equal(a(ctx("c/a.MD")), true);
    assert.equal(a(ctx("m/a.png")), true);
    assert.equal(a(ctx("m/a.Png")), true);
    assert.equal(a(ctx("m/a.md")), false, "extension of another root");
    assert.equal(a(ctx("c/a.html.md")), true);
    assert.equal(a(ctx("c/a.md.html")), false);
    for (const p of ["c/a", "c/.md", "c/a.", "c/a.md.", "c/dir.md/a"]) {
      assert.equal(a(ctx(p)), false, p);
    }
  });
});

describe("cors", () => {
  const send = (path, origin) =>
    worker.fetch(
      new Request(`https://translator.test${path}`, {
        method: path.endsWith("graphql") ? "POST" : "GET",
        headers: origin ? { origin } : {},
        body: path.endsWith("graphql") ? "{}" : undefined,
      }),
      env,
    );

  for (const path of ["/gitlab/user", "/gitlab/graphql"]) {
    test(`${path} echoes an allowed origin and no other`, async () => {
      const ok = await send(path, "https://example.com");
      assert.equal(ok.headers.get("access-control-allow-origin"), "https://example.com");
      assert.match(ok.headers.get("vary"), /Origin/);
      for (const o of ["https://evil.example", "http://example.com", null]) {
        const r = await send(path, o);
        assert.equal(r.headers.get("access-control-allow-origin"), null, String(o));
        assert.match(r.headers.get("vary"), /Origin/);
      }
    });
  }
});
