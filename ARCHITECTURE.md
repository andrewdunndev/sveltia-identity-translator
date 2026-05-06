# Architecture

The non-obvious design decisions, with the reasoning that drove each.
These take some thinking-through and aren't derivable from "it's a
proxy."

## Why GraphQL is read-only

![author and committer on a commit](diagrams/author-committer.svg)

GitLab's GraphQL `commitCreate` mutation has no author-override field;
commits attribute to the authenticated user, period. Translated
identity needs author injection, which only works via REST `POST
/repository/commits` (which does accept `author_name` +
`author_email`). Routing GraphQL writes through the translator would
silently break editor attribution.

The translator fails closed on any request body containing the
`mutation` keyword (HTTP 403). The regex is intentionally permissive.
A false positive on a string literal containing the word "mutation"
inside a query is acceptable; the failure mode is "use REST for
writes," which is what Sveltia already does.

If upstream `commitCreate` ever gains an `author` override, this
constraint loosens. Until then, fail-closed is the honest model.

## Why `hd` is checked twice

Once at the authorize URL (Google's `hd` parameter), once at the
userinfo response (the `hd` claim). They are not the same check.

The `hd=<domain>` URL parameter is a UI hint. It scopes Google's
account chooser to accounts in the named domain. A user who has both
a personal `@gmail.com` account and a `@example.org` account can
still pick the personal one if they want. The hint shapes
convenience, not access.

The userinfo response carries `hd` as a cryptographic claim. The
server-side check on that claim is the actual boundary. A user
bypassing the URL hint and signing in with their personal account
will still fail the userinfo check and get a 403.

Removing either check weakens the model. Remove the URL hint and
editors see their personal accounts in the chooser, which is a UX
regression. Remove the userinfo check and personal accounts can sign
in successfully. A future contributor might think `hd=` in the URL
is the security check; the comments in `src/oauth.ts` and
`src/idp.ts` are explicit about the difference to head that off.

## Why one Worker can serve many sites

![one Worker fronts many sites](diagrams/multi-tenant.svg)

The translator is multi-tenant by construction. A second consumer
site (a sister blog, a documentation site, anything Sveltia-driven)
is a Sveltia config drop and one or more entries in `editors.yml`.
No new Worker, no new domain, no new secrets.

This matters operationally. An in-repo proxy (one Worker per site)
is per-site by construction; every new site doubles the auth
surface to operate, monitor, and rotate secrets across. The relay
keeps the auth surface consolidated.

The boundary is per-(identity, repo, path-glob), so cross-site
access is explicit: `editor@example.org` in `editors.yml` lists each
repo separately, and a path-glob entry under one repo doesn't grant
anything in another. A typo in one entry can't accidentally unlock
a different site.

## Why JWT is 24h with no refresh

24 hours is long enough that an editor's saving session never
re-authenticates mid-flight. It's short enough that a leaked token
expires within a working day.

Refresh-token machinery would gain rotation but cost code and a flow
the translator doesn't need at this scale. Sveltia silently re-auths
on 401, so a session that does outlast the JWT recovers without a
user-visible failure (the editor sees the popup briefly, then is
back where they were). The cost-benefit doesn't favor adding refresh
until there's a concrete reason (leaked-token incidents,
auditor-driven session-length requirements, etc.).

JWTs are signed HS256 with a server-side secret (`JWT_SECRET`). The
symmetric algorithm is appropriate here because there's exactly one
issuer and one verifier, the same Worker, so the public-key
distribution problem that motivates RS256 doesn't exist. Force-revoke
all sessions by rotating `JWT_SECRET` (`wrangler secret put
JWT_SECRET`).

## Why `editors.yml` lives in the Worker's repo

Versioning the allowlist in git gives blame, review, and rollback for
free. Adding an editor is a commit; CI runs and any parse error
surfaces before deploy. If an entry was wrong, `git revert` undoes
it. There's no separate database to back up, schema-migrate, or
authenticate against.

The Worker imports `editors.yml` as a text resource at module init
(via wrangler's `[[rules]]` text-bundling), parses it once, and
pre-compiles all path globs. Per-request authorization is a
synchronous map lookup + regex test on already-compiled patterns.
Cold starts are fast.

If your scale demands the allowlist live elsewhere (hundreds of
editors, thousands of repos, dynamic provisioning from an HR
system), implement the `Authorizer` interface against your data
source. The proxy consumes the hook; it doesn't care about the
storage.

## Why the smoke harness mints JWTs locally

A 19-case test suite hits every contract Sveltia depends on by
hand-minting JWTs against the Worker's secret. The Google OAuth
round-trip is exercised separately in a browser.

Headless OAuth is brittle, slow, and the test rig would need a
dedicated Workspace user (with its own credentials and recovery
flow) to drive. The gain over local minting is small: the Google
side of the contract is "302 to consent screen with the right
client_id and state," which the smoke harness asserts at the URL
level without round-tripping. Local minting covers ~95% of the
surface in five seconds; the remaining 5% is validated once during
real onboarding when an editor signs in for the first time.

Pragmatism over completeness. A future contributor who needs the
headless round-trip can add a test using Playwright; the local-mint
harness should stay because it's fast and contract-shaped.

## Why CORS is currently `*`

`access-control-allow-origin: *` is permissive. The translator
doesn't enforce origin-based access; it enforces JWT-based access,
and the JWT only ever reaches the Sveltia origin via the
`postMessage`'s `targetOrigin` (which is set to the
`state.origin` from the authorize step, derived from `site_id`).

Tightening CORS to specific consumer-site origins is straightforward
once the canonical origins are known. For a multi-tenant deploy
where new consumer sites might appear without redeploy, leaving
CORS open and relying on the JWT boundary is operationally simpler.
For a single-tenant deploy with a fixed origin, narrowing CORS adds
a thin extra layer at low cost; do it.

## What's deliberately not implemented

- **Per-collection visibility in Sveltia.** Sveltia's `config.yml`
  is global: every signed-in editor sees every collection. The
  actual access boundary is the translator's allowlist; an editor
  who clicks into a collection they can't write gets a 403 on save.
  That's a confusing UI, but the cleanest fix ("multiple admin
  paths," `/admin/teacher/`, `/admin/admin/`, each with its own
  scoped `config.yml`) is deferred until the editor count
  justifies it.
- **Refresh tokens.** See "Why JWT is 24h with no refresh."
- **Decap support.** The handlers are mechanically similar but the
  client-side `postMessage` shape differs slightly. If you need it,
  the contribution is small; PRs welcome.
- **Microsoft Entra / Okta config factories.** The `IdPConfig`
  interface is generic enough to fit them; only Google has been
  exercised in production. Adding `microsoftEntraConfig(env)` next
  to `googleConfig(env)` is the contribution shape.
