import unittest
import sys
from pathlib import Path
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
        self.assertEqual(query["expires"], ["2000000000"])
        self.assertEqual(
            query["sig"][0],
            "c3b7fe610a6e6ca32e5306e37c4308a6fde70ec1d8b99af3d778e373eb0c5366",
        )


if __name__ == "__main__":
    unittest.main()
