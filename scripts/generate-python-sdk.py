"""Generate Python SDK route constants from the checked-in OpenAPI document."""

import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
document = json.loads((root / "openapi/openapi.json").read_text(encoding="utf-8"))
route = next(
    path for path in document["paths"] if path.startswith("/v1/img/")
)
target = root / "packages/python/image_craft_client/_openapi.py"
target.write_text(
    '"""Generated from openapi/openapi.json. Do not edit by hand."""\n\n'
    f'OPENAPI_VERSION = {document["info"]["version"]!r}\n'
    f'REMOTE_IMAGE_ROUTE = {route!r}\n',
    encoding="utf-8",
)
print(f"Generated {target.relative_to(root)} from OpenAPI {document['info']['version']}")
