# GitLab: service account + access token

The translator forwards every editor request to GitLab as a single
service-account identity. You need:

1. A GitLab user (the bot) with **Maintainer** access to the group
   containing the repo(s) Sveltia edits.
2. A [Group Access Token][gat] (or Personal Access Token) for that
   identity, scope `api`.

[gat]: https://docs.gitlab.com/user/group/settings/group_access_tokens/

The translator stores the token as a Cloudflare Worker secret
(`GITLAB_API_TOKEN`); the token never reaches the editor's browser.

## Group Access Token vs Personal Access Token

Use a **Group Access Token** if you can. It belongs to the group, not
to a human, and lives in `Group → Settings → Access Tokens`. When the
human who created it leaves the org, the token survives. Group access
tokens are a [Premium / Ultimate feature][gat-tier] on gitlab.com but
also available on self-hosted Free.

Use a **Personal Access Token** as fallback. Create a dedicated bot
user (e.g. `<your-org>-cms-bot@example.org`), invite them to the
group as Maintainer, and create the PAT from that user's account
settings. PATs work everywhere.

[gat-tier]: https://about.gitlab.com/pricing/

## Step-by-step (Group Access Token)

1. Sign in to gitlab.com as a group owner.
2. Navigate: **Group → Settings → Access Tokens**.
3. Click "Add new token."
   - **Name:** `<your-org>-cms-bot`
   - **Expiration date:** 12 months out. Set a calendar reminder to
     rotate.
   - **Role:** Maintainer.
   - **Scopes:** `api`.
4. Click "Create access token." Copy the token value
   *immediately* — GitLab won't show it again.
5. Save the token in a password manager.

You'll feed this value into `wrangler secret put GITLAB_API_TOKEN`
during the Worker deploy step.

## Step-by-step (Personal Access Token, fallback)

1. Create the bot user. Sign up at gitlab.com with an email like
   `<your-org>-cms-bot@example.org` (or use a Workspace shared
   mailbox). The bot's email **must not** be in the same Workspace
   domain as your editors, or the editors will see it in the OAuth
   account chooser.
2. As a group owner, invite the bot user to the group as
   Maintainer: **Group → Manage → Members → Invite members**.
3. Sign in as the bot.
4. Navigate: **User Settings (top-right avatar) → Access Tokens**.
5. Same as group token: name, 12-month expiry, Maintainer-equivalent
   scope `api`.
6. Copy and save the token.

## Why Maintainer, not Developer

GitLab's default branch protection allows Maintainer push but blocks
Developer push to `main` / `master`. The translator's edit flow goes
direct to the default branch (Sveltia doesn't open MRs by default).
Developer-role tokens get 403s on save attempts; the smoke harness
will mark these as `blocked` rather than `fail`.

If you set up branch protection that requires MR review for every
change (a defensible choice for higher-stakes content), the
translator still works — but Sveltia will need to be configured to
open MRs rather than commit directly. That's a Sveltia-config matter,
not a translator-config matter.

## Operational notes

- **Rotation.** When the token approaches expiry, create a new one,
  update the Cloudflare secret (`wrangler secret put
  GITLAB_API_TOKEN`), redeploy. The old token can be revoked
  immediately after the new one is in production. The smoke harness
  has an early-warning case that flags tokens with <30 days
  remaining.
- **Audit trail.** Every commit will have the bot as `committer` and
  the editor as `author`. `git log --pretty='%cn / %an'` shows both.
  If something looks suspicious, the audit trail tells you both
  who recorded the commit (always the bot) and who originated the
  change (the editor identity verified by Google).
- **Scope minimization.** The translator only uses `api` scope.
  Don't grant `read_repository`, `write_repository`, or admin
  scopes — they aren't needed and broaden the blast radius if the
  token leaks.
- **Never put the token in a CI variable that prints to logs.**
  Cloudflare Worker secrets are write-only after `wrangler secret
  put`; that's the right storage. Don't echo the token into build
  output.
