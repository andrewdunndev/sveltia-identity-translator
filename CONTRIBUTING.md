# Contributing

PRs welcome. The proxy is small and the contribution shape is
correspondingly small.

## In scope

- Bug fixes against the documented contract.
- Another IdP config beside `googleConfig` in `src/idp.ts`
  (`microsoftEntraConfig`, `oktaConfig`).
- Another `Authorizer` for an allowlist that lives outside a YAML file
  (database, directory, policy engine), added beside `buildAuthorizer`
  rather than replacing it.
- Decap support: parallel handlers under their own route prefix.
- A route-table or `PROJECT` entry for a Sveltia call the proxy
  refuses, with the Sveltia version that sends it.
- Test and smoke coverage, and the setup walkthroughs in `docs/`.

## Out of scope

- Changes to the contract Sveltia depends on; stock Sveltia configs
  must keep working.
- Refresh tokens without a concrete reason (see ARCHITECTURE.md).
- Rate limiting, IP allowlists and other layers that aren't pulling
  weight. The boundaries are the JWT, the route table and the
  allowlist; reinforce those.

## Checks

```bash
npm run typecheck
npm test                          # offline suite
npm run lint:editors -- editors.yml.example
npm run dev                       # in one terminal
JWT_SECRET=$(grep JWT_SECRET .dev.vars | cut -d= -f2) npm run smoke
```

CI runs the first three on every push. The smoke harness needs a
running Worker and a real repo; it creates and deletes a test file,
and the identities it uses need entries matching
`editors.yml.example`.

## Style

- TypeScript strict mode; no `any`.
- Dependencies stay at `yaml` and `graphql`.
- Comments say why, not what; a comment that paraphrases the code
  under it goes.
- Handlers are top-level functions; the router in `src/worker.ts`
  calls them.

## Commits

One imperative sentence in sentence case, saying what changed in this
repo:

```
Test that CORS echoes only allowlisted origins
Add microsoftEntraConfig beside googleConfig
```

## Reporting issues

Open a GitHub issue with the Worker version, the Sveltia version on
the site, the identity provider, and a redacted failing request and
response. A failing smoke case, pasted, is the fastest route to a fix.
