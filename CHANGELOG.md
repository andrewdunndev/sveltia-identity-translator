# Changelog

## 0.2.0

### Security

- The OAuth callback accepted an unsigned `state` and ran a script that posted the session token to a caller-chosen origin; `state` is now signed, bound to a PKCE `__Host-` cookie, and the token is delivered only to the origin recorded in it.
- `site_id` was not checked against a list and responses carried `Access-Control-Allow-Origin: *`; both now use the `ALLOWED_SITES` allowlist, and CORS echoes only an allowed origin.
- GraphQL requests were forwarded verbatim: the mutation filter could be bypassed and a query could read projects outside the editor's entry; the proxy now parses the query and forwards only the fixed read shapes Sveltia sends.
- REST calls beyond those Sveltia makes, in the target project or outside it, were forwarded with the service-account token; the proxy now has a default-deny route table and per-route query allowlists.
- An empty `ALLOWED_DOMAIN` skipped the hosted-domain check; sign-in is now refused.
- A session JWT was minted for any account in the allowed domain; it is now minted only for identities listed in `editors.yml`, with claims taken from the verified Google `id_token` (`iss`, `aud`, `exp`, `hd`, `email_verified`).
- Writes were not limited to content paths or file types; each repo now declares `write_roots`, each with its own extension allowlist, and control characters and non-canonical paths are rejected.
- The commit branch came from the request; it is now pinned to the repo's `branch` in `editors.yml`.

### Changed

- Requires Sveltia CMS 0.179 or later: its `users?search` access probe is answered by the proxy.
- The Worker is built by `createWorker({ editors })`, exported from the package root with `buildAuthorizer`, `buildBranchResolver`, `buildIsEditor` and the `Env` type, so another project can depend on this package. `src/index.ts` is the standalone entry.
- New required var `ALLOWED_SITES`.
- Session JWTs last 8 hours.
- The commit author name is the local part of the editor's email.
- `editors.yml` has a `repos:` section holding each repo's `branch` and `write_roots` (glob mapped to allowed extensions) alongside the editor entries.

### Added

- An offline test suite (`npm test`), a GitHub Actions workflow, and `npm run lint:editors` for checking an `editors.yml`.
- `scripts/smoke.mjs` takes `--base-url`, `--repo`, `--domain`, `--admin`, `--editor`, `--stranger`, `--token-name` and `--site`.

### Upgrading

Editors sign in once more after deploy. `editors.yml` must move to the new shape (see `editors.yml.example`): without a `repos:` entry carrying `branch` and `write_roots`, a repo accepts no writes. Set `ALLOWED_SITES` before deploying.
