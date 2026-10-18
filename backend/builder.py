"""Android project customization, icon generation, signing and Gradle execution."""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR") or ROOT)
BUILDS_DIR = DATA_DIR / "builds"
KEYSTORE_DIR = DATA_DIR / "keystore"
WRAPPER_DIR = ROOT / "android-app-wrapper"
TEMPLATE_ANDROID = WRAPPER_DIR / "android"
DEFAULT_ICON_PATH = ROOT / "icon.png"

BUILDS_DIR.mkdir(parents=True, exist_ok=True)

IS_WINDOWS = os.name == "nt"
BUILD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
GRADLE_TIMEOUT = int(os.environ.get("GRADLE_TIMEOUT", "1800"))
BUILD_SEMAPHORE = threading.Semaphore(int(os.environ.get("MAX_CONCURRENT_BUILDS", "1")))

# ---------------------------------------------------------------- records
build_records = {}
_records_lock = threading.RLock()
_keystore_lock = threading.Lock()
_template_lock = threading.Lock()


def _meta_path(build_id):
    return BUILDS_DIR / build_id / "meta.json"


def save_build_record(build_id, record):
    """Persist a record atomically (memory + meta.json) so any worker can read it."""
    with _records_lock:
        build_records[build_id] = dict(record)
        path = _meta_path(build_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"meta.{secrets.token_hex(4)}.tmp")
        tmp.write_text(json.dumps(record), encoding="utf-8")
        os.replace(tmp, path)


def get_build_record(build_id):
    if not BUILD_ID_RE.match(build_id or ""):
        return None
    with _records_lock:
        path = _meta_path(build_id)
        if path.exists():
            try:
                rec = json.loads(path.read_text(encoding="utf-8"))
                build_records[build_id] = rec
                return dict(rec)
            except (OSError, ValueError):
                pass
        rec = build_records.get(build_id)
        return dict(rec) if rec else None


def update_build_record(build_id, **fields):
    with _records_lock:
        rec = get_build_record(build_id) or {"build_id": build_id}
        rec.update(fields)
        save_build_record(build_id, rec)
        return rec


def verify_build_access(build_id, session_id=None, token=None):
    """Return the record if the caller owns it (session cookie or secret token), else None."""
    rec = get_build_record(build_id)
    if not rec:
        return None
    real_token = rec.get("build_token") or ""
    if token and real_token and secrets.compare_digest(str(token), str(real_token)):
        return rec
    if session_id and rec.get("session_id") and secrets.compare_digest(str(session_id), str(rec["session_id"])):
        return rec
    return None


def public_view(rec):
    hidden = {"build_token", "session_id", "apk_path", "config", "icon_path"}
    return {k: v for k, v in rec.items() if k not in hidden}


# ------------------------------------------------------------ environment
def _exe(name, win_ext=".exe"):
    return name + (win_ext if IS_WINDOWS else "")


def find_java_home():
    jh = os.environ.get("JAVA_HOME")
    if jh and (Path(jh) / "bin" / _exe("javac")).exists():
        return Path(jh)
    javac = shutil.which("javac")
    if javac:
        return Path(javac).resolve().parent.parent
    return None


def find_android_sdk():
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        v = os.environ.get(var)
        if v and Path(v).exists():
            return Path(v)
    candidates = [
        Path.home() / "Android" / "Sdk",
        Path.home() / "AppData" / "Local" / "Android" / "Sdk",
        Path.home() / "Library" / "Android" / "sdk",
        Path("/opt/android-sdk"),
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def get_keytool_path():
    jh = find_java_home()
    if jh and (jh / "bin" / _exe("keytool")).exists():
        return str(jh / "bin" / _exe("keytool"))
    return shutil.which("keytool")


def get_apksigner_path():
    sdk = find_android_sdk()
    if sdk and (sdk / "build-tools").exists():
        versions = sorted((p for p in (sdk / "build-tools").iterdir() if p.is_dir()),
                          key=lambda p: [int(x) if x.isdigit() else 0 for x in re.split(r"[.\-]", p.name)],
                          reverse=True)
        for v in versions:
            cand = v / _exe("apksigner", ".bat")
            if cand.exists():
                return str(cand)
    return shutil.which("apksigner")


def environment_info():
    return {
        "java": find_java_home() is not None,
        "android_sdk": find_android_sdk() is not None,
        "keytool": bool(get_keytool_path()),
        "apksigner": bool(get_apksigner_path()),
        "is_configured": bool(find_java_home() and find_android_sdk() and get_keytool_path()),
    }


# --------------------------------------------------------------- keystore
def get_or_create_release_keystore():
    path = Path(os.environ.get("RELEASE_KEYSTORE_PATH") or (KEYSTORE_DIR / "release.keystore"))
    alias = os.environ.get("RELEASE_KEY_ALIAS") or "release"
    store_pass = os.environ.get("RELEASE_KEYSTORE_PASSWORD") or "release123"
    key_pass = os.environ.get("RELEASE_KEY_PASSWORD") or store_pass
    with _keystore_lock:
        if not path.exists() or path.stat().st_size == 0:
            keytool = get_keytool_path()
            if not keytool:
                raise RuntimeError("keytool not found. Install JDK 17+ and set JAVA_HOME.")
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                path.unlink()
            subprocess.run(
                [keytool, "-genkeypair", "-keystore", str(path), "-alias", alias,
                 "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
                 "-storepass", store_pass, "-keypass", key_pass,
                 "-dname", "CN=WebToApk, OU=Mobile, O=WebToApk, C=US"],
                check=True, capture_output=True, text=True, timeout=120)
    return {"keystore_path": str(path), "alias": alias, "store_pass": store_pass, "key_pass": key_pass}


# ------------------------------------------------------------------ icons
def cleanup_uploaded_icon(icon_path, build_id=None):
    """Delete the user's uploaded icon (never the bundled default)."""
    try:
        p = Path(icon_path) if icon_path else None
        if p and p.exists() and p.resolve() != DEFAULT_ICON_PATH.resolve():
            p.unlink()
        if build_id and BUILD_ID_RE.match(build_id):
            for extra in (BUILDS_DIR / build_id).glob("icon_input.*"):
                extra.unlink(missing_ok=True)
    except OSError:
        pass


LEGACY_SIZES = {"ldpi": 36, "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE_SIZES = {"ldpi": 81, "mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
"""


def process_and_generate_icons(icon_path, res_dir):
    from PIL import Image, ImageDraw
    res_dir = Path(res_dir)
    with Image.open(icon_path) as im:
        img = im.convert("RGBA")
    side = min(img.size)
    left, top = (img.width - side) // 2, (img.height - side) // 2
    img = img.crop((left, top, left + side, top + side))

    for density, size in LEGACY_SIZES.items():
        out = res_dir / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)
        icon = img.resize((size, size), Image.LANCZOS)
        icon.save(out / "ic_launcher.png", "PNG")
        mask = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
        mask = mask.resize((size, size), Image.LANCZOS)
        round_icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        round_icon.paste(icon, (0, 0), mask)
        round_icon.save(out / "ic_launcher_round.png", "PNG")

    for density, size in ADAPTIVE_SIZES.items():
        out = res_dir / f"mipmap-{density}"
        inner = int(size * 0.61)  # keep artwork inside the adaptive-icon safe zone
        fg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        fg.paste(img.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
        fg.save(out / "ic_launcher_foreground.png", "PNG")

    anydpi = res_dir / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    (anydpi / "ic_launcher.xml").write_text(ADAPTIVE_XML, encoding="utf-8")
    (anydpi / "ic_launcher_round.xml").write_text(ADAPTIVE_XML, encoding="utf-8")


# ---------------------------------------------------------- template prep
PERMISSION_XML = {
    "internet": ['<uses-permission android:name="android.permission.INTERNET" />',
                 '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />'],
    "camera": ['<uses-permission android:name="android.permission.CAMERA" />',
               '<uses-feature android:name="android.hardware.camera" android:required="false" />'],
    "microphone": ['<uses-permission android:name="android.permission.RECORD_AUDIO" />',
                   '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />'],
    "location": ['<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
                 '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />'],
    "notifications": ['<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'],
    "bluetooth": ['<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />',
                  '<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />',
                  '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
                  '<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />'],
    "photos_videos": ['<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />',
                      '<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />',
                      '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />'],
}

MANIFEST_TEMPLATE = """<?xml version="1.0" encoding="utf-8" ?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:usesCleartextTraffic="{cleartext}"
        android:theme="@style/AppTheme">
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${{applicationId}}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />
        </provider>
    </application>

    <!-- Permissions -->
{permissions}
</manifest>
"""


CONFIG_DEFAULTS = {
    "version_name": "1.0.0", "version_code": 1, "permissions": ["internet"],
    "primary_color": "#8B5CF6", "status_bar_color": "#09090B", "nav_bar_color": "#09090B",
    "external_links": "browser",
}


def _gq(value):
    """Escape for a single-quoted Gradle string."""
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


def _run(cmd, cwd, timeout=1800, env=None):
    return subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True, text=True, timeout=timeout)


def ensure_template_synced():
    """Make sure the master template has node_modules and the generated Capacitor files.

    Done once (in Docker at image build time; on first build when running locally)."""
    plugins_dir = TEMPLATE_ANDROID / "capacitor-cordova-android-plugins"
    cap_android = WRAPPER_DIR / "node_modules" / "@capacitor" / "android"
    if plugins_dir.exists() and cap_android.exists():
        return
    with _template_lock:
        if plugins_dir.exists() and cap_android.exists():
            return
        npm, npx = shutil.which("npm"), shutil.which("npx")
        if not npm or not npx:
            raise RuntimeError("Node.js/npm not found: needed once to prepare the Android template.")
        if not cap_android.exists():
            cmd = [npm, "ci"] if (WRAPPER_DIR / "package-lock.json").exists() else [npm, "install"]
            r = _run(cmd, WRAPPER_DIR, 900)
            if r.returncode != 0:
                raise RuntimeError("npm install failed: " + (r.stderr or r.stdout)[-400:])
        (WRAPPER_DIR / "www").mkdir(exist_ok=True)
        index = WRAPPER_DIR / "www" / "index.html"
        if not index.exists() or "@\"" in index.read_text(encoding="utf-8", errors="ignore"):
            index.write_text('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>App</title></head><body></body></html>',
                             encoding="utf-8")
        r = _run([npx, "cap", "sync", "android"], WRAPPER_DIR, 600)
        if r.returncode != 0:
            raise RuntimeError("cap sync failed: " + (r.stderr or r.stdout)[-400:])


def _copy_capacitor_modules(build_dir):
    for pkg in ("android", "splash-screen"):
        src = WRAPPER_DIR / "node_modules" / "@capacitor" / pkg
        if src.exists():
            shutil.copytree(src, build_dir / "node_modules" / "@capacitor" / pkg,
                            ignore=shutil.ignore_patterns("build", ".gradle", "node_modules"))


def prepare_build(build_id, config, icon_path=None):
    """Create an isolated copy of the Android template customized with `config`."""
    config = {**CONFIG_DEFAULTS, **config}
    build_dir = BUILDS_DIR / build_id
    android_dir = build_dir / "android"
    build_dir.mkdir(parents=True, exist_ok=True)
    if android_dir.exists():
        shutil.rmtree(android_dir)
    shutil.copytree(TEMPLATE_ANDROID, android_dir,
                    ignore=shutil.ignore_patterns(".gradle", "build", "local.properties", "*.apk"))
    _copy_capacitor_modules(build_dir)

    pkg = config["package_name"]
    app_dir = android_dir / "app"
    main = app_dir / "src" / "main"
    url = config["url"]
    is_http = url.lower().startswith("http://")

    # 1. Java package + MainActivity
    shutil.rmtree(app_dir / "src" / "test", ignore_errors=True)
    shutil.rmtree(app_dir / "src" / "androidTest", ignore_errors=True)
    shutil.rmtree(main / "java", ignore_errors=True)
    java_dir = main / "java" / Path(*pkg.split("."))
    java_dir.mkdir(parents=True, exist_ok=True)
    (java_dir / "MainActivity.java").write_text(
        f"package {pkg};\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {{}}\n",
        encoding="utf-8")

    # 2. app/build.gradle (id, version, release signing)
    ks = get_or_create_release_keystore()
    shutil.copyfile(ks["keystore_path"], app_dir / "release.keystore")
    gradle_file = app_dir / "build.gradle"
    g = gradle_file.read_text(encoding="utf-8")
    g = re.sub(r'namespace\s*=\s*"[^"]*"', f'namespace = "{pkg}"', g)
    g = re.sub(r'applicationId\s+"[^"]*"', f'applicationId "{pkg}"', g)
    g = re.sub(r"versionCode\s+\d+", f"versionCode {int(config['version_code'])}", g)
    g = re.sub(r'versionName\s+"[^"]*"', f'versionName "{config["version_name"]}"', g)
    signing = (
        "    signingConfigs {\n"
        "        release {\n"
        "            storeFile file('release.keystore')\n"
        f"            storePassword '{_gq(ks['store_pass'])}'\n"
        f"            keyAlias '{_gq(ks['alias'])}'\n"
        f"            keyPassword '{_gq(ks['key_pass'])}'\n"
        "        }\n"
        "    }\n"
        "    lint {\n"
        "        checkReleaseBuilds = false\n"
        "        abortOnError = false\n"
        "    }\n"
        "    buildTypes {"
    )
    g = g.replace("    buildTypes {", signing, 1)
    g = g.replace("minifyEnabled false", "minifyEnabled false\n            signingConfig signingConfigs.release", 1)
    gradle_file.write_text(g, encoding="utf-8")

    # 3. Manifest (permissions)
    perms = ["internet"] + [p for p in config.get("permissions", []) if p != "internet"]
    lines, seen = [], set()
    for p in perms:
        for line in PERMISSION_XML.get(p, []):
            if line not in seen:
                seen.add(line)
                lines.append("    " + line)
    (main / "AndroidManifest.xml").write_text(
        MANIFEST_TEMPLATE.format(cleartext="true" if is_http else "false", permissions="\n".join(lines)),
        encoding="utf-8")

    # 4. Strings, colors, theme
    res = main / "res"
    name = escape(config["app_name"]).replace("'", "\\'").replace("@", "\\@")
    (res / "values" / "strings.xml").write_text(
        "<?xml version='1.0' encoding='utf-8'?>\n<resources>\n"
        f'    <string name="app_name">{name}</string>\n'
        f'    <string name="title_activity_main">{name}</string>\n'
        f'    <string name="package_name">{pkg}</string>\n'
        f'    <string name="custom_url_scheme">{pkg}</string>\n'
        "</resources>\n", encoding="utf-8")
    (res / "values" / "colors.xml").write_text(
        "<?xml version='1.0' encoding='utf-8'?>\n<resources>\n"
        f'    <color name="colorPrimary">{config["primary_color"]}</color>\n'
        f'    <color name="colorPrimaryDark">{config["status_bar_color"]}</color>\n'
        f'    <color name="colorAccent">{config["primary_color"]}</color>\n'
        f'    <color name="webtoapk_status_bar">{config["status_bar_color"]}</color>\n'
        f'    <color name="webtoapk_nav_bar">{config["nav_bar_color"]}</color>\n'
        "</resources>\n", encoding="utf-8")
    styles = res / "values" / "styles.xml"
    s = styles.read_text(encoding="utf-8")
    bars = ('        <item name="android:statusBarColor">@color/webtoapk_status_bar</item>\n'
            '        <item name="android:navigationBarColor">@color/webtoapk_nav_bar</item>\n')
    s = s.replace('<item name="colorAccent">@color/colorAccent</item>\n',
                  '<item name="colorAccent">@color/colorAccent</item>\n' + bars, 1)
    s = s.replace('<item name="android:background">@null</item>\n',
                  '<item name="android:background">@null</item>\n' + bars, 1)
    styles.write_text(s, encoding="utf-8")

    # 5. Capacitor config + web assets
    host_rule = ["*"] if config.get("external_links") == "inside" else []
    cap_config = {
        "appId": pkg,
        "appName": config["app_name"],
        "webDir": "www",
        "backgroundColor": config["status_bar_color"],
        "server": {"url": url, "cleartext": is_http, "allowNavigation": host_rule},
        "android": {"allowMixedContent": is_http},
    }
    assets = main / "assets"
    (assets / "public").mkdir(parents=True, exist_ok=True)
    (assets / "capacitor.config.json").write_text(json.dumps(cap_config, indent=2), encoding="utf-8")
    index = assets / "public" / "index.html"
    if not index.exists():
        index.write_text('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body></body></html>', encoding="utf-8")

    # 6. Launcher icons (uploaded icon is deleted right after use)
    source = Path(icon_path) if icon_path and Path(icon_path).exists() else DEFAULT_ICON_PATH
    for d in res.glob("mipmap-*"):
        for f in d.glob("ic_launcher*.png"):
            f.unlink()
    process_and_generate_icons(source, res)
    if icon_path:
        cleanup_uploaded_icon(icon_path, build_id)

    # 7. local.properties
    sdk = find_android_sdk()
    if sdk:
        (android_dir / "local.properties").write_text(
            "sdk.dir=" + str(sdk).replace("\\", "\\\\") + "\n", encoding="utf-8")
    return build_dir


# ----------------------------------------------------------------- build
def _set(build_id, status, progress, step, message, **extra):
    update_build_record(build_id, status=status, progress=progress, step=step, message=message, **extra)


def _gradle_error(log_lines):
    text = "\n".join(log_lines)
    m = re.search(r"\* What went wrong:\n(.+?)(?:\n\* |\Z)", text, re.S)
    if m:
        return m.group(1).strip()[:600]
    return "Gradle build failed:\n" + "\n".join(log_lines[-10:])[:600]


def run_gradle(build_id, build_dir):
    android_dir = build_dir / "android"
    jh = find_java_home()
    sdk = find_android_sdk()
    env = os.environ.copy()
    if jh:
        env["JAVA_HOME"] = str(jh)
        env["PATH"] = str(jh / "bin") + os.pathsep + env.get("PATH", "")
    if sdk:
        env["ANDROID_HOME"] = env["ANDROID_SDK_ROOT"] = str(sdk)
    wrapper = ["cmd", "/c", "gradlew.bat"] if IS_WINDOWS else ["sh", "gradlew"]
    cmd = wrapper + ["assembleRelease", "--no-daemon", "--console=plain", "--max-workers=2",
                     "-Dorg.gradle.jvmargs=" + os.environ.get("GRADLE_JVM_ARGS", "-Xmx1200m")]
    proc = subprocess.Popen(cmd, cwd=str(android_dir), env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, errors="replace")
    timer = threading.Timer(GRADLE_TIMEOUT, proc.kill)
    timer.start()
    tail, tasks, progress = [], 0, 45
    log = open(build_dir / "build.log", "w", encoding="utf-8")
    try:
        for line in proc.stdout:
            log.write(line)
            line = line.rstrip()
            if line:
                tail.append(line)
                tail = tail[-80:]
            if line.startswith("> Task :"):
                tasks += 1
                progress = min(84, 45 + tasks // 2)
                if tasks % 5 == 0:
                    _set(build_id, "building", progress, "building", "Compiling Android application...")
        proc.wait()
    finally:
        timer.cancel()
        log.close()
    if proc.returncode != 0:
        raise RuntimeError(_gradle_error(tail))
    apk = android_dir / "app" / "build" / "outputs" / "apk" / "release" / "app-release.apk"
    if not apk.exists():
        found = list((android_dir / "app" / "build" / "outputs" / "apk" / "release").glob("*.apk"))
        if not found:
            raise RuntimeError("Build finished but no APK was produced.")
        apk = found[0]
    return apk


def verify_apk(apk):
    apksigner = get_apksigner_path()
    if not apksigner:
        return False
    cmd = ([apksigner] if not IS_WINDOWS else ["cmd", "/c", apksigner]) + ["verify", str(apk)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError("APK signature verification failed: " + (r.stderr or r.stdout)[:300])
    return True


def cleanup_old_builds(max_age_seconds=6 * 3600):
    now = time.time()
    for d in BUILDS_DIR.iterdir():
        try:
            if d.is_dir() and not d.name.startswith("test_") and now - d.stat().st_mtime > max_age_seconds:
                shutil.rmtree(d, ignore_errors=True)
                with _records_lock:
                    build_records.pop(d.name, None)
        except OSError:
            pass


def build_worker(build_id):
    rec = get_build_record(build_id)
    if not rec:
        return
    config = rec.get("config") or {}
    icon_path = rec.get("icon_path")
    build_dir = BUILDS_DIR / build_id
    _set(build_id, "queued", 2, "queued", "Waiting in build queue...")
    with BUILD_SEMAPHORE:
        try:
            _set(build_id, "building", 10, "validating", "Validating environment...")
            env = environment_info()
            if not env["is_configured"]:
                raise RuntimeError("Server is missing JDK or Android SDK.")
            _set(build_id, "building", 20, "preparing", "Preparing Android template...")
            ensure_template_synced()
            _set(build_id, "building", 30, "configuring", "Configuring app, icon and permissions...")
            prepare_build(build_id, config, icon_path)
            _set(build_id, "building", 45, "building", "Compiling Android application...")
            apk = run_gradle(build_id, build_dir)
            _set(build_id, "building", 90, "signing", "Signing release APK...")
            _set(build_id, "building", 94, "verifying", "Verifying APK signature...")
            verify_apk(apk)
            out_dir = build_dir / "output"
            out_dir.mkdir(exist_ok=True)
            safe = re.sub(r"[^A-Za-z0-9]+", "_", config["app_name"]).strip("_") or "app"
            final = out_dir / f"{safe}-{config['version_name']}-release.apk"
            shutil.copyfile(apk, final)
            shutil.rmtree(build_dir / "android", ignore_errors=True)
            shutil.rmtree(build_dir / "node_modules", ignore_errors=True)
            token = rec.get("build_token", "")
            update_build_record(
                build_id, status="completed", progress=100, step="completed", message="Release APK ready",
                variant="release", signed=True, apk_filename=final.name, apk_path=str(final),
                apk_size_mb=round(final.stat().st_size / 1048576, 2),
                download_url=f"/api/download/{build_id}?token={token}", error=None)
        except Exception as exc:  # noqa: BLE001
            cleanup_uploaded_icon(icon_path, build_id)
            shutil.rmtree(build_dir / "android", ignore_errors=True)
            shutil.rmtree(build_dir / "node_modules", ignore_errors=True)
            update_build_record(build_id, status="failed", step="failed", message="Build failed", error=str(exc)[:800])


def start_build_async(build_id):
    threading.Thread(target=lambda: build_worker(build_id), daemon=True).start()
