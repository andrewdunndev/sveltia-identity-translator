// HS256 JWT helpers using Web Crypto. No dependencies.
//
// Used for the session token: the OAuth callback mints one of
// these encoding the editor's identity, and the GitLab proxy
// validates each request's Authorization header against it. The
// OAuth `state` is the same format under a key derived from the same
// secret, so neither token verifies as the other.

export interface SessionPayload {
  /** Subject -- editor's email (also their identity key) */
  sub: string;
  /** Commit author name, derived from the verified email */
  name: string;
  /** Same as sub; explicit for clarity in commit author injection */
  email: string;
  /** Issuer and audience: the origin that minted the token */
  iss: string;
  aud: string;
  /** Issued-at, seconds since epoch */
  iat: number;
  /** Expires-at, seconds since epoch */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const STATE_KEY_LABEL = "translator oauth state";

function b64urlString(s: string): string {
  return b64urlBytes(enc.encode(s));
}

export function b64urlBytes(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += String.fromCharCode(arr[i]);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + "=".repeat(padLen));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importKey(raw: Uint8Array | ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function stateKey(secret: string): Promise<CryptoKey> {
  const root = await importKey(enc.encode(secret));
  return importKey(await crypto.subtle.sign("HMAC", root, enc.encode(STATE_KEY_LABEL)));
}

async function sign(payload: object, key: CryptoKey): Promise<string> {
  const header = b64urlString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlString(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64urlBytes(sig)}`;
}

export class JWTError extends Error {}

async function verify(token: string, key: CryptoKey): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JWTError("malformed jwt");
  const [header, body, sig] = parts;
  let payload: Record<string, unknown> | null;
  try {
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sig), enc.encode(`${header}.${body}`));
    if (!ok) throw new JWTError("invalid signature");
    payload = JSON.parse(dec.decode(fromB64url(body)));
  } catch (err) {
    throw err instanceof JWTError ? err : new JWTError("malformed jwt");
  }
  if (typeof payload !== "object" || payload === null) throw new JWTError("malformed payload");
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new JWTError("expired");
  }
  return payload;
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  return sign(payload, await importKey(enc.encode(secret)));
}

/** `origin` is the origin serving this request; it must be both iss and aud. */
export async function verifySession(
  token: string,
  secret: string,
  origin: string,
): Promise<SessionPayload> {
  const payload = await verify(token, await importKey(enc.encode(secret)));
  if (payload.iss !== origin || payload.aud !== origin) throw new JWTError("wrong audience");
  return payload as unknown as SessionPayload;
}

export async function signState(payload: object, secret: string): Promise<string> {
  return sign(payload, await stateKey(secret));
}

export async function verifyState(token: string, secret: string): Promise<Record<string, unknown>> {
  return verify(token, await stateKey(secret));
}
