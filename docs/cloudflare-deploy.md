# Cloudflare: deploy the Worker

The translator runs as a single [Cloudflare Worker][cf-workers] on
the free plan. No queues, no R2, no KV, no D1, just the Worker
itself.

[cf-workers]: https://developers.cloudflare.com/workers/

What you'll do:

1. Set up a Cloudflare account (free).
2. Configure `wrangler.toml`.
3. Configure `editors.yml`.
4. Deploy with `wrangler deploy`.
5. Set the four secrets.
6. Verify with `/healthz` and the smoke harness.
7. (Optional) Bind to a custom hostname.

## Prerequisites

- Node.js 20+ and npm.
- A Cloudflare account. The Workers free plan is sufficient until you
  pass 100k requests/day.
- The four values from the GitLab and Google setup steps:
  - `GITLAB_API_TOKEN`, from
    [docs/gitlab-pat-setup.md](./gitlab-pat-setup.md)
  - `OAUTH_CLIENT_ID`, from
    [docs/google-oauth-setup.md](./google-oauth-setup.md)
  - `OAUTH_CLIENT_SECRET`, same
  - `JWT_SECRET`, generate locally:

    ```bash
    openssl rand -hex 32
    ```

    Save the value; you'll need it for both deploy and local dev.

## Step-by-step

### 1. Clone and install

```bash
git clone https://github.com/andrewdunndev/sveltia-identity-translator.git
cd sveltia-identity-translator
npm install
```

### 2. Configure wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
$EDITOR wrangler.toml
```

The minimum you must change:

```toml
[vars]
ALLOWED_DOMAIN = "example.org"   # your Workspace primary domain
```

`wrangler.toml` is gitignored by default in this repo because
`account_id` (added by wrangler the first time you deploy) and any
custom-route hostnames are deployment-specific. If you fork the repo
and want to commit your own `wrangler.toml`, update `.gitignore`.

### 3. Configure editors.yml

```bash
cp editors.yml.example editors.yml
$EDITOR editors.yml
```

Add an entry for each editor you want to grant access. Empty file =
nobody can write anything. See `editors.yml.example` for the full
schema.

This file is gitignored by default. You almost certainly want to
commit *your* `editors.yml` to *your* fork, versioning it gives
blame, review, and rollback for changes to who can edit what. To
commit it, remove the line from `.gitignore`.

### 4. Deploy

```bash
npx wrangler deploy
```

The first run prompts you to log in to Cloudflare (browser-based).
Subsequent runs use stored credentials.

After deploy, wrangler prints the Worker's URL, something like
`https://sveltia-identity-translator.<your-account>.workers.dev`.
This is the value you'll use as `<worker-hostname>` everywhere.

### 5. Set secrets

```bash
npx wrangler secret put OAUTH_CLIENT_ID
npx wrangler secret put OAUTH_CLIENT_SECRET
npx wrangler secret put GITLAB_API_TOKEN
npx wrangler secret put JWT_SECRET
```

Each command prompts for the value; paste it and hit enter. The
value is stored encrypted in Cloudflare's secret backend; wrangler
won't print or echo it.

After setting all four, redeploy is **not** required, secrets are
live immediately.

### 6. Verify

```bash
curl https://<worker-hostname>/healthz
# expected: translator ok
```

Run the smoke harness:

```bash
JWT_SECRET=<the value you set> node scripts/smoke.mjs \
  --base-url https://<worker-hostname> \
  --repo your-org/your-site \
  --admin admin@example.org \
  --editor smoke_editor@example.org
```

You should see `pass=18 blocked=0 fail=0` (or similar, counts can
shift as the suite grows). `blocked` cases are environment problems
the translator can't fix (branch protection, expired PAT), see the
output for resolution hints.

### 7. Custom hostname (optional)

If you want the Worker reachable at, say,
`translator.example.org` instead of `<name>.<account>.workers.dev`:

1. Add the domain to your Cloudflare account (so the zone is
   managed by Cloudflare DNS).
2. Uncomment the `[[routes]]` block in `wrangler.toml` and set
   `pattern` and `zone_name`:

   ```toml
   [[routes]]
   pattern = "translator.example.org/*"
   zone_name = "example.org"
   ```

3. Redeploy: `npx wrangler deploy`.
4. Update the `Authorized redirect URIs` in your Google OAuth client
   to include `https://translator.example.org/oauth/callback`.
5. Update Sveltia's `config.yml` to point at the new hostname.

Cloudflare auto-provisions a TLS certificate for the route
(typically within ~minutes, sometimes longer the first time).

## Operational notes

- **Logs.** `wrangler tail` streams logs from the deployed Worker
  in real time. Useful for watching denials (`translator.deny.*`)
  during onboarding.
- **Cold starts.** Workers cold-start in <100ms. The translator
  pre-compiles `editors.yml` regexes at module init; that init runs
  on cold start, but it's cheap (microseconds for typical
  allowlists).
- **Free-plan limits.** 100k requests/day; 10ms CPU per request.
  Each Sveltia save is on the order of 5-15 requests. A small
  org's daily editing pattern is unlikely to exceed the limit;
  monitor on the Cloudflare dashboard if you're unsure.
- **Rolling back.** `wrangler deployments list` shows recent
  deploys; `wrangler rollback <version-id>` reverts to a previous
  bundle.
- **Don't `console.log` the JWT, the PAT, or any secret.** The
  observability config bundles logs to Cloudflare; secrets in logs
  are still secrets in logs. The shipped code only logs identity +
  repo + path on denial paths.
