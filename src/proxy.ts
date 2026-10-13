// GitLab proxy.
//
// On every /gitlab/* request:
//   1. reject non-canonical paths (400)
//   2. validate the Authorization Bearer JWT against JWT_SECRET
//   3. match the request against the route table; anything unmatched
//      is denied (403) without calling upstream
//   4. require an editors.yml identity on account routes, the repo
//      allowlist on project routes and the per-path allowlist on
//      commits
//   5. swap the Authorization header to the service-account PAT
//   6. rebuild commit POSTs from the fields Sveltia sends and inject
//      author_name + author_email so git history shows the editor as
//      commit author
//   7. forward to gitlab.com/api/v4 with only the route's query
//      parameters
//
// The route table is the set of GitLab REST calls Sveltia makes in
// simple publish mode, plus the smoke test's probes. A Sveltia
// feature that needs another endpoint or parameter is a new entry.

import { verifySession, JWTError } from "./jwt";
import type { Authorizer, BranchResolver } from "./authorize";

const GITLAB_API = "https://gitlab.com/api/v4";

// Sveltia commits carry images base64-encoded in the JSON body.
const MAX_COMMIT_BYTES = 25 * 1024 * 1024;

export interface ProxyEnv {
  JWT_SECRET: string;
  GITLAB_API_TOKEN: string;
}

// Access-Control-Allow-Origin is added per request in index.ts.
const CORS_HEADERS = {
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

interface CommitAction {
  action: string;
  file_path: string;
  previous_path?: string;
  content?: string;
  encoding?: string;
}
interface CommitBody {
  branch: string;
  commit_message: string;
  actions: CommitAction[];
}

const COMMIT_ACTIONS = new Set(["create", "update", "delete", "move"]);
const OPTIONAL_ACTION_FIELDS = ["previous_path", "content", "encoding"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The forwarded commit is rebuilt from these fields alone, so nothing
// the path check did not see reaches GitLab.
function readCommit(j: unknown): CommitBody | null {
  if (
    !isObject(j) ||
    typeof j.branch !== "string" ||
    typeof j.commit_message !== "string" ||
    !Array.isArray(j.actions) ||
    j.actions.length === 0
  ) {
    return null;
  }
  const actions: CommitAction[] = [];
  for (const a of j.actions) {
    if (
      !isObject(a) ||
      typeof a.action !== "string" ||
      !COMMIT_ACTIONS.has(a.action) ||
      typeof a.file_path !== "string"
    ) {
      return null;
    }
    const out: CommitAction = { action: a.action, file_path: a.file_path };
    for (const k of OPTIONAL_ACTION_FIELDS) {
      const v = a[k];
      if (v === undefined) continue;
      if (typeof v !== "string") return null;
      out[k] = v;
    }
    actions.push(out);
  }
  return { branch: j.branch, commit_message: j.commit_message, actions };
}

// The editor is not a real GitLab user; the service-account PAT is
// what talks to GitLab. Synthesized responses always carry id 0.
const SYNTHESIZED_USER_ID = 0;

type RouteKind =
  | "user" // synthesized from the JWT
  | "members" // synthesized membership probe
  | "users" // synthesized project-user probe
  | "read" // forwarded read, repo allowlist applies
  | "commit"; // project write, path allowlist applies

interface RouteSpec {
  kind: RouteKind;
  /** Query parameters forwarded upstream; any other is dropped. */
  query: readonly string[];
}

interface Route extends RouteSpec {
  /** Decoded project path; null for account-level routes. */
  repo: string | null;
}

const ACCOUNT_ROUTES = new Map<string, RouteSpec>([
  ["user", { kind: "user", query: [] }],
  ["avatar", { kind: "read", query: ["email", "size"] }],
  // Smoke only: the group token's expiry.
  ["personal_access_tokens/self", { kind: "read", query: [] }],
]);

// Matched against the raw path after projects/<repo>/. The membership
// probe, the branch list and the tree are for the smoke only.
const PROJECT_GET_ROUTES: Array<[RegExp, RouteSpec]> = [
  [/^users$/, { kind: "users", query: [] }],
  [/^members\/all\/0$/, { kind: "members", query: [] }],
  [/^repository\/files\/[^/]+\/raw$/, { kind: "read", query: ["lfs", "ref"] }],
  [/^repository\/commits$/, { kind: "read", query: ["ref_name", "path", "per_page"] }],
  [/^repository\/commits\/[^/]+\/statuses$/, { kind: "read", query: ["per_page"] }],
  [/^repository\/branches(\/[^/]+)?$/, { kind: "read", query: [] }],
  [/^repository\/tree$/, { kind: "read", query: ["path", "per_page", "recursive"] }],
  [/^deployments$/, { kind: "read", query: ["order_by", "sort", "per_page", "updated_after"] }],
];

const COMMIT_ROUTE: RouteSpec = { kind: "commit", query: [] };

// Routing runs on the raw segments so an encoded "/" can't be taken
// for a separator; only the repo segment is decoded.
function matchRoute(method: string, raw: string[], repo: string): Route | null {
  if (raw[0] !== "projects") {
    const spec = method === "GET" ? ACCOUNT_ROUTES.get(raw.join("/")) : undefined;
    return spec ? { ...spec, repo: null } : null;
  }
  if (raw.length < 3) return null;
  const tail = raw.slice(2).join("/");
  if (method === "GET") {
    for (const [re, spec] of PROJECT_GET_ROUTES) {
      if (re.test(tail)) return { ...spec, repo };
    }
  }
  if (method === "POST" && tail === "repository/commits") return { ...COMMIT_ROUTE, repo };
  return null;
}

function forwardedSearch(params: URLSearchParams, keys: readonly string[]): string {
  const out = new URLSearchParams();
  for (const [k, v] of params) {
    if (keys.includes(k)) out.append(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

/** The body as text, or null once it exceeds `limit` bytes. */
export async function readLimitedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function isDotOrEmpty(seg: string): boolean {
  return seg === "" || seg === "." || seg === "..";
}

/**
 * Split the path after /gitlab/ into raw segments, rejecting anything
 * non-canonical: empty segments, "." or ".." (also percent-encoded),
 * backslashes, bad percent-encoding. Upstream normalizes these, so a
 * request in this form that dodged route matching would reach GitLab
 * under the PAT.
 */
function parseSegments(pathname: string): { raw: string[]; decoded: string[] } | null {
  const raw = pathname.slice("/gitlab/".length).split("/");
  const decoded: string[] = [];
  for (const r of raw) {
    let d: string;
    try {
      d = decodeURIComponent(r);
    } catch {
      return null;
    }
    if (isDotOrEmpty(d) || d.includes("\\")) return null;
    decoded.push(d);
  }
  return { raw, decoded };
}

export async function handleGitlabProxy(
  request: Request,
  env: ProxyEnv,
  authorize: Authorizer,
  branchFor: BranchResolver,
  name: string,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const reqUrl = new URL(request.url);
  const parsed = parseSegments(reqUrl.pathname);
  if (!parsed) {
    return jsonResponse({ error: "bad_request", detail: "non-canonical path" }, 400);
  }

  const auth = request.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return jsonResponse({ error: "unauthorized", detail: "missing bearer token" }, 401);
  }
  const token = auth.slice(7).trim();

  let session;
  try {
    session = await verifySession(token, env.JWT_SECRET, reqUrl.origin);
  } catch (err) {
    const detail = err instanceof JWTError ? err.message : "invalid jwt";
    return jsonResponse({ error: "unauthorized", detail }, 401);
  }

  const route = matchRoute(request.method, parsed.raw, parsed.decoded[1] ?? "");
  if (!route) {
    console.log(
      `${name}.deny.route email=${session.email} method=${request.method} path=${reqUrl.pathname}`,
    );
    return jsonResponse({ error: "forbidden", detail: `endpoint not served by ${name}` }, 403);
  }

  const identity = { email: session.email, name: session.name };
  const usernameFromEmail = session.email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_");

  if (route.kind === "user") {
    return jsonResponse(
      {
        id: SYNTHESIZED_USER_ID,
        username: usernameFromEmail,
        name: session.name,
        email: session.email,
        state: "active",
        avatar_url: "",
        web_url: "",
      },
      200,
    );
  }

  // Reads need only an editors.yml entry for the repo, or any entry
  // on account routes; segmenting read access is the Sveltia config's
  // job.
  if (route.kind !== "commit") {
    const ok = authorize({ identity, repo: route.repo, method: request.method, path: "*" });
    if (!ok) {
      const target = route.repo ?? "account routes";
      console.log(
        `${name}.deny.read email=${session.email} repo=${target} method=${request.method}`,
      );
      return jsonResponse(
        {
          error: "forbidden",
          detail: `read access denied to ${target} for ${session.email}`,
        },
        403,
      );
    }
  }

  // Sveltia asks GitLab whether the editor may use the repo. Id 0
  // exists nowhere upstream, so the allowlist verdict above is the
  // answer.
  if (route.kind === "members") {
    return jsonResponse(
      {
        id: SYNTHESIZED_USER_ID,
        username: usernameFromEmail,
        name: session.name,
        state: "active",
        access_level: 40,
        access_level_description: "Maintainer",
        avatar_url: "",
        web_url: "",
      },
      200,
    );
  }
  if (route.kind === "users") {
    return jsonResponse(
      [
        {
          id: SYNTHESIZED_USER_ID,
          username: usernameFromEmail,
          name: session.name,
          state: "active",
          avatar_url: "",
          web_url: "",
        },
      ],
      200,
    );
  }

  let bodyText: string | null = null;
  if (route.kind === "commit") {
    const repo = route.repo ?? "";
    const ct = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") {
      return jsonResponse(
        { error: "bad_request", detail: "commit body must be application/json" },
        400,
      );
    }
    const text = await readLimitedText(request, MAX_COMMIT_BYTES);
    if (text === null) {
      return jsonResponse({ error: "payload_too_large", detail: "commit body too large" }, 413);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return jsonResponse({ error: "bad_request", detail: "invalid json" }, 400);
    }

    const commit = readCommit(json);
    if (!commit) {
      console.log(
        `${name}.deny.write_unknown email=${session.email} repo=${repo} method=${request.method}`,
      );
      return jsonResponse(
        {
          error: "forbidden",
          detail: `editor ${session.email} attempted a write to ${repo} that ${name} does not understand`,
        },
        403,
      );
    }

    if (commit.branch !== branchFor(repo)) {
      console.log(
        `${name}.deny.branch email=${session.email} repo=${repo} branch=${commit.branch}`,
      );
      return jsonResponse(
        {
          error: "forbidden",
          detail: `editor ${session.email} may not commit to branch ${commit.branch} in ${repo}`,
        },
        403,
      );
    }

    for (const a of commit.actions) {
      for (const path of [a.file_path, a.previous_path]) {
        if (path === undefined) continue;
        const ok =
          !path.split("/").some(isDotOrEmpty) &&
          authorize({ identity, repo, method: request.method, path });
        if (!ok) {
          console.log(
            `${name}.deny.write email=${session.email} repo=${repo} method=${request.method} path=${path}`,
          );
          return jsonResponse(
            {
              error: "forbidden",
              detail: `editor ${session.email} not allowed to write ${path} in ${repo}`,
            },
            403,
          );
        }
      }
    }

    // The PAT's owner is the committer; the JWT identity is the author.
    bodyText = JSON.stringify({
      ...commit,
      author_name: session.name,
      author_email: session.email,
    });
  }

  const search = forwardedSearch(reqUrl.searchParams, route.query);
  const upstreamUrl = `${GITLAB_API}/${parsed.raw.join("/")}${search}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.GITLAB_API_TOKEN}`,
    accept: "application/json",
  };
  if (bodyText !== null) headers["content-type"] = "application/json";
  const upstream = await fetch(upstreamUrl, { method: request.method, headers, body: bodyText });

  const respBody = await upstream.arrayBuffer();
  const respHeaders = new Headers(CORS_HEADERS);
  const respCt = upstream.headers.get("content-type");
  if (respCt) respHeaders.set("content-type", respCt);
  return new Response(respBody, { status: upstream.status, headers: respHeaders });
}
