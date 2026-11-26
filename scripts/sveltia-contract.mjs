#!/usr/bin/env node
// sveltia-contract <dir of an installed @sveltia/cms package>
//
// Checks that this translator serves what that Sveltia release's
// GitLab backend sends. The backend chunk is read as text, never run;
// every GraphQL document and REST path in it goes through the Worker
// itself (upstream stubbed) as a signed-in editor of a synthetic repo.
//
// Exit 0: every call is served, or denied and listed in
//         CONTRACT_EXCLUSIONS (src/contract.ts).
// Exit 1: a call is denied, or loses a query parameter the route does
//         not forward; each is listed with its key and at= reason.
// Exit 2: no chunk, or fewer than MIN_DOCS GraphQL documents or
//         MIN_PATHS REST paths: Sveltia moved its GitLab backend or
//         the extraction was partial, and a check that finds little
//         must not pass. The floors are a tripwire, not a spec.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit, stdout } from "node:process";
import { install } from "./loader.mjs";

install();
const { createWorker } = await import("../src/worker.ts");
const { signSession } = await import("../src/jwt.ts");
const { exclusionFor } = await import("../src/contract.ts");
const { graphqlDocs, restPaths } = await import("./sveltia-chunk.mjs");

const say = (line = "") => stdout.write(`${line}\n`);
function broken(msg) {
  say(`sveltia-contract: ${msg}`);
  exit(2);
}

const dir = argv[2];
if (!dir || argv.length > 3) broken("usage: sveltia-contract <path to node_modules/@sveltia/cms>");
const CHUNK = join("dist", "chunks", "gitlab.js");
const chunkPath = join(dir, CHUNK);
if (!existsSync(chunkPath)) broken(`no ${CHUNK} under ${dir}; Sveltia moved its GitLab backend`);
let version = "?";
try {
  version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "?";
} catch {}
const text = readFileSync(chunkPath, "utf8");

let docs;
let paths;
try {
  docs = graphqlDocs(text);
  paths = restPaths(text);
} catch (err) {
  broken(`${CHUNK}: ${err.message}`);
}
const MIN_DOCS = 5;
const MIN_PATHS = 5;
if (docs.length < MIN_DOCS) broken(`${CHUNK}: ${docs.length} GraphQL documents found, expected at least ${MIN_DOCS}; partial extraction`);
if (paths.length < MIN_PATHS) broken(`${CHUNK}: ${paths.length} REST paths found, expected at least ${MIN_PATHS}; partial extraction`);

const REPO = "contract/site";
const EMAIL = "editor@contract.test";
const ORIGIN = "https://translator.contract.test";
const SECRET = "contract-check";
const editors = `
repos:
  ${REPO}:
    branch: main
    write_roots:
      "content/**": [md]
${EMAIL}:
  ${REPO}: ["content/**"]
`;
const worker = createWorker({ editors, name: "contract" });
const env = {
  JWT_SECRET: SECRET,
  GITLAB_API_TOKEN: "not-a-token",
  OAUTH_CLIENT_ID: "x",
  OAUTH_CLIENT_SECRET: "x",
  ALLOWED_DOMAIN: "contract.test",
  ALLOWED_SITES: "contract.test",
};
const now = Math.floor(Date.now() / 1000);
const jwt = await signSession(
  { sub: EMAIL, email: EMAIL, name: "Contract", iss: ORIGIN, aud: ORIGIN, iat: now, exp: now + 600 },
  SECRET,
);

// The Worker's upstream calls and log lines, per request.
let forwarded = [];
let logged = [];
globalThis.fetch = async (url) => {
  forwarded.push(String(url));
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
const log = console.log;

async function send(path, method, body) {
  forwarded = [];
  logged = [];
  console.log = (line) => logged.push(String(line));
  try {
    const r = await worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    return { status: r.status, detail: r.status >= 400 ? ((await r.json().catch(() => ({}))).detail ?? "") : "" };
  } finally {
    console.log = log;
  }
}

// at= from the Worker's deny line, else the event name, else the status.
function reason({ status, detail }) {
  for (const line of logged) {
    const at = / at=(\S+)/.exec(line)?.[1];
    if (at) return at;
    const event = /\.deny\.(\w+)/.exec(line)?.[1];
    if (event) return `deny.${event}`;
  }
  return `${status}${detail ? ` ${detail}` : ""}`;
}

const results = []; // { verdict: ok|excluded|denied, key, label, why }
function record(key, label, why) {
  const ex = exclusionFor(key);
  results.push(ex ? { verdict: "excluded", key, label, why: ex.why } : { verdict: "denied", key, label, why });
}

for (const doc of docs) {
  const vars = Object.fromEntries([...doc.text.matchAll(/\$(\w+)\s*:/g)].map((m) => [m[1], REPO]));
  const r = await send("/gitlab/graphql", "POST", { query: doc.text, variables: vars });
  const label = doc.text.length > 140 ? `${doc.text.slice(0, 137)}...` : doc.text;
  if (r.status === 200) {
    results.push({ verdict: "ok", key: "graphql", label });
  } else {
    const at = reason(r);
    record(`graphql ${at}`, label, `at=${at}`);
  }
}

const COMMIT = { branch: "main", commit_message: "contract", actions: [{ action: "create", file_path: "content/a.md", content: "x" }] };
const seen = new Set();
for (const p of paths) {
  const [rawPath, rawQuery = ""] = p.path.split("?");
  const shape = rawPath
    .replace(/^\/projects\/x(?=\/|$)/, "/projects/{repo}")
    .replace(/\/x(?=\/|$)/g, "/{}")
    .replace(/^\//, "");
  const params = rawQuery ? rawQuery.split("&").map((kv) => kv.split("=")[0]) : [];
  const label = `${p.method} ${p.path.replace(/^\/projects\/x/, `/projects/{repo}`)}`;
  if (seen.has(label)) continue;
  seen.add(label);
  if (p.unresolved) {
    record(`rest ${p.method} {}${shape.replace(/^\{[^}]*\}/, "")}`, label, "path prefix not resolvable from the chunk");
    continue;
  }
  const url = `/gitlab${rawPath.replace(/^\/projects\/x(?=\/|$)/, `/projects/${encodeURIComponent(REPO)}`)}${rawQuery ? `?${rawQuery}` : ""}`;
  const body = p.method === "GET" || p.method === "DELETE" ? undefined : COMMIT;
  const r = await send(url, p.method, body);
  if (r.status >= 400) {
    const why = reason(r);
    record(`rest ${p.method} ${shape}`, label, `at=${why}`);
    continue;
  }
  const sent = forwarded[0] ? new URL(forwarded[0]).searchParams : null;
  const dropped = sent ? params.filter((k) => !sent.has(k)) : [];
  if (dropped.length === 0) {
    results.push({ verdict: "ok", key: "rest", label, why: p.unknown.length ? `unchecked query: ${p.unknown.join(", ")}` : "" });
  }
  for (const k of dropped) record(`rest ${p.method} ${shape}?${k}`, label, `at=query(${k}) dropped`);
}

say(`sveltia-contract: @sveltia/cms ${version}, ${CHUNK}: ${docs.length} graphql documents, ${seen.size} rest paths`);
for (const v of ["denied", "excluded", "ok"]) {
  for (const r of results.filter((x) => x.verdict === v)) {
    const tail = v === "ok" ? (r.why ? `  (${r.why})` : "") : `  [${r.key}] ${r.why}`;
    say(`${v.padEnd(8)} ${r.label}${tail}`);
  }
}
const unchecked = results.filter((r) => r.why?.startsWith("unchecked query"));
if (unchecked.length) {
  say(`sveltia-contract: ${unchecked.length} paths with query params the checker could not resolve (served, params unverified):`);
  for (const r of unchecked) say(`  ${r.label}  ${r.why}`);
}
const count = (v) => results.filter((r) => r.verdict === v).length;
say(`sveltia-contract: ${count("ok")} ok, ${count("excluded")} excluded, ${count("denied")} denied`);
exit(count("denied") ? 1 : 0);
