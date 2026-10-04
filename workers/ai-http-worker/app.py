import os
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

MODE = os.environ["AI_WORKER_MODE"]
BACKEND = os.environ.get("AI_BACKEND_URL", "").rstrip("/")
HEALTH_URL = os.environ.get("AI_BACKEND_HEALTH_URL", "")
TIMEOUT = float(os.environ.get("AI_WORKER_TIMEOUT_SECONDS", "20"))
MAX_IMAGE_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
MAX_BYTES = (MAX_IMAGE_BYTES * 3 // 2) + 1024
ROUTES = {
    "remove-background": "/api/remove",
    "upscale": "/api/upscale",
    "auto-alt-text": "/api/alt-text",
    "nsfw-check": "/api/nsfw-check",
}

if MODE not in ROUTES:
    raise RuntimeError("Unsupported AI_WORKER_MODE")
for endpoint_name, endpoint in (("AI_BACKEND_URL", BACKEND), ("AI_BACKEND_HEALTH_URL", HEALTH_URL)):
    if endpoint:
        parsed_endpoint = urlparse(endpoint)
        if parsed_endpoint.scheme not in ("http", "https") or not parsed_endpoint.netloc:
            raise RuntimeError(f"{endpoint_name} must use HTTP or HTTPS")
        if parsed_endpoint.username or parsed_endpoint.password:
            raise RuntimeError(f"{endpoint_name} must not contain credentials")
if TIMEOUT <= 0 or MAX_IMAGE_BYTES <= 0:
    raise RuntimeError("Worker timeout and image size limit must be positive")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health():
    if not BACKEND:
        raise HTTPException(status_code=503, detail="Model backend is not configured")
    target = HEALTH_URL or f"{BACKEND}/health"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(target)
        if response.status_code < 200 or response.status_code >= 300:
            raise HTTPException(status_code=503, detail="Model backend is unhealthy")
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Model backend is unavailable") from error
    return {"status": "ok"}


@app.post(ROUTES[MODE])
async def infer(request: Request):
    if not BACKEND:
        raise HTTPException(status_code=503, detail="Model backend is not configured")
    length = request.headers.get("content-length")
    if length and int(length) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Input exceeds size limit")
    body_parts = []
    body_size = 0
    async for part in request.stream():
        body_size += len(part)
        if body_size > MAX_BYTES:
            raise HTTPException(status_code=413, detail="Input exceeds size limit")
        body_parts.append(part)
    body = b"".join(body_parts)
    target = f"{BACKEND}{ROUTES[MODE]}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
            async with client.stream(
                "POST",
                target,
                content=body,
                headers={"content-type": request.headers.get("content-type", "application/octet-stream")},
            ) as upstream:
                if upstream.status_code >= 400:
                    raise HTTPException(status_code=503, detail="Model backend failed")
                chunks = []
                size = 0
                async for chunk in upstream.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(status_code=413, detail="Output exceeds size limit")
                    chunks.append(chunk)
                return Response(
                    content=b"".join(chunks),
                    media_type=upstream.headers.get("content-type", "application/octet-stream"),
                )
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Model backend is unavailable") from error
