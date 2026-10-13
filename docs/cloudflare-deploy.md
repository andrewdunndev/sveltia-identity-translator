# Cloudflare: deploy the Worker

The proxy is a single [Cloudflare Worker][cf-workers] on the free
plan: no KV, R2, D1 or queues.

[cf-workers]: https://developers.cloudflare.com/workers/

## Prerequisites

- Node.js (CI runs 22) and npm.
- A Cloudflare account; the Workers free plan is enough until you
  pass its daily request limit.
- The values from the other setup steps:
  - `GITLAB_API_TOKEN`, from
    [docs/gitlab-pat-setup.md](./gitlab-pat-setup.md)
  - `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`, from
    [docs/google-oauth-setup.md](./google-oauth-setup.md)
  - `JWT_SECRET`, generated locally with `openssl rand -hex 32`; keep
    it for local dev and the smoke harness.

## Steps

### 1. Clone and install

```bash
git clone https://github.com/andrewdunndev/sveltia-identity-translator.git
cd sveltia-identity-translator
npm install
```

To deploy from a repo of your own instead, install the package from a
tag and call `createWorker` (see the README).

### 2. Configure wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
$EDITOR wrangler.toml
```

Both vars are required:

```toml
[vars]
ALLOWED_DOMAIN = "example.org"               # your Workspace primary domain
ALLOWED_SITES = "example.com,www.example.com" # hostnames that serve Sveltia
```

A site not in `ALLOWED_SITES` cannot start a sign-in and gets no CORS
header. `wrangler.toml` is gitignored here because `account_id` and
custom routes are deployment-specific; in your own repo, commit it.

### 3. Configure editors.yml

```bash
cp editors.yml.example editors.yml
$EDITOR editors.yml
npm run lint:editors
```

Declare each repo's `branch` and `write_roots` under `repos:`, then
each editor's email with their globs. An empty file lets nobody sign
in. `editors.yml` is gitignored here; in your own repo, commit it, so
that who can edit what has blame, review and rollback.

### 4. Deploy

```bash
npx wrangler deploy
```

The first run opens a browser to log in to Cloudflare. wrangler prints
the Worker's URL, `https://sveltia-identity-translator.<account>.workers.dev`
unless a route is configured; that hostname is `<worker-hostname>`
everywhere else in these docs.

### 5. Set secrets

```bash
npx wrangler secret put OAUTH_CLIENT_ID
npx wrangler secret put OAUTH_CLIENT_SECRET
npx wrangler secret put GITLAB_API_TOKEN
npx wrangler secret put JWT_SECRET
```

Each prompts for its value and stores it encrypted; no redeploy is
needed.

### 6. Verify

```bash
curl https://<worker-hostname>/healthz
# translator ok
JWT_SECRET=<the value you set> node scripts/smoke.mjs \
  --base-url https://<worker-hostname> \
  --repo your-org/your-site --site example.com \
  --admin admin@example.org --editor editor@example.org
```

The harness ends with `fail=0`. `blocked` cases are environment
problems the proxy cannot fix (branch protection refusing the service
account, a token without an expiry); the output says which.

### 7. Custom hostname (optional)

1. Add the domain to your Cloudflare account so its DNS is managed
   there.
2. Uncomment `[[routes]]` in `wrangler.toml` and set `pattern` and
   `zone_name`.
3. `npx wrangler deploy`.
4. Add `https://translator.example.org/oauth/callback` to the Google
   OAuth client's redirect URIs.
5. Point Sveltia's `config.yml` at the new hostname.

Cloudflare provisions the certificate for the route itself. When a
route is configured, `wrangler dev` presents requests under the
route's host, so pin local runs with the `[dev]` block in the example.

## Operating it

- **Logs.** `wrangler tail` streams the deployed Worker's logs. Denials
  log as `translator.deny.<reason>` with the email, repo and path, and
  nothing else: the shipped code never logs a token.
- **Free-plan limits.** A Sveltia save is a handful of requests; a
  small org's editing is far below the daily cap. The Cloudflare
  dashboard shows usage.
- **Rolling back.** `wrangler deployments list`, then
  `wrangler rollback`. A rollback restores the secrets that version
  was deployed with, so after rotating a secret, roll forward with a
  fresh deploy rather than back.
