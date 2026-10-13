// Translated-identity proxy for Sveltia CMS.
//
// Routes:
//   /oauth/authorize  -> redirect to IdP consent screen
//   /oauth/callback   -> mint session JWT, postMessage to Sveltia
//   /gitlab/graphql   -> JWT-validated GraphQL proxy for the project
//                        read queries Sveltia sends; allowlist on repo
//   /gitlab/*         -> default-deny route table, JWT + allowlists,
//                        swap to PAT, inject author, forward to REST
//                        API v4
//   /healthz          -> simple liveness ping
//
// Order matters: /gitlab/graphql must be matched before the REST
// `/gitlab/*` blanket since GraphQL has its own contract (different
// upstream URL, query-shape check, repo-from-variables instead of
// repo-from-path).

import { googleConfig } from "./idp";
import { handleAuthorize, handleCallback, type OAuthEnv } from "./oauth";
import { handleGitlabProxy, type ProxyEnv } from "./proxy";
import { handleGraphql, type GraphqlEnv } from "./graphql";
import { buildAuthorizer, buildBranchResolver, buildIsEditor } from "./authorize";
import { allowedOrigins, withCors } from "./origins";

export { buildAuthorizer, buildBranchResolver, buildIsEditor };

export interface Env extends OAuthEnv, ProxyEnv, GraphqlEnv {
  // From wrangler.toml [vars]
  ALLOWED_DOMAIN: string;
  // Comma-separated hostnames permitted as Sveltia site_id and CORS origin.
  ALLOWED_SITES: string;

  // Secrets, set with `wrangler secret put`.
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  // JWT_SECRET and GITLAB_API_TOKEN are inherited from the env
  // interfaces above.
}

export interface WorkerConfig {
  /** Raw text of editors.yml. */
  editors: string;
  /** Labels the healthz body and the deny log lines. Default "translator". */
  name?: string;
}

export function createWorker(cfg: WorkerConfig): ExportedHandler<Env> {
  const name = cfg.name ?? "translator";
  const authorizer = buildAuthorizer(cfg.editors);
  const branchFor = buildBranchResolver(cfg.editors);
  const isEditor = buildIsEditor(cfg.editors);

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const idp = googleConfig(env);
      const allowed = allowedOrigins(env.ALLOWED_SITES);

      if (url.pathname === "/oauth/authorize") {
        return handleAuthorize(request, idp, env, allowed);
      }
      if (url.pathname === "/oauth/callback") {
        return handleCallback(request, idp, env, allowed, isEditor);
      }
      if (url.pathname === "/gitlab/graphql") {
        return withCors(request, await handleGraphql(request, env, authorizer, name), allowed);
      }
      if (url.pathname.startsWith("/gitlab/")) {
        return withCors(
          request,
          await handleGitlabProxy(request, env, authorizer, branchFor, name),
          allowed,
        );
      }
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return new Response(`${name} ok\n`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("not found\n", { status: 404 });
    },
  } satisfies ExportedHandler<Env>;
}
