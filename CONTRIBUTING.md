# Contributing

PRs welcome. The translator is small (~700 LOC TypeScript + a 19-case
smoke harness) and the contribution shape is correspondingly small.

## What's in scope

- Bug fixes against the documented contract.
- Additional IdP config factories (`microsoftEntraConfig`,
  `oktaConfig`, etc.) following the `googleConfig` shape in
  `src/idp.ts`.
- Additional `Authorizer` implementations for non-YAML-file allowlist
  storage (database, LDAP, external policy engine). Don't replace
  `editorsYmlAuthorizer`; add alongside.
- Decap support: a parallel set of handlers and a top-level route
  prefix.
- Smoke harness coverage for cases that aren't yet covered.
- Documentation improvements, especially in `docs/` for the setup
  walkthrough.

## What's out of scope

- Features that change the contract Sveltia depends on. The proxy
  must keep working with stock Sveltia configs.
- Adding refresh-token machinery without a concrete reason. See
  ARCHITECTURE.md.
- Rate limiting, IP allowlists, or other "extra security" layers
  that aren't pulling weight. The boundary is the JWT; reinforce
  that boundary or step away.

## Running checks

```bash
npm run typecheck
npm run dev   # in one terminal
JWT_SECRET=$(grep JWT_SECRET .dev.vars | cut -d= -f2) npm run smoke
```

The smoke harness against a real GitLab repo will create + delete a
test file; ensure the configured editor identities have appropriate
allowlist entries (see `editors.yml.example`).

## Coding style

- TypeScript strict mode. Don't add `any`.
- No external dependencies beyond `yaml`. The Worker bundle is small
  and should stay that way.
- Comments explain *why*, not *what*. If a comment paraphrases the
  code under it, delete the comment.
- Match the existing module shape: handlers are top-level functions,
  the router in `src/index.ts` calls them.

## Commit style

Conventional commits, present tense imperative:

```
fix(graphql): allow capitalized "Mutation" in operationName
feat(idp): add microsoftEntraConfig factory
docs: explain author/committer split in README
```

Sign-off (`git commit -s`) is appreciated but not required.

## Upstream

The translated-identity pattern is plausibly upstream-shaped for
[`sveltia/sveltia-cms-auth`][upstream]. There's an open conversation
to absorb this codebase as a "translated-identity mode" with the
`IdPConfig` and `Authorizer` exposed as deployer-supplied hooks.

If you're contributing here and your change is mechanically
relevant upstream, mention it in the PR, it informs how we shape
the eventual upstream contribution.

[upstream]: https://github.com/sveltia/sveltia-cms-auth

## Reporting issues

Open a GitHub issue with:

- The Worker version / commit you're on.
- The Sveltia version on the consumer site.
- The IdP (Google Workspace / Microsoft 365 / Okta / etc.).
- A redacted snippet of the failing request + response (curl
  reproduction is gold).

If you can reproduce against the smoke harness, paste the failing
case output. That's usually the fastest path to a fix.
