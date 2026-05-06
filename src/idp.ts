// IdP configuration block.
//
// The translator supports any OIDC provider that issues a userinfo
// response with a hosted-domain claim (or equivalent). Google
// Workspace is the reference implementation; Microsoft Entra and
// Okta have analogous claims and would slot in via a parallel config
// factory function.
//
// The hook surface (this interface, plus the Authorizer in
// authorize.ts) is what makes this translator upstream-shaped:
// sveltia/sveltia-cms-auth could absorb this codebase by registering
// a deployer-supplied IdPConfig + Authorizer at startup, and the rest
// of the proxy stays the same.

export interface IdPConfig {
  /** OAuth 2.0 authorization endpoint */
  authorizeUrl: string;
  /** OAuth 2.0 token endpoint */
  tokenUrl: string;
  /** OIDC userinfo endpoint */
  userInfoUrl: string;
  /** Scopes requested at authorization (space-separated) */
  scope: string;
  /** Client ID, from the IdP's OAuth app registration */
  clientId: string;
  /** Client secret, from the IdP's OAuth app registration. Sensitive. */
  clientSecret: string;
  /**
   * Optional hosted-domain claim. When set, the callback handler
   * verifies the userinfo response carries this exact value. For
   * Google Workspace this is the `hd` claim; the value is the
   * Workspace primary domain (e.g. `example.org`).
   */
  hdClaim?: string;
  /** Required value of the hdClaim. Ignored if hdClaim is unset. */
  allowedDomain?: string;
  /**
   * IdP-specific extra params appended to the authorize URL. Google
   * uses `hd` as a UI hint to scope the account chooser; other IdPs
   * may use different params here.
   */
  extraAuthorizeParams?: Record<string, string>;
}

export interface IdPEnv {
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  ALLOWED_DOMAIN: string;
}

/**
 * Google Workspace OIDC config. The reference IdP this translator
 * ships with. Adding another IdP is a new factory function alongside
 * this one (e.g. `microsoftEntraConfig`, `oktaConfig`); the proxy and
 * OAuth handlers consume the IdPConfig interface and don't care which
 * provider populates it.
 *
 * The dual `hd` check is deliberate. The `hd` query parameter scopes
 * Google's account chooser UI to the allowed domain. The userinfo
 * `hd` claim is the cryptographic boundary. The first is convenience;
 * the second is enforcement. Removing either one weakens the model.
 */
export function googleConfig(env: IdPEnv): IdPConfig {
  return {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    scope: "openid email profile",
    clientId: env.OAUTH_CLIENT_ID,
    clientSecret: env.OAUTH_CLIENT_SECRET,
    hdClaim: "hd",
    allowedDomain: env.ALLOWED_DOMAIN,
    extraAuthorizeParams: {
      hd: env.ALLOWED_DOMAIN,
      access_type: "online",
    },
  };
}
