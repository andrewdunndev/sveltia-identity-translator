// Origins allowed to host Sveltia against this Worker. Sourced from the
// ALLOWED_SITES var (comma-separated hostnames, as Sveltia sends in site_id).

// A missing var yields an empty allowlist: every site is refused.
export function allowedOrigins(sites: string | undefined): Set<string> {
  return new Set(
    (sites ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `https://${s}`),
  );
}

export function siteOrigin(siteId: string | null, allowed: Set<string>): string | null {
  if (!siteId) return null;
  const origin = `https://${siteId}`;
  return allowed.has(origin) ? origin : null;
}

export function withCors(request: Request, response: Response, allowed: Set<string>): Response {
  const out = new Response(response.body, response);
  out.headers.append("vary", "Origin");
  const origin = request.headers.get("origin");
  if (origin && allowed.has(origin)) {
    out.headers.set("access-control-allow-origin", origin);
  } else {
    out.headers.delete("access-control-allow-origin");
  }
  return out;
}
