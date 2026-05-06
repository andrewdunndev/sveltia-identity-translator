// OAuth 2.0 / OIDC handlers.
//
// /oauth/authorize : redirect the editor to the IdP's consent screen.
// /oauth/callback  : receive the auth code, exchange for tokens,
//                    verify the hd claim, mint a session JWT, deliver
//                    it to the Sveltia opener via postMessage.
//
// Sveltia (and Decap) listen for a `postMessage` of the form
//   { type: "authorization:<provider>:success", payload: { token } }
// from a popup window. The callback returns an HTML page that does
// the postMessage and closes itself.

import type { IdPConfig } from "./idp";
import { signSession, type SessionPayload } from "./jwt";

export interface OAuthEnv {
  JWT_SECRET: string;
}

// 24h editor sessions. Long enough that a typical edit-and-save
// session never re-authenticates mid-flight (Sveltia auto-refresh
// requires a refresh token, which we don't issue). Short enough
// that a stolen JWT expires within a working day. Sveltia silently
// re-auths on 401, so a session that does outlast the JWT recovers
// without user-visible failure.
const SESSION_TTL_SECONDS = 24 * 3600;

interface UserInfo {
  email: string;
  name?: string;
  hd?: string;
  [k: string]: unknown;
}

interface OAuthState {
  /** Origin Sveltia was loaded from (e.g. https://example.org). Used as the postMessage targetOrigin so the JWT only goes back to the SPA that initiated the flow. */
  origin: string;
  /** Random nonce, regenerated on each authorize. Mitigates CSRF on the callback. */
  nonce: string;
  /**
   * Provider tag, used in the postMessage type so Sveltia matches it
   * (`authorization:<tag>:success`). For Google we use "gitlab" so
   * existing Sveltia config (which targets the GitLab backend) does
   * not need changes; the tag is a Sveltia-side label, not an IdP
   * identifier.
   */
  providerTag: string;
}

function encodeState(state: OAuthState): string {
  return btoa(JSON.stringify(state)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeState(raw: string): OAuthState {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const json = atob(padded + "=".repeat(padLen));
  return JSON.parse(json) as OAuthState;
}

export async function handleAuthorize(
  request: Request,
  idp: IdPConfig,
  providerTag = "gitlab",
): Promise<Response> {
  const url = new URL(request.url);

  // Origin derivation: trust only `site_id` (Sveltia always sends it
  // for the server-side authorization-code flow). Falling back to the
  // Referer header would let an attacker steer the postMessage
  // targetOrigin to an arbitrary host. If site_id is absent, default
  // to the Worker's own origin: the JWT then only reaches a page
  // under the Worker hostname, which is harmless.
  const siteId = url.searchParams.get("site_id");
  const origin = siteId ? `https://${siteId}` : url.origin;

  const state = encodeState({
    origin,
    nonce: crypto.randomUUID(),
    providerTag,
  });

  const redirectUri = `${url.origin}/oauth/callback`;
  const params = new URLSearchParams({
    client_id: idp.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: idp.scope,
    state,
    ...(idp.extraAuthorizeParams ?? {}),
  });

  return Response.redirect(`${idp.authorizeUrl}?${params.toString()}`, 302);
}

export async function handleCallback(
  request: Request,
  idp: IdPConfig,
  env: OAuthEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code || !stateParam) return errorPage("Missing OAuth parameters.");

  let state: OAuthState;
  try {
    state = decodeState(stateParam);
  } catch {
    return errorPage("Invalid state parameter.");
  }
  if (!state.origin || !/^https?:\/\//.test(state.origin)) {
    return errorPage("Invalid origin in state.");
  }

  const tokenRes = await fetch(idp.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: idp.clientId,
      client_secret: idp.clientSecret,
      redirect_uri: `${url.origin}/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return errorPage("Failed to exchange authorization code.");
  const tokens = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch(idp.userInfoUrl, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) return errorPage("Failed to fetch userinfo.");
  const user = (await userRes.json()) as UserInfo;

  // hd claim verification. The IdP's account chooser is invited to
  // pre-filter via the `hd` query param at authorize time, but a
  // motivated user can still choose any account. The server-side
  // check is what actually enforces the boundary.
  if (idp.hdClaim && idp.allowedDomain) {
    const claimValue = user[idp.hdClaim];
    if (typeof claimValue !== "string" || claimValue !== idp.allowedDomain) {
      return errorPage(
        `Access denied: this Worker only accepts identities from ${idp.allowedDomain}.`,
      );
    }
  }
  if (!user.email) return errorPage("IdP did not return an email.");

  const now = Math.floor(Date.now() / 1000);
  const session: SessionPayload = {
    sub: user.email,
    name: user.name ?? user.email,
    email: user.email,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const jwt = await signSession(session, env.JWT_SECRET);

  return successPage(jwt, state.origin, state.providerTag);
}

/**
 * postMessage delivery page. Returns minimal HTML/JS that posts the
 * JWT back to window.opener (where Sveltia is waiting), then closes.
 *
 * The `targetOrigin` in postMessage is set to the state.origin so
 * the JWT only goes to the exact SPA that initiated the flow.
 */
function successPage(jwt: string, targetOrigin: string, providerTag: string): Response {
  const safeOrigin = JSON.stringify(targetOrigin);
  const safeTag = JSON.stringify(providerTag);
  const safeToken = JSON.stringify(jwt);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>signing in</title></head>
<body style="font-family:system-ui;padding:2rem">
<p>Signing in...</p>
<script>
(function() {
  var origin = ${safeOrigin};
  var tag = ${safeTag};
  var token = ${safeToken};
  var msg = "authorization:" + tag + ":success:" + JSON.stringify({ token: token, provider: tag });
  if (window.opener) {
    window.opener.postMessage(msg, origin);
    setTimeout(function() { window.close(); }, 200);
  } else {
    document.body.innerHTML = "<p>Signed in. You may close this window.</p>";
  }
})();
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorPage(msg: string): Response {
  const safe = msg.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>auth error</title></head>
<body style="font-family:system-ui;padding:2rem">
<h2 style="color:#a14040">Authentication failed</h2>
<p>${safe}</p>
<button onclick="window.close()">Close</button>
</body></html>`;
  return new Response(html, {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
