import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from jev_client import ProviderError, read_api_key
from setup import install


class SetupTests(unittest.TestCase):
    def test_full_access_and_key_belong_to_the_new_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "test-profile"
            launcher = install(profile, Path("/example/T3"), Path("/example/entry.mjs"),
                               Path("/example/node"), Path("/example/python"), 8475,
                               True, "fixture-key-owned-by-the-installer")
            settings_path = profile / "userdata/settings.json"
            config_path = profile / "adapter/config.json"
            settings = json.loads(settings_path.read_text())
            self.assertEqual(settings["defaultRuntimeMode"], "full-access")
            self.assertEqual(settings["defaultModelSelection"]["instanceId"], "jev-auto")
            self.assertIn("T3CODE_PORT=8475", launcher.read_text())
            self.assertEqual(json.loads(config_path.read_text())["bridge"]["endpointOrigin"],
                             "http://127.0.0.1:8475")
            for path in (settings_path, config_path, launcher):
                self.assertNotIn("fixture-key-owned-by-the-installer", path.read_text())

            with patch.dict(os.environ, {"JEV_T3_CONFIG": str(config_path),
                                         "TYPESAFE_API_KEY": "unrelated-environment-key"}):
                self.assertEqual(read_api_key(), "fixture-key-owned-by-the-installer")
                key_path = profile / "adapter/typesafe.key"
                key_path.chmod(0o644)
                with self.assertRaisesRegex(ProviderError, "private"):
                    read_api_key()
                key_path.unlink()
                with self.assertRaisesRegex(ProviderError, "your own TypeSafe"):
                    read_api_key()

    def test_refuses_to_use_an_existing_unrelated_t3_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "existing-profile"
            settings = profile / "userdata/settings.json"
            settings.parent.mkdir(parents=True)
            settings.write_text('{"defaultRuntimeMode":"approval-required"}')
            with self.assertRaisesRegex(ValueError, "fresh Jev profile"):
                install(profile, Path("/example/T3"), Path("/example/entry.mjs"),
                        Path("/example/node"), Path("/example/python"), 8475,
                        True, "fixture-key")
            self.assertEqual(json.loads(settings.read_text())["defaultRuntimeMode"], "approval-required")


if __name__ == "__main__":
    unittest.main()
