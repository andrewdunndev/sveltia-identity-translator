// OAuth 2.0 / OIDC handlers.
//
// /oauth/authorize : redirect the editor to the IdP's consent screen.
// /oauth/callback  : receive the auth code, exchange it (with the PKCE
//                    verifier), verify the identity, mint a session
//                    JWT, deliver it to the Sveltia opener via
//                    postMessage.
//
// Sveltia (and Decap) listen for a `postMessage` of the form
//   { type: "authorization:<provider>:success", payload: { token } }
// from a popup window. The callback returns an HTML page that does
// the postMessage and closes itself.
//
// The browser that starts the flow gets a short-lived cookie holding
// the PKCE code_verifier; the signed `state` carries its S256
// challenge. The callback accepts only a state it signed, for an
// allowlisted origin, presented by the browser holding the matching
// verifier. The verifier never appears in a URL or in the page.

import type { IdPConfig } from "./idp";
import {
  b64urlBytes,
  fromB64url,
  signSession,
  signState,
  verifyState,
  type SessionPayload,
} from "./jwt";
import { siteOrigin } from "./origins";

export interface OAuthEnv {
  JWT_SECRET: string;
}

// 8h editor sessions: a school day of editing without re-auth (no
// refresh tokens are issued), and a leaked JWT is dead by evening.
const SESSION_TTL_SECONDS = 8 * 3600;

const STATE_TTL_SECONDS = 600;
const VERIFIER_COOKIE = "__Host-translator_pkce";

// Sveltia's GitLab backend listens for `authorization:gitlab:success`,
// whatever the IdP behind the translator.
const PROVIDER_TAG = "gitlab";

interface IdClaims {
  email?: unknown;
  email_verified?: unknown;
  [k: string]: unknown;
}

function readIdToken(idToken: unknown, idp: IdPConfig): IdClaims | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let c: IdClaims & { iss?: unknown; aud?: unknown; exp?: unknown };
  try {
    c = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    return null;
  }
  if (typeof c.iss !== "string" || !idp.issuers.includes(c.iss)) return null;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(idp.clientId)) return null;
  if (typeof c.exp !== "number" || c.exp <= Math.floor(Date.now() / 1000)) return null;
  return c;
}

const enc = new TextEncoder();

async function s256(verifier: string): Promise<string> {
  return b64urlBytes(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

function verifierCookie(value: string, maxAge: number): string {
  return `${VERIFIER_COOKIE}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function handleAuthorize(
  request: Request,
  idp: IdPConfig,
  env: OAuthEnv,
  allowed: Set<string>,
): Promise<Response> {
  const url = new URL(request.url);

  // Origin derivation: trust only `site_id` (Sveltia always sends
  // it for the server-side authorization-code flow), and only when
  // it names an allowlisted site. Anything else would let an
  // attacker steer the postMessage targetOrigin to an arbitrary host.
  const origin = siteOrigin(url.searchParams.get("site_id"), allowed);
  if (!origin) return errorPage("Unknown site.", 400);

  const verifier = b64urlBytes(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await s256(verifier);
  const state = await signState(
    { origin, challenge, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS },
    env.JWT_SECRET,
  );

  const params = new URLSearchParams({
    client_id: idp.clientId,
    redirect_uri: `${url.origin}/oauth/callback`,
    response_type: "code",
    scope: idp.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(idp.extraAuthorizeParams ?? {}),
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: `${idp.authorizeUrl}?${params.toString()}`,
      "set-cookie": verifierCookie(verifier, STATE_TTL_SECONDS),
      "cache-control": "no-store",
    },
  });
}

export async function handleCallback(
  request: Request,
  idp: IdPConfig,
  env: OAuthEnv,
  allowed: Set<string>,
  isEditor: (email: string) => boolean,
): Promise<Response> {
  let res: Response;
  try {
    res = await callback(request, idp, env, allowed, isEditor);
  } catch {
    res = errorPage("Sign-in failed. Start again from the editor.", 500);
  }
  res.headers.append("set-cookie", verifierCookie("", 0));
  return res;
}

async function callback(
  request: Request,
  idp: IdPConfig,
  env: OAuthEnv,
  allowed: Set<string>,
  isEditor: (email: string) => boolean,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code || !stateParam) return errorPage("Missing OAuth parameters.", 400);

  let state: Record<string, unknown>;
  try {
    state = await verifyState(stateParam, env.JWT_SECRET);
  } catch {
    return errorPage("Invalid or expired sign-in attempt. Start again from the editor.", 400);
  }
  const origin = state.origin;
  if (typeof origin !== "string" || !allowed.has(origin)) {
    return errorPage("Invalid origin in state.", 400);
  }
  const verifier = readCookie(request, VERIFIER_COOKIE);
  if (!verifier || (await s256(verifier)) !== state.challenge) {
    return errorPage("This sign-in was started in another browser or window. Start again.", 400);
  }

  // An IdP with a hosted-domain claim and no allowed domain would
  // accept any account it can issue; refuse instead.
  if (idp.hdClaim && !idp.allowedDomain) {
    return errorPage("translator is misconfigured: no allowed domain.", 500);
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
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) return errorPage("Failed to exchange authorization code.");
  const tokens = (await tokenRes.json()) as { id_token?: unknown };

  // The id_token arrives over TLS straight from the IdP's token
  // endpoint in answer to our authenticated request, so its claims
  // are checked (issuer, audience, expiry) rather than its signature.
  const user = readIdToken(tokens.id_token, idp);
  if (!user) return errorPage("The identity provider returned no valid id_token.");

  // The `hd` authorize param only filters Google's account chooser;
  // this is the enforcement.
  if (idp.hdClaim && user[idp.hdClaim] !== idp.allowedDomain) {
    return errorPage(
      `Access denied: this Worker only accepts identities from ${idp.allowedDomain}.`,
    );
  }
  if (typeof user.email !== "string" || !user.email || user.email_verified !== true) {
    return errorPage("The identity provider did not return a verified email.");
  }
  if (!isEditor(user.email)) {
    return errorPage(
      "This account is not set up as an editor. Ask the website administrator to add you.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const session: SessionPayload = {
    sub: user.email,
    name: user.email.split("@")[0],
    email: user.email,
    iss: url.origin,
    aud: url.origin,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const jwt = await signSession(session, env.JWT_SECRET);

  return successPage(jwt, origin);
}

// JSON for an inline <script>: escapes what could end the script
// element or open an HTML comment, and the two line terminators
// older parsers reject in string literals.
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * postMessage delivery page. Returns minimal HTML/JS that posts the
 * JWT back to window.opener (where Sveltia is waiting), then closes.
 *
 * The `targetOrigin` in postMessage is the origin from the signed
 * state, so the JWT only goes to the exact SPA that initiated the flow.
 */
function successPage(jwt: string, targetOrigin: string): Response {
  const nonce = b64urlBytes(crypto.getRandomValues(new Uint8Array(16)));
  const msg = `authorization:${PROVIDER_TAG}:success:${JSON.stringify({ token: jwt, provider: PROVIDER_TAG })}`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>translator</title></head>
<body>
<p>Signing in...</p>
<script nonce="${nonce}">
(function() {
  var origin = ${scriptJson(targetOrigin)};
  var msg = ${scriptJson(msg)};
  if (window.opener) {
    window.opener.postMessage(msg, origin);
    setTimeout(function() { window.close(); }, 200);
  } else {
    document.body.textContent = "Signed in. You may close this window.";
  }
})();
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}

function errorPage(msg: string, status = 403): Response {
  const safe = msg.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>translator -- error</title></head>
<body style="font-family:system-ui;padding:2rem;color:#222">
<h2 style="color:#b3261e">Authentication failed</h2>
<p>${safe}</p>
<button onclick="window.close()">Close</button>
</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
