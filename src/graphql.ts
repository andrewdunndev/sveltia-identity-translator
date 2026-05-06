// GitLab GraphQL passthrough.
//
// Sveltia uses GraphQL for all reads (file tree, blobs, default
// branch, last commit) and REST for all writes; the upstream comment
// in sveltia-cms is explicit that GraphQL `commitCreate` is broken
// and writes go through REST. This handler therefore enforces a
// read-only contract: any request body containing a GraphQL
// `mutation` operation is rejected at the proxy.
//
// Allowlist: every Sveltia GitLab GraphQL query passes
// `variables.fullPath` as the repo path. We require that variable to
// be present and to refer to a repo the identity has at least one
// editors.yml entry under. Path-glob enforcement on reads is not
// applied; segmentation of read access is the Sveltia config's job
// (collection visibility), and the JWT already enforces the domain
// boundary.

import { verifySession, JWTError } from "./jwt";
import type { Authorizer } from "./authorize";

const GITLAB_GRAPHQL = "https://gitlab.com/api/graphql";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

export interface GraphqlEnv {
  JWT_SECRET: string;
  GITLAB_API_TOKEN: string;
}

interface GraphqlBody {
  query?: unknown;
  variables?: { fullPath?: unknown; paths?: unknown };
  operationName?: unknown;
}

// Catches `mutation`, `mutation Foo`, `mutation { ... }`, anywhere.
// False positive on a string literal containing the word "mutation"
// inside a query is acceptable: fail closed and force the caller to
// use REST for writes.
const MUTATION_RE = /(^|\s)mutation\s*[A-Za-z_({]/;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

export async function handleGraphql(
  request: Request,
  env: GraphqlEnv,
  authorize: Authorizer,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", detail: "graphql requires POST" }, 405);
  }

  const auth = request.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return jsonResponse({ error: "unauthorized", detail: "missing bearer token" }, 401);
  }

  let session;
  try {
    session = await verifySession(auth.slice(7).trim(), env.JWT_SECRET);
  } catch (err) {
    const detail = err instanceof JWTError ? err.message : "invalid jwt";
    return jsonResponse({ error: "unauthorized", detail }, 401);
  }

  const bodyText = await request.text();
  let body: GraphqlBody;
  try {
    body = JSON.parse(bodyText) as GraphqlBody;
  } catch {
    return jsonResponse({ error: "bad_request", detail: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "bad_request", detail: "expected object body" }, 400);
  }

  const query = typeof body.query === "string" ? body.query : "";
  if (!query) {
    return jsonResponse({ error: "bad_request", detail: "missing query" }, 400);
  }
  if (MUTATION_RE.test(query)) {
    console.log(
      `translator.deny.graphql_mutation email=${session.email} fullPath=${body.variables?.fullPath ?? "?"}`,
    );
    return jsonResponse(
      {
        error: "forbidden",
        detail: "graphql mutations not permitted; use REST commit endpoint for writes",
      },
      403,
    );
  }

  const fullPath = body.variables?.fullPath;
  if (typeof fullPath !== "string" || !fullPath) {
    return jsonResponse(
      { error: "bad_request", detail: "query missing variables.fullPath" },
      400,
    );
  }

  const ok = authorize({
    identity: { email: session.email, name: session.name },
    repo: fullPath,
    method: "GET",
    path: "*",
  });
  if (!ok) {
    console.log(
      `translator.deny.graphql_read email=${session.email} fullPath=${fullPath}`,
    );
    return jsonResponse(
      { error: "forbidden", detail: `read access denied to ${fullPath} for ${session.email}` },
      403,
    );
  }

  // Forward to GitLab. Replace the Authorization header with the
  // service-account PAT; preserve the body verbatim so GitLab sees
  // exactly what Sveltia sent.
  const upstream = await fetch(GITLAB_GRAPHQL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITLAB_API_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: bodyText,
  });

  const respBody = await upstream.arrayBuffer();
  const headers = new Headers(CORS_HEADERS);
  const respCt = upstream.headers.get("content-type");
  if (respCt) headers.set("content-type", respCt);
  return new Response(respBody, { status: upstream.status, headers });
}
