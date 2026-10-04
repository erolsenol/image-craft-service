import unittest
import sys
from pathlib import Path
import hashlib
import hmac
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from image_craft_client import CraftClient


class ClientTests(unittest.TestCase):
    def test_builder_matches_compact_openapi_route(self):
        url = CraftClient("https://images.example.com/").image(
            "https://example.com/photo.jpg"
        ).resize(800).format("webp").url()
        self.assertEqual(
            url,
            "https://images.example.com/v1/img/w_800,f_webp/https%3A%2F%2Fexample.com%2Fphoto.jpg",
        )

    def test_signed_url_has_expiry_and_sha256_signature(self):
        url = CraftClient().image("https://example.com/p.jpg").resize(800).signed_url(
            "secret", expires_at=2_000_000_000
        )
        query = parse_qs(urlsplit(url).query)
        route = urlsplit(url).path.split("/")
        self.assertEqual(query["expires"], ["2000000000"])
        expected_signature = hmac.new(
            b"secret",
            b"/v1/img/w_800/https://example.com/p.jpg\n2000000000",
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(route[3], expected_signature)
        self.assertEqual(route[4], "w_800")
        self.assertEqual(route[5], "https%3A%2F%2Fexample.com%2Fp.jpg")
        self.assertNotIn("sig", query)

    def test_signed_url_with_expires_in_seconds(self):
        url = (
            CraftClient("https://images.example.com")
            .image("https://example.com/photo.jpg")
            .resize(800)
            .format("webp")
            .signed_url("secret", expires_in_seconds=3600)
        )
        query = parse_qs(urlsplit(url).query)
        self.assertIn("expires", query)
        self.assertIn("sig", query)
        self.assertTrue(int(query["expires"][0]) > 0)


if __name__ == "__main__":
    unittest.main()
