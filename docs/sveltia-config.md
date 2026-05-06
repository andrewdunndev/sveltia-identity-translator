# Sveltia: wiring `admin/config.yml`

Once the Worker is deployed and the secrets are set, the only
remaining step is to point your site's Sveltia at it.

This doc assumes you already have Sveltia working with the standard
`sveltia-cms-auth` proxy. If not, get that working first against your
existing GitLab account, then swap in the translator. That ordering
makes troubleshooting much easier, if Sveltia doesn't load with a
direct GitLab token, the translator won't help.

## The config

In your site's `admin/config.yml`:

```yaml
backend:
  name: gitlab
  repo: your-org/your-site
  branch: main
  api_root: https://<worker-hostname>/gitlab
  auth_endpoint: oauth/authorize
  base_url: https://<worker-hostname>
  proxied: true
```

Field-by-field:

- **`name: gitlab`**, keep the GitLab backend. The translator looks
  like GitLab to Sveltia; we're not switching backends, just
  redirecting traffic through the proxy.
- **`repo`**, the GitLab project Sveltia will read and write.
  Format `<group>/<project>`. Must have an entry under at least one
  identity in `editors.yml`.
- **`branch`**, usually `main`. Whatever your default is.
- **`api_root: https://<worker-hostname>/gitlab`**, this is what
  changes. Sveltia's REST and GraphQL calls go through the
  translator instead of directly to `gitlab.com/api/v4`.
- **`auth_endpoint: oauth/authorize`**, Sveltia treats this as a
  path under `base_url`. The popup will open
  `https://<worker-hostname>/oauth/authorize?...`.
- **`base_url: https://<worker-hostname>`**, root of the auth
  popup URL.
- **`proxied: true`**, tells Sveltia we're running behind a proxy
  rather than talking to GitLab directly. Without this, Sveltia
  applies a few client-side optimizations (e.g. constructing some
  URLs against `gitlab.com` directly) that bypass the translator.

## Smoke-test the wiring

1. Open `https://your-site.example.org/admin/`.
2. Click "Sign in with Google" (Sveltia labels this with whatever
   the `auth_type` resolves to; it's still going through Google).
3. The popup should redirect through the Google consent screen and
   close itself.
4. The Sveltia UI should populate with your repo's collections.
5. Make a test edit, change a single character in a draft post.
6. Click Save.
7. Pull the repo and run `git log -1 --format='%an %ae / %cn %ce'`.
   The first half should be your editor identity; the second half
   should be the bot.

## Common failure modes

- **"Sign in with GitLab" redirects to gitlab.com instead of
  Google.** `proxied: true` is missing. Add it.
- **Sveltia loads but collections are empty.** Read access denied
  by `editors.yml`. Check `wrangler tail` for `translator.deny.read`
  log lines. The signed-in editor's email must have an entry under
  the configured repo, even if the entry is just `["**"]`.
- **Save returns "Forbidden."** Write allowlist denied. Check
  `wrangler tail` for `translator.deny.write` entries. The editor's
  globs under the repo don't match the file path being written.
- **Save returns 500 with "not allowed to push."** GitLab branch
  protection is refusing the bot. The translator forwarded
  correctly; resolve in GitLab → Settings → Repository → Protected
  branches. The bot needs Maintainer-or-equivalent push permission
  on the branch.
- **Image upload fails with "graphql mutation not permitted."**
  This shouldn't happen, Sveltia uses REST for uploads. If it
  does, you're on a Sveltia version that's regressed; check
  upstream issues. The translator deliberately fails closed on
  GraphQL mutations (see ARCHITECTURE.md).
- **"hd claim mismatch" error page after Google sign-in.** The
  signed-in account isn't in the `ALLOWED_DOMAIN` you set in
  `wrangler.toml`. Check the email.

## Multi-site setup

The translator is multi-tenant. To add a second site:

1. Add the second site's repo + path globs to `editors.yml` for each
   editor who should have access there.
2. Redeploy the Worker (it bundles `editors.yml` at build time):
   `npx wrangler deploy`.
3. In the second site's `admin/config.yml`, point at the same Worker
   with `repo:` set to the second project.

No new Worker, no new OAuth client, no new secrets. The same JWT
that signs the first site's editor in works for the second site,
constrained by `editors.yml` to the repos they're listed under.

## Per-collection visibility

Sveltia's `config.yml` is global, every signed-in editor sees every
collection. This is a Sveltia limitation, not a translator one.

If your editor count is small (1-3 people, say), the translator's
allowlist is sufficient: an editor who clicks into a collection
they can't write gets a 403 on save. Confusing UI, harmless
boundary.

If you have many editors with disjoint scopes, the cleanest
workaround is multiple admin paths:

```
your-site/
  admin/
    teacher/
      config.yml      # collections teachers should see
      index.html
    admin/
      config.yml      # collections admins should see
      index.html
```

Each admin path has its own scoped `config.yml`. Editors get
URL-restricted UIs; the translator's allowlist remains the actual
boundary.

This is a Sveltia roadmap candidate ("per-collection `visible_to`
predicate keyed off identity claims") and not a translator
problem.
