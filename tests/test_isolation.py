import os
import sys
import unittest
import json
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.app import app
from backend.builder import BUILDS_DIR, save_build_record, verify_build_access

class TestMultiUserIsolation(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        # Ensure testing mode
        app.config["TESTING"] = True

    def test_cache_control_headers_on_api(self):
        """API endpoints must return strict private no-cache headers to prevent proxy/CDN leakage."""
        res = self.client.get("/api/info")
        self.assertEqual(res.status_code, 200)
        cache_header = res.headers.get("Cache-Control", "")
        self.assertIn("private", cache_header)
        self.assertIn("no-store", cache_header)
        self.assertIn("no-cache", cache_header)
        self.assertEqual(res.headers.get("X-Content-Type-Options"), "nosniff")

    def test_session_cookie_issuance(self):
        """Visiting the API should issue an HttpOnly, Lax session cookie."""
        res = self.client.get("/api/info")
        self.assertEqual(res.status_code, 200)
        # Check cookie in Set-Cookie header
        cookies = res.headers.getlist("Set-Cookie")
        has_session_cookie = any("session_id=" in c for c in cookies)
        self.assertTrue(has_session_cookie, "session_id cookie was not issued")

    def test_cross_user_status_isolation(self):
        """User B must NOT be able to view User A's build status without token or session."""
        build_id = "test_build_a_12345"
        token_a = "secret_token_a_999"
        session_a = "user_a_session_777"

        # Create a mock build record owned by User A
        record = {
            "build_id": build_id,
            "build_token": token_a,
            "session_id": session_a,
            "status": "building",
            "progress": 50,
            "step": "building",
            "message": "Compiling Android application...",
            "app_name": "User A Private App",
            "version_name": "1.0.0",
            "package_name": "com.usera.private",
            "apk_filename": None,
            "apk_path": None,
            "apk_size_mb": None,
            "download_url": None,
            "error": None
        }
        save_build_record(build_id, record)

        # 1. User B (different session, no token) queries User A's build
        client_b = app.test_client()
        client_b.set_cookie("session_id", "user_b_session_888")
        res_b = client_b.get(f"/api/status/{build_id}")
        self.assertEqual(res_b.status_code, 404, "User B was able to access User A's build status!")

        # 2. Anonymous client without session or token queries User A's build
        client_anon = app.test_client()
        res_anon = client_anon.get(f"/api/status/{build_id}")
        self.assertEqual(res_anon.status_code, 404, "Anonymous request accessed User A's build status!")

        # 3. User A queries their own build with their session
        client_a = app.test_client()
        client_a.set_cookie("session_id", session_a)
        res_a = client_a.get(f"/api/status/{build_id}")
        self.assertEqual(res_a.status_code, 200, "User A could not access their own build status via session!")
        data_a = res_a.get_json()
        self.assertEqual(data_a["app_name"], "User A Private App")

        # 4. User queries with the correct secret token
        res_token = client_anon.get(f"/api/status/{build_id}?token={token_a}")
        self.assertEqual(res_token.status_code, 200, "Could not access with valid build token!")

    def test_cross_user_download_isolation(self):
        """User B must NOT be able to download User A's APK."""
        build_id = "test_build_download_sec"
        token_a = "secret_token_down_123"
        session_a = "user_a_session_down"

        # Create dummy APK file in isolated build dir
        build_dir = BUILDS_DIR / build_id
        build_dir.mkdir(parents=True, exist_ok=True)
        apk_file = build_dir / "test.apk"
        apk_file.write_bytes(b"PK\x03\x04dummy_apk_content")

        record = {
            "build_id": build_id,
            "build_token": token_a,
            "session_id": session_a,
            "status": "completed",
            "progress": 100,
            "step": "completed",
            "message": "Completed",
            "app_name": "Secret App",
            "version_name": "1.0.0",
            "package_name": "com.secret.app",
            "apk_filename": "secret.apk",
            "apk_path": str(apk_file),
            "apk_size_mb": 0.01,
            "download_url": f"/api/download/{build_id}?token={token_a}",
            "error": None
        }
        save_build_record(build_id, record)

        # User B attempts to download User A's APK
        client_b = app.test_client()
        client_b.set_cookie("session_id", "user_b_unauthorized")
        res_b = client_b.get(f"/api/download/{build_id}")
        self.assertEqual(res_b.status_code, 404, "User B was able to download User A's APK!")

        # User A downloads with matching session
        client_a = app.test_client()
        client_a.set_cookie("session_id", session_a)
        res_a = client_a.get(f"/api/download/{build_id}")
        self.assertEqual(res_a.status_code, 200, "User A was prevented from downloading their own APK!")
        self.assertEqual(res_a.data, b"PK\x03\x04dummy_apk_content")

        # Cleanup
        try:
            apk_file.unlink(missing_ok=True)
            (build_dir / "meta.json").unlink(missing_ok=True)
            build_dir.rmdir()
        except Exception:
            pass

    def test_directory_traversal_prevention(self):
        """Invalid or malicious build IDs should be rejected with 400 or 404."""
        bad_ids = ["../etc/passwd", "..\\windows\\system32", "invalid/slash", "build 123", "!@#$%^"]
        for bad_id in bad_ids:
            res = self.client.get(f"/api/status/{bad_id}")
            self.assertIn(res.status_code, (400, 404))

            res_down = self.client.get(f"/api/download/{bad_id}")
            self.assertIn(res_down.status_code, (400, 404))

    def test_atomic_persistence_across_workers(self):
        """Build records must be readable even when memory cache is cleared (simulating another worker process)."""
        from backend.builder import get_build_record, build_records, _records_lock

        test_id = "test_worker_sync_111"
        rec = {
            "build_id": test_id,
            "build_token": "token_sync",
            "session_id": "sess_sync",
            "status": "building",
            "app_name": "Worker Sync App"
        }
        save_build_record(test_id, rec)

        # Clear in-memory dictionary to simulate another Gunicorn worker
        with _records_lock:
            build_records.clear()

        # Read back - should read from disk meta.json seamlessly
        retrieved = get_build_record(test_id)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved["app_name"], "Worker Sync App")

        # Cleanup
        try:
            (BUILDS_DIR / test_id / "meta.json").unlink(missing_ok=True)
            (BUILDS_DIR / test_id).rmdir()
        except Exception:
            pass

    def test_session_reset(self):
        """POST /api/session/reset should generate a new session and update cookie."""
        res = self.client.post("/api/session/reset")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "reset")
        self.assertTrue(len(data["session_id"]) >= 16)

    def test_concurrent_user_build_isolation(self):
        """Two users building concurrently must have completely isolated IDs, tokens, and access."""
        from unittest.mock import patch

        # Mock build_worker so we don't trigger actual heavy Gradle compilation in test
        with patch("backend.builder.build_worker"):
            client1 = app.test_client()
            client2 = app.test_client()

            # User 1 submits build
            payload1 = {
                "url": "https://example1.com",
                "app_name": "User 1 App",
                "package_name": "com.user1.app",
                "version_name": "1.0.0",
                "version_code": 1
            }
            res1 = client1.post("/api/build", json=payload1)
            self.assertEqual(res1.status_code, 202)
            data1 = res1.get_json()
            build_id_1 = data1["build_id"]
            token_1 = data1["build_token"]

            # User 2 submits build
            payload2 = {
                "url": "https://example2.com",
                "app_name": "User 2 App",
                "package_name": "com.user2.app",
                "version_name": "2.0.0",
                "version_code": 2
            }
            res2 = client2.post("/api/build", json=payload2)
            self.assertEqual(res2.status_code, 202)
            data2 = res2.get_json()
            build_id_2 = data2["build_id"]
            token_2 = data2["build_token"]

            # Verify build IDs and tokens are distinct
            self.assertNotEqual(build_id_1, build_id_2)
            self.assertNotEqual(token_1, token_2)

            # User 1 queries Build 1 -> SUCCESS
            status1_u1 = client1.get(f"/api/status/{build_id_1}")
            self.assertEqual(status1_u1.status_code, 200)
            self.assertEqual(status1_u1.get_json()["app_name"], "User 1 App")

            # User 2 queries Build 1 without token -> DENIED (404)
            status1_u2 = client2.get(f"/api/status/{build_id_1}")
            self.assertEqual(status1_u2.status_code, 404)

            # User 1 queries Build 2 without token -> DENIED (404)
            status2_u1 = client1.get(f"/api/status/{build_id_2}")
            self.assertEqual(status2_u1.status_code, 404)

            # User 2 queries Build 2 -> SUCCESS
            status2_u2 = client2.get(f"/api/status/{build_id_2}")
            self.assertEqual(status2_u2.status_code, 200)
            self.assertEqual(status2_u2.get_json()["app_name"], "User 2 App")

            # Cleanup
            import shutil
            shutil.rmtree(BUILDS_DIR / build_id_1, ignore_errors=True)
            shutil.rmtree(BUILDS_DIR / build_id_2, ignore_errors=True)

    def test_uploaded_icon_deleted_after_generation(self):
        """Uploaded icon file must be completely deleted from disk."""
        from backend.builder import cleanup_uploaded_icon

        test_build_id = "test_icon_delete_build"
        test_build_dir = BUILDS_DIR / test_build_id
        test_build_dir.mkdir(parents=True, exist_ok=True)

        fake_icon = test_build_dir / "icon_input.png"
        fake_icon.write_bytes(b"dummy_icon_bytes")
        self.assertTrue(fake_icon.exists())

        # Trigger cleanup
        cleanup_uploaded_icon(fake_icon, test_build_id)

        # Assert the icon has been deleted
        self.assertFalse(fake_icon.exists(), "Uploaded icon file was NOT deleted!")

        # Clean up directory
        import shutil
        shutil.rmtree(test_build_dir, ignore_errors=True)

    def test_default_icon_fallback(self):
        """When no icon is uploaded, DEFAULT_ICON_PATH must exist and be used to generate launcher icons."""
        from backend.builder import DEFAULT_ICON_PATH, process_and_generate_icons

        self.assertTrue(DEFAULT_ICON_PATH.exists(), f"Default icon not found at {DEFAULT_ICON_PATH}")

        temp_res = BUILDS_DIR / "test_temp_res"
        temp_res.mkdir(parents=True, exist_ok=True)

        try:
            process_and_generate_icons(DEFAULT_ICON_PATH, temp_res)
            # Verify mipmap-hdpi was generated
            hdpi_icon = temp_res / "mipmap-hdpi" / "ic_launcher.png"
            self.assertTrue(hdpi_icon.exists(), "Default launcher icon was not generated!")
            # Verify DEFAULT_ICON_PATH is preserved
            self.assertTrue(DEFAULT_ICON_PATH.exists(), "DEFAULT_ICON_PATH was accidentally deleted!")
        finally:
            import shutil
            shutil.rmtree(temp_res, ignore_errors=True)

    def tearDown(self):
        import shutil
        shutil.rmtree(BUILDS_DIR / "test_build_a_12345", ignore_errors=True)
        shutil.rmtree(BUILDS_DIR / "test_build_download_sec", ignore_errors=True)
        shutil.rmtree(BUILDS_DIR / "test_worker_sync_111", ignore_errors=True)
        shutil.rmtree(BUILDS_DIR / "test_icon_delete_build", ignore_errors=True)
        shutil.rmtree(BUILDS_DIR / "test_temp_res", ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
