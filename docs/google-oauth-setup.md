# Google: OAuth client setup

Editors sign in through Google's [authorization-code
flow][auth-code-flow]. You need an OAuth 2.0 client in a Google Cloud
project that belongs to your Workspace organization.

[auth-code-flow]: https://developers.google.com/identity/protocols/oauth2/web-server

## Steps

### 1. Cloud project

In the [Google Cloud Console][gcp-console], create a project (or
reuse one) under your Workspace organization.

[gcp-console]: https://console.cloud.google.com/

### 2. OAuth consent screen

**APIs & Services → OAuth consent screen.**

1. **User type:** Internal, which limits sign-in to your
   organization's accounts. An edition without Internal uses External
   and lists each editor under "Test users".
2. **App name:** what editors will see on the consent screen.
3. **Authorized domains:** the domain the Worker runs on, and your
   Workspace primary domain if different.
4. **Scopes:** `.../auth/userinfo.email` and
   `.../auth/userinfo.profile`. The proxy requests `openid email
   profile`.

### 3. OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client
ID.**

1. **Application type:** Web application.
2. **Authorized JavaScript origins:** none.
3. **Authorized redirect URIs:**
   `https://<worker-hostname>/oauth/callback`, and
   `http://localhost:8787/oauth/callback` for local dev. These can be
   edited later.
4. Create it and copy the client ID and secret; Google shows the
   secret once.

They become the Worker secrets `OAUTH_CLIENT_ID` and
`OAUTH_CLIENT_SECRET`.

## Checking the consent screen by hand

Before the Worker is deployed, this URL exercises the Google side:

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=<your client id>
  &redirect_uri=https://<worker-hostname>/oauth/callback
  &response_type=code
  &scope=openid email profile
  &hd=<your Workspace primary domain>
  &access_type=online
  &state=test
```

It should show the account chooser filtered to your domain, then the
consent screen, then redirect to the callback. A deployed Worker
answers that redirect with "Invalid or expired sign-in attempt",
because `state=test` is not one it signed; that is the expected end of
a hand-built check.

## Operating it

- **Internal apps need no Google verification.** An External app
  that isn't verified shows a warning banner; [verify it][verify] to
  remove the banner.
- **Secret rotation.** A client can hold several secrets. Add the new
  one, `wrangler secret put OAUTH_CLIENT_SECRET`, then delete the old.
- **The client ID is not a secret.** It appears in the authorize URL.
- **The `hd` claim** is set by Google on Workspace accounts. Personal
  accounts have none, so the proxy's check refuses them whatever the
  chooser showed.

[verify]: https://support.google.com/cloud/answer/13463073
