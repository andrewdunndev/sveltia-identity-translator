// sveltia-identity-translator: translated-identity proxy for Sveltia CMS.
//
// Routes:
//   /oauth/authorize  -> redirect to IdP consent screen
//   /oauth/callback   -> mint session JWT, postMessage to Sveltia
//   /gitlab/graphql   -> JWT-validated GraphQL passthrough (reads
//                        only; mutations rejected; allowlist on repo)
//   /gitlab/*         -> JWT + allowlist on writes, swap to PAT,
//                        inject author, forward to REST API v4
//   /healthz          -> simple liveness ping
//
// Order matters: /gitlab/graphql must be matched before the REST
// `/gitlab/*` blanket since GraphQL has its own contract (different
// upstream URL, mutation rejection, repo-from-variables instead of
// repo-from-path).

import { googleConfig } from "./idp";
import { handleAuthorize, handleCallback, type OAuthEnv } from "./oauth";
import { handleGitlabProxy, type ProxyEnv } from "./proxy";
import { handleGraphql, type GraphqlEnv } from "./graphql";
import { editorsYmlAuthorizer } from "./authorize";

export interface Env extends OAuthEnv, ProxyEnv, GraphqlEnv {
  // From wrangler.toml [vars]
  ALLOWED_DOMAIN: string;

  // Secrets, populated via `wrangler secret put`.
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  // JWT_SECRET and GITLAB_API_TOKEN are inherited from the env
  // interfaces above.
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const idp = googleConfig(env);

    if (url.pathname === "/oauth/authorize") {
      return handleAuthorize(request, idp);
    }
    if (url.pathname === "/oauth/callback") {
      return handleCallback(request, idp, env);
    }
    if (url.pathname === "/gitlab/graphql") {
      return handleGraphql(request, env, editorsYmlAuthorizer);
    }
    if (url.pathname.startsWith("/gitlab/")) {
      return handleGitlabProxy(request, env, editorsYmlAuthorizer);
    }
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return new Response("translator ok\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
