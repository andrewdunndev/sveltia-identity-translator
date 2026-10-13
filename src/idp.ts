// IdP configuration block.
//
// The translator supports any OIDC provider that issues an id_token with an
// "hd"-style hosted-domain claim. Google is one fill-in;
// Microsoft Entra and others would work with different config values.
//
// This shape exists so the upstream-bound version of this Worker
// (sveltia/sveltia-cms-auth as a translated-identity mode) can be
// instantiated against any IdP without code changes -- only config.

export interface IdPConfig {
  /** OAuth 2.0 authorization endpoint (e.g. accounts.google.com/o/oauth2/v2/auth) */
  authorizeUrl: string;
  /** OAuth 2.0 token endpoint */
  tokenUrl: string;
  /** Accepted `iss` values of the id_token */
  issuers: string[];
  /** Scopes requested at authorization (space-separated) */
  scope: string;
  /** Client ID, from the IdP's OAuth app registration */
  clientId: string;
  /** Client secret, from the IdP's OAuth app registration. Sensitive. */
  clientSecret: string;
  /**
   * Optional hosted-domain claim. When set, the callback handler
   * verifies the id_token carries this exact value. For
   * Google Workspace this is the `hd` claim; the value is the
   * Workspace primary domain (e.g. `example.org`).
   */
  hdClaim?: string;
  /** Required value of the hdClaim; empty refuses every sign-in. Ignored if hdClaim is unset. */
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
 * Google Workspace OIDC config. The single fill-in shipped;
 * adding another IdP is a new function alongside this one, not a
 * rewrite of any consumer code.
 */
export function googleConfig(env: IdPEnv): IdPConfig {
  return {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    issuers: ["accounts.google.com", "https://accounts.google.com"],
    scope: "openid email profile",
    clientId: env.OAUTH_CLIENT_ID,
    clientSecret: env.OAUTH_CLIENT_SECRET,
    hdClaim: "hd",
    allowedDomain: env.ALLOWED_DOMAIN,
    extraAuthorizeParams: {
      // UI hint: Google's account chooser pre-filters to this domain.
      // Server-side verification of the hd claim still runs in the
      // callback regardless of this hint.
      hd: env.ALLOWED_DOMAIN,
      access_type: "online",
    },
  };
}
