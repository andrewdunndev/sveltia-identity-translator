// GitLab GraphQL proxy.
//
// Sveltia's GitLab backend reads through GraphQL (default branch,
// last commit, file tree, blobs) and writes through REST; it has no
// REST fallback for the reads. Every query it sends is a single
// anonymous `project(fullPath: $fullPath) { repository { ... } }`.
//
// The body is parsed and accepted only in that shape: one query
// operation, a single `project` root whose fullPath is a variable
// naming a repo the identity has an editors.yml entry for, and below
// it only the fields and arguments in PROJECT. No fragments, aliases,
// directives, variable defaults or literal strings. Anything else is
// a 403 without an upstream call. The forwarded body is the printed
// AST with the declared variables only, so GitLab parses exactly what
// was checked.

import {
  Kind,
  parse,
  print,
  type DocumentNode,
  type FieldNode,
  type OperationDefinitionNode,
} from "graphql";
import { verifySession, JWTError } from "./jwt";
import type { Authorizer } from "./authorize";
import { readLimitedText } from "./proxy";

const GITLAB_GRAPHQL = "https://gitlab.com/api/graphql";
const MAX_BODY_BYTES = 256 * 1024;

const CORS_HEADERS = {
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

export interface GraphqlEnv {
  JWT_SECRET: string;
  GITLAB_API_TOKEN: string;
}

interface FieldRule {
  args: readonly string[];
  /** Null on a leaf. */
  fields: Map<string, FieldRule> | null;
}

const leaf: FieldRule = { args: [], fields: null };

function node(fields: Record<string, FieldRule>, args: readonly string[] = []): FieldRule {
  return { args, fields: new Map(Object.entries(fields)) };
}

// The union of the queries Sveltia's GitLab backend sends. Anything
// else under project, such as group { projects }, reaches other repos.
const PROJECT = node(
  {
    repository: node({
      rootRef: leaf,
      tree: node(
        {
          lastCommit: node({ sha: leaf, message: leaf }),
          blobs: node(
            {
              nodes: node({ type: leaf, path: leaf, sha: leaf }),
              pageInfo: node({ endCursor: leaf, hasNextPage: leaf }),
            },
            ["after"],
          ),
        },
        ["ref", "recursive"],
      ),
      blobs: node(
        { nodes: node({ path: leaf, oid: leaf, size: leaf, rawTextBlob: leaf }) },
        ["ref", "paths"],
      ),
    }),
  },
  ["fullPath"],
);

function fieldAllowed(field: FieldNode, rule: FieldRule): boolean {
  if (field.alias || field.directives?.length) return false;
  const seen = new Set<string>();
  for (const arg of field.arguments ?? []) {
    if (seen.has(arg.name.value)) return false;
    seen.add(arg.name.value);
    if (!rule.args.includes(arg.name.value)) return false;
    if (arg.value.kind !== Kind.VARIABLE && arg.value.kind !== Kind.BOOLEAN) return false;
  }
  const children = rule.fields;
  if (!children) return !field.selectionSet;
  if (!field.selectionSet) return false;
  return field.selectionSet.selections.every((s) => {
    if (s.kind !== Kind.FIELD) return false;
    const child = children.get(s.name.value);
    return child !== undefined && fieldAllowed(s, child);
  });
}

/** The operation and its fullPath variable's name; null if the document is not served. */
function servedQuery(
  doc: DocumentNode,
): { op: OperationDefinitionNode; fullPathVar: string } | null {
  if (doc.definitions.length !== 1) return null;
  const op = doc.definitions[0];
  if (op.kind !== Kind.OPERATION_DEFINITION || op.operation !== "query") return null;
  if (op.directives?.length) return null;
  const declared = new Set<string>();
  for (const v of op.variableDefinitions ?? []) {
    if (v.defaultValue || v.directives?.length) return null;
    if (declared.has(v.variable.name.value)) return null;
    declared.add(v.variable.name.value);
  }
  const roots = op.selectionSet.selections;
  if (roots.length !== 1) return null;
  const root = roots[0];
  if (root.kind !== Kind.FIELD || root.name.value !== "project") return null;
  if (!fieldAllowed(root, PROJECT)) return null;
  const fullPath = root.arguments?.find((a) => a.name.value === "fullPath")?.value;
  return fullPath?.kind === Kind.VARIABLE ? { op, fullPathVar: fullPath.name.value } : null;
}

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
  name: string,
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
    session = await verifySession(auth.slice(7).trim(), env.JWT_SECRET, new URL(request.url).origin);
  } catch (err) {
    const detail = err instanceof JWTError ? err.message : "invalid jwt";
    return jsonResponse({ error: "unauthorized", detail }, 401);
  }

  const text = await readLimitedText(request, MAX_BODY_BYTES);
  if (text === null) {
    return jsonResponse({ error: "payload_too_large", detail: "graphql body too large" }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "bad_request", detail: "invalid json" }, 400);
  }
  if (!isObject(body)) {
    return jsonResponse({ error: "bad_request", detail: "expected object body" }, 400);
  }
  const query = typeof body.query === "string" ? body.query : "";
  if (!query) {
    return jsonResponse({ error: "bad_request", detail: "missing query" }, 400);
  }
  const given = body.variables ?? {};
  if (!isObject(given)) {
    return jsonResponse({ error: "bad_request", detail: "variables must be an object" }, 400);
  }

  let doc: DocumentNode;
  try {
    doc = parse(query, { noLocation: true, maxTokens: 1000 });
  } catch {
    return jsonResponse({ error: "bad_request", detail: "invalid graphql" }, 400);
  }

  const served = servedQuery(doc);
  if (!served) {
    console.log(`${name}.deny.graphql_query email=${session.email}`);
    return jsonResponse(
      {
        error: "forbidden",
        detail: "only Sveltia's project read queries are served; writes go through REST",
      },
      403,
    );
  }

  const { op, fullPathVar } = served;
  const variables: Record<string, unknown> = Object.create(null);
  for (const v of op.variableDefinitions ?? []) {
    const name = v.variable.name.value;
    if (Object.hasOwn(given, name)) variables[name] = given[name];
  }

  const fullPath = variables[fullPathVar];
  if (typeof fullPath !== "string" || !fullPath) {
    return jsonResponse(
      { error: "bad_request", detail: `query missing variables.${fullPathVar}` },
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
    console.log(`${name}.deny.graphql_read email=${session.email} fullPath=${fullPath}`);
    return jsonResponse(
      { error: "forbidden", detail: `read access denied to ${fullPath} for ${session.email}` },
      403,
    );
  }

  let forwarded: string;
  try {
    forwarded = JSON.stringify({ query: print(doc), variables });
  } catch {
    return jsonResponse({ error: "bad_request", detail: "unserializable variables" }, 400);
  }
  const upstream = await fetch(GITLAB_GRAPHQL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITLAB_API_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: forwarded,
  });

  const respBody = await upstream.arrayBuffer();
  const headers = new Headers(CORS_HEADERS);
  const respCt = upstream.headers.get("content-type");
  if (respCt) headers.set("content-type", respCt);
  return new Response(respBody, { status: upstream.status, headers });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
