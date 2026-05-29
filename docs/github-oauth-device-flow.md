# GitHub Device Flow OAuth (repo clone / Connect)

The browser screen **“Authorize …”** shows the **OAuth application name** registered on GitHub for the client ID in use. Atlarix cannot override that title in code.

## Fix “Authorize Dyad”

1. Open [GitHub Developer settings → OAuth Apps](https://github.com/settings/developers).
2. Either:
   - **Rename** the existing app used by Atlarix (client ID `Ov23liWV2HdC0RBLecWx`) to **Atlarix** and upload the Atlarix logo, **or**
   - **Create** a new OAuth App:
     - Application name: **Atlarix**
     - Enable **Device Flow**
     - Homepage: `https://atlarix.dev` (or your product URL)
3. Set the client ID in:
   - Local dev: `OAUTH_CLIENT_ID=` in `.env` (the **Client ID** field only — usually starts with `Ov23li…`). Legacy `GITHUB_CLIENT_ID` is still read as a fallback until you rename it.
   - Release CI: repository secret `OAUTH_CLIENT_ID` (see `.github/workflows/release.yml`)

**Do not** put the client **secret**, a PAT, or a 40-character hex string in `OAUTH_CLIENT_ID`. Those are different values; GitHub returns `404 Not Found` for device flow.

Restart the app after changing `.env` (`npm start` again).

## Cancel / deny behavior

Closing the clone dialog or choosing **Cancel connection** stops device-flow polling in the main process so you do not get `Object has been destroyed` errors in Sentry.

Denying authorization on GitHub returns a normal “Authorization cancelled” message in the UI.
