"""Patch Bubblewrap's generated LauncherActivity with the Chrome 152+ splash workaround.

Since Chrome 152, Chrome refuses the TWA splash-image handover unless the app holds a read grant on
its own splash file (GoogleChrome/android-browser-helper#623). androidbrowserhelper then silently skips
the splash, so Chrome shows its blank (white/black) window until the page paints. Granting ourselves
READ + PERSISTABLE on the splash URI before super.onCreate() makes the handover work again, so the
splash stays up until bebig.app has drawn and then fades straight into it.

Relies on androidbrowserhelper/Bubblewrap internals (twa_splash/splash_image.png and the
<applicationId>.fileprovider authority); wrapped in try/catch so a future change can't crash the app.
Run from android/ after `bubblewrap update`. Fails loudly if the anchor isn't found.
"""
import pathlib, sys

files = list(pathlib.Path('app/src/main/java').rglob('LauncherActivity.java'))
if len(files) != 1:
    sys.exit(f'expected one LauncherActivity.java, found {files}')
path = files[0]
src = path.read_text()
anchor = 'super.onCreate(savedInstanceState);'
if src.count(anchor) != 1:
    sys.exit(f'anchor {anchor!r} found {src.count(anchor)} times in {path}')
grant = '''// Chrome 152+ splash workaround (android/patch_launcher.py, android-browser-helper#623)
        try {
            java.io.File splash = new java.io.File(new java.io.File(getFilesDir(), "twa_splash"), "splash_image.png");
            android.net.Uri splashUri = androidx.core.content.FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", splash);
            grantUriPermission(getPackageName(), splashUri,
                    android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | android.content.Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        } catch (RuntimeException e) {
            android.util.Log.w("Bebig", "Splash grant failed", e);
        }
        '''
path.write_text(src.replace(anchor, grant + anchor))
print(f'patched {path}')
print(path.read_text())
