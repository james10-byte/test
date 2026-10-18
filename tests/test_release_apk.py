import os
import sys
import unittest
import shutil
import re
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.app import app
from backend.builder import (
    BUILDS_DIR,
    get_keytool_path,
    get_apksigner_path,
    get_or_create_release_keystore,
    prepare_build,
    save_build_record
)

class TestReleaseAPKConfiguration(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        app.config["TESTING"] = True

    def test_keytool_and_apksigner_discovered(self):
        """Build environment must be able to locate keytool and apksigner binaries."""
        keytool_bin = get_keytool_path()
        self.assertTrue(bool(keytool_bin), "keytool executable could not be found.")
        self.assertTrue(Path(keytool_bin).exists(), f"keytool path does not exist: {keytool_bin}")

        apksigner_bin = get_apksigner_path()
        self.assertTrue(bool(apksigner_bin), "apksigner executable could not be found.")
        self.assertTrue(Path(apksigner_bin).exists(), f"apksigner path does not exist: {apksigner_bin}")

    def test_keystore_creation_and_reuse(self):
        """Release keystore must be generated with correct parameters and reused across builds."""
        info = get_or_create_release_keystore()
        keystore_path = Path(info["keystore_path"])
        self.assertTrue(keystore_path.exists(), f"Keystore was not created at {keystore_path}")
        self.assertTrue(keystore_path.stat().st_size > 0, "Keystore file is empty")
        self.assertEqual(info["alias"], "release")
        self.assertEqual(info["store_pass"], "release123")

        # Second call must reuse the exact same keystore
        info2 = get_or_create_release_keystore()
        self.assertEqual(info["keystore_path"], info2["keystore_path"])

    def test_prepare_build_injects_signing_config(self):
        """prepare_build must copy release.keystore and inject signingConfigs.release into app/build.gradle."""
        test_build_id = "test_release_gradle_prep"
        test_build_dir = BUILDS_DIR / test_build_id

        config = {
            "url": "https://example.com",
            "app_name": "Test Release App",
            "package_name": "com.webtoapk.testreleaseapp",
            "version_name": "1.0.0",
            "version_code": 1
        }

        try:
            prepare_build(test_build_id, config)

            # Verify release.keystore copied to app dir
            app_keystore = test_build_dir / "android" / "app" / "release.keystore"
            self.assertTrue(app_keystore.exists(), "release.keystore was not copied to app directory")

            # Verify app/build.gradle contains signing configuration
            app_build_gradle = test_build_dir / "android" / "app" / "build.gradle"
            content = app_build_gradle.read_text(encoding="utf-8")

            self.assertIn("signingConfigs {", content)
            self.assertIn("storeFile file('release.keystore')", content)
            self.assertIn("signingConfig signingConfigs.release", content)
            self.assertIn('namespace = "com.webtoapk.testreleaseapp"', content)
            self.assertIn('applicationId "com.webtoapk.testreleaseapp"', content)

        finally:
            shutil.rmtree(test_build_dir, ignore_errors=True)

    def test_api_status_exposes_release_variant(self):
        """GET /api/status/<build_id> must include variant='release' and signed=True/False."""
        test_build_id = "test_status_variant_check"
        session_id = "session_variant_123"

        record = {
            "build_id": test_build_id,
            "build_token": "token_variant",
            "session_id": session_id,
            "status": "completed",
            "progress": 100,
            "step": "completed",
            "message": "Release APK ready",
            "variant": "release",
            "signed": True,
            "app_name": "Variant App",
            "version_name": "1.2.3",
            "package_name": "com.variant.app",
            "apk_filename": "Variant_App-1.2.3-release.apk",
            "apk_path": str(BUILDS_DIR / test_build_id / "output" / "Variant_App-1.2.3-release.apk"),
            "apk_size_mb": 5.4,
            "download_url": f"/api/download/{test_build_id}",
            "error": None
        }
        save_build_record(test_build_id, record)

        client = app.test_client()
        client.set_cookie("session_id", session_id)
        res = client.get(f"/api/status/{test_build_id}")
        self.assertEqual(res.status_code, 200)

        data = res.get_json()
        self.assertEqual(data["variant"], "release")
        self.assertTrue(data["signed"])
        self.assertIn("release.apk", data["apk_filename"])

        # Cleanup
        shutil.rmtree(BUILDS_DIR / test_build_id, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
