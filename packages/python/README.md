# image-craft-client (Python)

Install the SDK from PyPI:

```sh
pip install image-craft-client
```

## Quick Start

```python
import os
from image_craft_client import CraftClient

# Keep the signing secret in an environment variable
signing_secret = os.environ["IMAGE_CRAFT_SIGNING_SECRET"]

craft = CraftClient("https://images.example.com")

# Build an unsigned transform URL
url = craft.image("https://example.com/photo.jpg").resize(800).format("webp").url()

# Build a signed transform URL
# expires_in_seconds computes an expiration timestamp relative to current time
signed_url = (
    craft.image("https://example.com/photo.jpg")
    .resize(800)
    .format("webp")
    .signed_url(signing_secret, expires_in_seconds=3600)
)
```

### Options for `signed_url()`

- `secret`: The shared HMAC signing secret configured on the service.
- `expires_in_seconds`: Duration in seconds from now until the URL expires (e.g., `3600` for 1 hour).
- `expires_at`: Absolute Unix timestamp (seconds since epoch) when the URL expires. Cannot be set together with `expires_in_seconds`.

The Python SDK and generated JavaScript API types use the checked-in `openapi/openapi.json` document. It uses only Python's standard library.
