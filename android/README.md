# Bebig for Android (Trusted Web Activity)

The Play Store app is a thin Android wrapper around https://bebig.app, built with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap). The web app is the product: app updates
ship by deploying the website. A new Android build is only needed when this config, the icons, or the
Android target API change.

- `twa-manifest.json` — the wrapper's config. **`packageId` (`app.bebig`) is permanent once published.**
- The Android project itself is generated in CI from this file (it isn't committed).
- `iconUrl` is `icon-splash-512.png`: Bubblewrap uses it for the launch screen. It copies Android 12's own launch screen (the round launcher icon, 160 dp of Bubblewrap's 300 dp splash image, on the app's pale background), so the two read as one screen. The launcher icon comes from `maskableIconUrl`.
- `patch_launcher.py` runs after the project is generated and adds the Chrome 152+ splash workaround to `LauncherActivity` (see the file for why). Remove it once Chrome or androidbrowserhelper fixes [#623](https://github.com/GoogleChrome/android-browser-helper/issues/623).
- Targets API 36; runs on Android 7.0+ (`minSdkVersion` 24, required by Google's androidbrowserhelper library).

## Building

GitHub → Actions → **Android build** → *Run workflow*, enter the version name (e.g. `1.0.0`).
The version code is the workflow's run number, so it always goes up.
The run uploads `bebig-<version>.aab` (upload this to Play Console) and an `.apk` for installing on a test phone.

Signing uses the **upload key** from these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | the keystore file, base64-encoded |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | keystore password (same as the key password) |

Without them the workflow still runs, but signs with a throwaway key and names the files `…-TEST-UNSIGNABLE…` —
those can't be uploaded to Play.

Play App Signing holds the real app-signing key; the upload key only proves an upload came from us.
If the upload key is lost or leaked, it can be reset in Play Console (Setup → App integrity).

## Digital Asset Links

`public/.well-known/assetlinks.json` tells Android that bebig.app trusts this app, so it opens full-screen
without a browser bar. It must list the SHA-256 fingerprint of **every key that signs installs**:

1. the upload key (already there — covers APKs installed straight from CI), and
2. the **Play App Signing key** — copy it from Play Console → Setup → App integrity after creating the app,
   and add it to the list. Without it, the Play Store version shows a browser address bar.
