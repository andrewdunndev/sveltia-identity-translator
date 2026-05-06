// GitLab REST proxy.
//
// On every /gitlab/* request:
//   1. validate the Authorization Bearer JWT against JWT_SECRET
//   2. for /projects/<repo>/... calls, consult the Authorizer; deny
//      on miss (read membership for GET; per-path glob for writes)
//   3. swap the Authorization header to the service-account PAT
//   4. inject author_name + author_email on commit/file POSTs so git
//      history shows the editor as commit author (PAT owner remains
//      the committer)
//   5. forward to gitlab.com/api/v4
//
// Sveltia calls GET /user to display the logged-in identity in its
// UI. We synthesize that response from the session JWT instead of
// forwarding, since the service-account PAT's userinfo would not be
// the editor's. Sveltia then calls
// /projects/<repo>/members/all/<userId> to confirm the user has
// Developer-or-higher access to the repo. With our synthesized id=0
// the upstream call would 404 and Sveltia would refuse to load the
// editor UI; we synthesize the membership response too.

import { verifySession, JWTError } from "./jwt";
import type { Authorizer } from "./authorize";

const GITLAB_API = "https://gitlab.com/api/v4";

export interface ProxyEnv {
  JWT_SECRET: string;
  GITLAB_API_TOKEN: string;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

interface GitlabAction {
  file_path?: string;
}
interface GitlabCommitBody {
  actions?: GitlabAction[];
  [k: string]: unknown;
}

export async function handleGitlabProxy(
  request: Request,
  env: ProxyEnv,
  authorize: Authorizer,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Step 1: Authentication.
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return jsonResponse({ error: "unauthorized", detail: "missing bearer token" }, 401);
  }
  const token = auth.slice(7).trim();

  let session;
  try {
    session = await verifySession(token, env.JWT_SECRET);
  } catch (err) {
    const detail = err instanceof JWTError ? err.message : "invalid jwt";
    return jsonResponse({ error: "unauthorized", detail }, 401);
  }

  const reqUrl = new URL(request.url);
  const apiPath = reqUrl.pathname.replace(/^\/gitlab/, "");
  const SYNTHESIZED_USER_ID = 0;
  const usernameFromEmail = session.email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_");

  // Synthesize /user from the JWT. Sveltia calls this to discover
  // the editor's identity. We always return id: 0 -- the editor is
  // not a real GitLab user; the service-account PAT is what actually
  // talks to GitLab.
  if (apiPath === "/user" && request.method === "GET") {
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

  const projectMatch = apiPath.match(/^\/projects\/([^/]+)/);
  const repo = projectMatch ? decodeURIComponent(projectMatch[1]) : "";

  // Read-side allowlist enforcement on /projects/<repo>/... calls.
  // The authorizer's read branch returns true only when the identity
  // has an editors.yml entry for the repo, regardless of path:
  // segmentation of read access is the Sveltia config's job
  // (collection visibility), not the translator's. Calls outside
  // /projects/ (e.g. /user) bypass this check.
  const isWrite = !["GET", "HEAD"].includes(request.method);
  if (!isWrite && projectMatch) {
    const ok = authorize({
      identity: { email: session.email, name: session.name },
      repo,
      method: request.method,
      path: "*",
    });
    if (!ok) {
      console.log(
        `translator.deny.read email=${session.email} repo=${repo} method=${request.method}`,
      );
      return jsonResponse(
        {
          error: "forbidden",
          detail: `read access denied to ${repo} for ${session.email}`,
        },
        403,
      );
    }
  }

  // Synthesize membership lookups. Our synthesized user_id (0)
  // doesn't exist on GitLab, so the upstream call would 404 and
  // Sveltia would refuse to load the editor UI. editors.yml is the
  // source of truth for whether a translated identity can operate on
  // a repo, so we report Maintainer (40) when the identity passed
  // the read-allowlist check above, otherwise 404.
  const memberMatch = apiPath.match(/^\/projects\/[^/]+\/members\/all\/(\d+)$/);
  if (
    memberMatch &&
    request.method === "GET" &&
    Number(memberMatch[1]) === SYNTHESIZED_USER_ID
  ) {
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

  // Write-side allowlist enforcement.
  const writePaths: string[] = [];
  let bodyText: string | null = null;

  if (isWrite) {
    bodyText = await request.text();

    // Single-file ops: /projects/<repo>/repository/files/<file_path>
    const fileMatch = apiPath.match(/^\/projects\/[^/]+\/repository\/files\/([^?]+)/);
    if (fileMatch) {
      writePaths.push(decodeURIComponent(fileMatch[1]));
    }

    // Commit op: /projects/<repo>/repository/commits with actions[].
    if (apiPath.endsWith("/repository/commits") && bodyText) {
      try {
        const body = JSON.parse(bodyText) as GitlabCommitBody;
        for (const a of body.actions ?? []) {
          if (a.file_path) writePaths.push(a.file_path);
        }
      } catch {
        // Malformed body. Let the upstream return its own 400; the
        // allowlist check passes vacuously since there are no paths.
      }
    }

    // Deny if no path was extractable for a write to a /projects path.
    // Catches odd write endpoints that aren't enumerated above.
    if (projectMatch && writePaths.length === 0) {
      const allowsAnyWrite = authorize({
        identity: { email: session.email, name: session.name },
        repo,
        method: request.method,
        path: "*",
      });
      if (!allowsAnyWrite) {
        console.log(
          `translator.deny.write_unknown email=${session.email} repo=${repo} method=${request.method} path=${apiPath}`,
        );
        return jsonResponse(
          {
            error: "forbidden",
            detail: `editor ${session.email} attempted a write to ${repo} that the translator does not understand; tighten the request or extend the proxy`,
          },
          403,
        );
      }
    }

    for (const path of writePaths) {
      const ok = authorize({
        identity: { email: session.email, name: session.name },
        repo,
        method: request.method,
        path,
      });
      if (!ok) {
        console.log(
          `translator.deny.write email=${session.email} repo=${repo} method=${request.method} path=${path}`,
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

  // Author injection. GitLab's commits and files endpoints accept
  // top-level author_name + author_email. The PAT's owner is the
  // committer; the JWT identity is the author. Git history shows
  // the editor.
  if (
    isWrite &&
    bodyText &&
    (apiPath.endsWith("/repository/commits") ||
      /^\/projects\/[^/]+\/repository\/files\//.test(apiPath))
  ) {
    try {
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      body.author_name = session.name;
      body.author_email = session.email;
      bodyText = JSON.stringify(body);
    } catch {
      // Leave bodyText as-is; GitLab will return 400 on malformed JSON.
    }
  }

  // Forward.
  const upstreamUrl = `${GITLAB_API}${apiPath}${reqUrl.search}`;
  const ct = request.headers.get("content-type") ?? "application/json";
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: {
      authorization: `Bearer ${env.GITLAB_API_TOKEN}`,
      "content-type": ct,
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
