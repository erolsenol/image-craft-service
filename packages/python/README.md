# image-craft-client (Python)

Install the SDK from PyPI:

```sh
pip install image-craft-client
```

```python
from image_craft_client import CraftClient

craft = CraftClient("https://images.example.com")
url = craft.image("https://example.com/photo.jpg").resize(800).format("webp").url()
signed = craft.image("https://example.com/photo.jpg").resize(800).format("webp").signed_url(
    "shared-signing-secret", expires_in_seconds=3600
)
```

The Python SDK and generated JavaScript API types use the checked-in `openapi/openapi.json` document. It uses only Python's standard library.
