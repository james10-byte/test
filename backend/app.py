"""Web-to-APK Builder: Flask server + REST API."""
import os
import re
import secrets
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, g, jsonify, request, send_file, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:  # python-dotenv is optional at runtime
    pass

from backend import builder  # noqa: E402

ROOT = builder.ROOT
FRONTEND_DIR = ROOT / "frontend"

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
PACKAGE_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
VERSION_NAME_RE = re.compile(r"^[0-9A-Za-z._-]{1,30}$")
ALLOWED_PERMISSIONS = set(builder.PERMISSION_XML)
JAVA_KEYWORDS = {
    "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue",
    "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "goto", "if",
    "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "package", "private",
    "protected", "public", "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
    "throw", "throws", "transient", "try", "void", "volatile", "while", "true", "false", "null",
}
MAX_QUEUE = int(os.environ.get("MAX_QUEUE", "10"))


# ---------------------------------------------------------------- session
@app.before_request
def _ensure_session():
    sid = request.cookies.get("session_id", "")
    if SESSION_RE.match(sid):
        g.session_id, g.new_session = sid, False
    else:
        g.session_id, g.new_session = secrets.token_urlsafe(24), True


def _set_cookie(resp, sid):
    resp.set_cookie("session_id", sid, httponly=True, samesite="Lax",
                    secure=request.is_secure, max_age=60 * 60 * 24 * 7, path="/")


@app.after_request
def _secure_headers(resp):
    if getattr(g, "new_session", False):
        _set_cookie(resp, g.session_id)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "private, no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


# --------------------------------------------------------------- helpers
def _bool(v, default=True):
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "on", "yes")


def _slug_package(app_name):
    clean = re.sub(r"[^a-z0-9]", "", (app_name or "").lower())
    if not clean:
        clean = "mywebsite"
    elif not clean[0].isalpha():
        clean = "app" + clean
    return f"com.webtoapk.{clean}"


def _read_payload():
    if request.is_json:
        data = request.get_json(silent=True) or {}
        perms = data.get("permissions") or []
        if isinstance(perms, str):
            perms = [perms]
        return data, list(perms)
    return request.form, request.form.getlist("permissions")


def validate_config(data, perms):
    errors, cfg = [], {}

    url = (data.get("url") or "").strip()
    if url and not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    parsed = urlparse(url)
    if not url or parsed.scheme not in ("http", "https") or not parsed.netloc or len(url) > 2048:
        errors.append("Please enter a valid website URL (http:// or https://).")
    cfg["url"] = url

    name = (data.get("app_name") or "").strip()
    if not name or len(name) > 50:
        errors.append("App name is required (max 50 characters).")
    cfg["app_name"] = name

    pkg = (data.get("package_name") or "").strip().lower() or _slug_package(name)
    if (not PACKAGE_RE.match(pkg) or len(pkg) > 150
            or any(part in JAVA_KEYWORDS for part in pkg.split("."))):
        errors.append("Invalid package name. Use a format like com.company.app (lowercase letters, digits, underscores).")
    cfg["package_name"] = pkg

    vname = (data.get("version_name") or "1.0.0").strip()
    if not VERSION_NAME_RE.match(vname):
        errors.append("Invalid version name.")
    cfg["version_name"] = vname

    try:
        vcode = int(data.get("version_code") or 1)
        if not 1 <= vcode <= 2100000000:
            raise ValueError
    except (TypeError, ValueError):
        errors.append("Version code must be a positive integer.")
        vcode = 1
    cfg["version_code"] = vcode

    for key, default in (("primary_color", "#8B5CF6"), ("status_bar_color", "#09090B"), ("nav_bar_color", "#09090B")):
        val = (data.get(key) or default).strip()
        if not HEX_RE.match(val):
            errors.append(f"Invalid color for {key}.")
            val = default
        cfg[key] = val

    clean_perms = ["internet"]
    for p in perms:
        if p in ALLOWED_PERMISSIONS and p not in clean_perms:
            clean_perms.append(p)
    cfg["permissions"] = clean_perms

    for feature in ("javascript", "dom_storage", "file_upload", "downloads", "fullscreen", "back_navigation"):
        cfg[feature] = _bool(data.get(feature), True)
    links = (data.get("external_links") or "browser").strip().lower()
    cfg["external_links"] = links if links in ("inside", "browser") else "browser"
    cfg["description"] = (data.get("description") or "")[:300]
    return cfg, errors


# ------------------------------------------------------------------ pages
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    if filename.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(FRONTEND_DIR, filename)


# -------------------------------------------------------------------- API
@app.route("/api/info")
def api_info():
    info = builder.environment_info()
    info["status"] = "ok"
    return jsonify(info)


@app.route("/api/session/reset", methods=["POST"])
def api_session_reset():
    sid = secrets.token_urlsafe(24)
    g.new_session = False
    resp = jsonify({"status": "reset", "session_id": sid})
    _set_cookie(resp, sid)
    return resp


@app.route("/api/validate", methods=["POST"])
def api_validate():
    data, perms = _read_payload()
    cfg, errors = validate_config(data, perms)
    return jsonify({"valid": not errors, "details": errors,
                    "url": cfg["url"], "package_name": cfg["package_name"],
                    "suggested_package": _slug_package(cfg["app_name"])}), (400 if errors else 200)


def _active_builds(session_id=None):
    n = 0
    now = time.time()
    with builder._records_lock:
        for rec in builder.build_records.values():
            if rec.get("status") in ("queued", "building") and now - rec.get("created_at", now) < 3600:
                if session_id is None or rec.get("session_id") == session_id:
                    n += 1
    return n


@app.route("/api/build", methods=["POST"])
def api_build():
    data, perms = _read_payload()
    cfg, errors = validate_config(data, perms)

    icon_file = request.files.get("icon") if not request.is_json else None
    icon_bytes, icon_ext = None, None
    if icon_file and icon_file.filename:
        from PIL import Image, UnidentifiedImageError
        try:
            icon_file.stream.seek(0)
            with Image.open(icon_file.stream) as im:
                fmt = (im.format or "").upper()
                im.verify()
            if fmt not in ("PNG", "JPEG", "WEBP"):
                raise UnidentifiedImageError("unsupported")
            icon_ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[fmt]
            icon_file.stream.seek(0)
            icon_bytes = icon_file.stream.read()
        except Exception:  # noqa: BLE001
            errors.append("Icon must be a valid PNG, JPG or WebP image.")

    if errors:
        return jsonify({"error": "Validation failed", "details": errors}), 400
    if _active_builds() >= MAX_QUEUE:
        return jsonify({"error": "Server is busy, please try again in a few minutes."}), 429
    if _active_builds(g.session_id) >= 2:
        return jsonify({"error": "You already have builds in progress. Please wait for them to finish."}), 429

    builder.cleanup_old_builds()
    build_id = uuid.uuid4().hex[:16]
    token = secrets.token_urlsafe(24)
    build_dir = builder.BUILDS_DIR / build_id
    build_dir.mkdir(parents=True, exist_ok=True)
    icon_path = None
    if icon_bytes:
        icon_path = build_dir / f"icon_input.{icon_ext}"
        icon_path.write_bytes(icon_bytes)

    record = {
        "build_id": build_id, "build_token": token, "session_id": g.session_id,
        "status": "queued", "progress": 0, "step": "queued", "message": "Waiting in build queue...",
        "variant": "release", "signed": False, "created_at": time.time(),
        "app_name": cfg["app_name"], "version_name": cfg["version_name"], "package_name": cfg["package_name"],
        "apk_filename": None, "apk_path": None, "apk_size_mb": None, "download_url": None, "error": None,
        "config": cfg, "icon_path": str(icon_path) if icon_path else None,
    }
    builder.save_build_record(build_id, record)
    builder.start_build_async(build_id)
    return jsonify({"build_id": build_id, "build_token": token, "status": "queued"}), 202


def _bad_id(build_id):
    return not builder.BUILD_ID_RE.match(build_id or "")


@app.route("/api/status/<build_id>")
def api_status(build_id):
    if _bad_id(build_id):
        return jsonify({"error": "Invalid build id"}), 400
    rec = builder.verify_build_access(build_id, g.session_id, request.args.get("token"))
    if not rec:
        return jsonify({"error": "Build not found"}), 404
    return jsonify(builder.public_view(rec))


@app.route("/api/download/<build_id>")
def api_download(build_id):
    if _bad_id(build_id):
        return jsonify({"error": "Invalid build id"}), 400
    rec = builder.verify_build_access(build_id, g.session_id, request.args.get("token"))
    if not rec or rec.get("status") != "completed" and not rec.get("apk_path"):
        return jsonify({"error": "Build not found"}), 404
    apk = Path(rec.get("apk_path") or "").resolve()
    base = builder.BUILDS_DIR.resolve()
    if base not in apk.parents or not apk.is_file():
        return jsonify({"error": "File not found"}), 404
    return send_file(apk, mimetype="application/vnd.android.package-archive", as_attachment=True,
                     download_name=rec.get("apk_filename") or apk.name)


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "Upload too large (max 8 MB)."}), 413


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "Not found"}), 404


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
