# Sveltia: wiring `admin/config.yml`

With the Worker deployed and its secrets set, point the site's Sveltia
at it. If Sveltia doesn't already work on this site against GitLab
directly (through `sveltia-cms-auth` and your own account), get that
working first; the proxy can't fix a site that doesn't load.

The proxy answers the access probe Sveltia has sent since 0.179, so
earlier releases are not supported.

## The config

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

- **`name: gitlab`.** The proxy looks like GitLab to Sveltia.
- **`repo`.** The project Sveltia reads and writes, as
  `<group>/<project>`. It needs a `repos:` entry in `editors.yml` and
  an entry under each editor who should reach it.
- **`branch`.** Must equal the repo's `branch` in `editors.yml`; a
  commit to any other branch is refused.
- **`api_root`.** Sveltia's REST and GraphQL calls go through the
  proxy instead of `gitlab.com`.
- **`auth_endpoint` and `base_url`.** The sign-in popup opens
  `https://<worker-hostname>/oauth/authorize`.
- **`proxied: true`.** Without it Sveltia builds some URLs against
  `gitlab.com` directly and bypasses the proxy.

The hostname serving `/admin/` must be in the Worker's
`ALLOWED_SITES`.

## Checking the wiring

1. Open `https://your-site.example.org/admin/` and sign in. The popup
   goes through Google and closes itself.
2. The collections populate.
3. Change one character in a draft and save.
4. `git log -1 --format='%an %ae / %cn %ce'` shows the editor, then
   the service account.

## Failure modes

`wrangler tail` shows the proxy's side of each; denials log as
`translator.deny.<reason>`.

- **The popup goes to gitlab.com, not Google.** `proxied: true` is
  missing.
- **"Unknown site."** The hostname serving `/admin/` is not in
  `ALLOWED_SITES`.
- **"Access denied" after Google sign-in.** The account's domain is
  not `ALLOWED_DOMAIN`.
- **"This account is not set up as an editor."** The email has no
  entry in `editors.yml`. Add one and redeploy.
- **Collections are empty** (`deny.read`). The editor has no entry
  under this repo.
- **Save is refused** (`deny.write`). The path is outside the repo's
  `write_roots`, has an extension the root doesn't allow, or doesn't
  match the editor's globs.
- **Save is refused** (`deny.branch`). Sveltia's `branch` differs
  from the repo's `branch` in `editors.yml`.
- **Save is refused** (`deny.route` or `deny.graphql_query`). Sveltia
  made a call the proxy doesn't serve, usually after a Sveltia
  upgrade. Open an issue with the Sveltia version and the logged
  path.
- **Save fails with "not allowed to push".** GitLab branch protection
  is refusing the service account; it needs Maintainer push on the
  branch.

## More than one site

Each further site is its hostname in `ALLOWED_SITES`, a `repos:` entry
and editor entries in `editors.yml`, a redeploy, and a `config.yml`
pointing at the same Worker with its own `repo:`. One sign-in covers
every site the editor is listed under.

## Per-collection visibility

Sveltia's `config.yml` is global: every editor sees every collection,
and one they can't write gets a 403 on save. The boundary holds; the
UI is just wider than it. For editors with disjoint scopes, separate
admin paths (`/admin/teacher/`, `/admin/office/`), each with its own
`config.yml`, narrow what each group sees, while `editors.yml` stays
the thing that decides.
