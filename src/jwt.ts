// HS256 JWT helpers using Web Crypto. No dependencies.
//
// Used for the translator's session token: the OAuth callback mints
// one of these encoding the editor's identity, and the GitLab proxy
// validates each request's Authorization header against it.

export interface SessionPayload {
  /** Subject: editor's email (also their identity key) */
  sub: string;
  /** Display name, as the IdP reports it */
  name: string;
  /** Same as sub; explicit for clarity in commit author injection */
  email: string;
  /** Issued-at, seconds since epoch */
  iat: number;
  /** Expires-at, seconds since epoch */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlString(s: string): string {
  return b64urlBytes(enc.encode(s));
}

function b64urlBytes(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += String.fromCharCode(arr[i]);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + "=".repeat(padLen));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const header = b64urlString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlString(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await importKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64urlBytes(sig)}`;
}

export class JWTError extends Error {}

export async function verifySession(token: string, secret: string): Promise<SessionPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JWTError("malformed jwt");
  const [header, body, sig] = parts;
  const key = await importKey(secret, "verify");
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    fromB64url(sig),
    enc.encode(`${header}.${body}`),
  );
  if (!ok) throw new JWTError("invalid signature");
  let payload: SessionPayload;
  try {
    payload = JSON.parse(dec.decode(fromB64url(body))) as SessionPayload;
  } catch {
    throw new JWTError("malformed payload");
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new JWTError("expired");
  }
  return payload;
}
