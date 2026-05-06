# Google: OAuth client setup

The translator authenticates editors via Google's [authorization-code
flow][auth-code-flow]. You need an OAuth 2.0 client registered in a
Google Cloud project that owns your Workspace organization (or has
permission to create OAuth apps for it).

[auth-code-flow]: https://developers.google.com/identity/protocols/oauth2/web-server

What you'll create:

- A Cloud project (one is fine; reuse if you already have one).
- An OAuth consent screen, ideally **Internal** (Workspace-only).
- An OAuth 2.0 client ID + secret, type **Web application**.
- Authorized redirect URIs pointing at your Worker's `/oauth/callback`.

## Step-by-step

### 1. Cloud project

1. Open [Google Cloud Console][gcp-console].
2. Top-left → project dropdown → "New project."
   - **Name:** something descriptive (`<your-org>-identity-translator`).
   - **Organization:** your Workspace org.
3. Wait ~30 seconds for provisioning.

[gcp-console]: https://console.cloud.google.com/

### 2. Enable the People API

The userinfo endpoint the translator hits requires the People API
enabled on the project. (You don't need any other API.)

1. **APIs & Services → Library** (left nav).
2. Search "People API" → Enable.

### 3. OAuth consent screen

1. **APIs & Services → OAuth consent screen** (left nav).
2. **User type:** Internal if your Workspace edition allows it. This
   restricts sign-in to your org's users, which is what you want.
   - If you're on a Workspace edition that doesn't support Internal
     (`workspace.google.com/individual`), choose External and add
     each editor's email under "Test users." You'll need to add
     them manually as you onboard editors.
3. App information:
   - **App name:** something the editor will recognize on the
     consent screen (`<Your Org> CMS sign-in`).
   - **User support email:** your IT contact.
   - **App logo:** optional.
4. **Authorized domains:** add the domain hosting your Worker (e.g.
   `example.org`) and your Workspace primary domain if different.
5. **Developer contact information:** your email.
6. Save.
7. **Scopes:** add `.../auth/userinfo.email` and
   `.../auth/userinfo.profile`. The translator needs both.
8. Save.

### 4. OAuth 2.0 client

1. **APIs & Services → Credentials** (left nav).
2. **Create credentials → OAuth client ID.**
3. **Application type:** Web application.
4. **Name:** `sveltia-identity-translator` (descriptive; only you
   see this).
5. **Authorized JavaScript origins:** none needed.
6. **Authorized redirect URIs:**
   - `https://<worker-hostname>/oauth/callback` (production)
   - `http://localhost:8787/oauth/callback` (local dev)

   Add both. You can add or remove URIs later without recreating the
   client.
7. Click "Create."
8. **Copy the Client ID and Client Secret immediately** — Google
   shows them once in a modal. Store them in a password manager.

These values become the Cloudflare Worker secrets `OAUTH_CLIENT_ID`
and `OAUTH_CLIENT_SECRET`.

## Verifying the consent screen flow

Before deploying the Worker, you can verify the OAuth setup by
constructing the authorize URL by hand:

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

Visiting this URL should:

1. Show the Google account chooser (constrained to your Workspace
   domain by the `hd=` hint).
2. After picking an account, show the consent screen with the
   scopes you configured.
3. Redirect to `https://<worker-hostname>/oauth/callback?code=...&state=test`.

If step 1 doesn't constrain to your domain, double-check that
`hd=<your domain>` is correct. (The hint is for UX only; the
server-side `hd` claim check in the translator is what enforces.)

## Operational notes

- **Internal consent type doesn't require Google verification.**
  Your editors will see "<App Name> wants to..." with no warning
  banner. External consent type with un-verified status shows a
  scary banner; if you're stuck on External, [verify your app][verify]
  to remove the banner.
- **Client Secret rotation.** Google supports multiple client
  secrets per OAuth client. To rotate: generate a new secret,
  update the Cloudflare Worker secret + redeploy, then revoke the
  old secret. Zero-downtime.
- **OAuth client ID is not a secret.** It's visible to anyone who
  hits your Worker's `/oauth/authorize` (it's in the URL). The
  client *secret* is the only sensitive value.
- **`hd` claim** is set automatically by Google on userinfo for
  Workspace accounts. Personal `@gmail.com` accounts have no `hd`
  claim, so the translator's check correctly rejects them.

[verify]: https://support.google.com/cloud/answer/13463073
