# GitLab: service account and access token

Every request the proxy forwards reaches gitlab.com as one
service-account identity. You need:

1. A GitLab identity with **Maintainer** access to the group holding
   the repos Sveltia edits.
2. An access token for it with scope `api`.

The token becomes the Worker secret `GITLAB_API_TOKEN` and never
reaches an editor's browser.

## Group access token or personal access token

Use a [group access token][gat] if you can. It belongs to the group,
lives under **Group → Settings → Access Tokens**, and survives the
person who created it leaving. On gitlab.com they need a Premium or
Ultimate subscription.

Otherwise create a dedicated bot user, invite it to the group as
Maintainer, and create a personal access token from its settings. The
bot's email must not be in the editors' Workspace domain, or it will
show up in their account chooser.

[gat]: https://docs.gitlab.com/user/group/settings/group_access_tokens/

## Steps (group access token)

1. Sign in to gitlab.com as a group owner.
2. **Group → Settings → Access Tokens → Add new token.**
   - **Name:** `<your-org>-cms-bot`
   - **Expiration date:** a year out, with a calendar reminder.
   - **Role:** Maintainer.
   - **Scopes:** `api`.
3. Create it and copy the value at once; GitLab shows it only here.
   Keep it in a password manager until `wrangler secret put
   GITLAB_API_TOKEN`.

## Steps (personal access token)

1. Sign up at gitlab.com as the bot, with an email outside the
   editors' domain.
2. As a group owner, invite the bot as Maintainer: **Group → Manage →
   Members → Invite members**.
3. As the bot: **User Settings → Access Tokens**, same name, expiry
   and scope as above.

## Why Maintainer

GitLab's default branch protection lets Maintainers push to the
default branch and blocks Developers. Sveltia commits straight to the
branch, so a Developer token gets a 403 on every save; the smoke
harness reports that as `blocked`, not `fail`. If your repo requires
merge requests for every change, Sveltia has to be configured to open
them, which is a Sveltia setting, not a proxy one.

## Operating it

- **Rotation.** Create the new token, `wrangler secret put
  GITLAB_API_TOKEN`, then revoke the old one. The smoke harness flags
  a token with less than thirty days left.
- **Audit trail.** `git log --pretty='%an / %cn'` shows the editor as
  author and the service account as committer on every commit the
  proxy made.
- **Scope.** `api` is the only scope used. Don't add others.
- **Storage.** The Worker secret is the only copy that should exist
  outside the password manager. Never put it in a CI variable or
  build log.
