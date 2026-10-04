"""Small URL-building client for image-craft-service."""

from __future__ import annotations

import hashlib
import hmac
import time
from urllib.parse import quote, urlsplit, urlunsplit

from ._openapi import REMOTE_IMAGE_ROUTE


class ImageBuilder:
    def __init__(self, base_url: str, source: str) -> None:
        source = _normalize(source)
        self._base_url = base_url.rstrip("/")
        self.source = source
        self._width: int | None = None
        self._height: int | None = None
        self._format: str | None = None
        self._quality: int | None = None
        self._fit: str | None = None

    def resize(self, width: int, height: int | None = None, fit: str | None = None) -> ImageBuilder:
        if width <= 0 or (height is not None and height <= 0):
            raise ValueError("dimensions must be positive integers")
        self._width, self._height, self._fit = width, height, fit
        return self

    def format(self, image_format: str, quality: int | None = None) -> ImageBuilder:
        if image_format not in {"jpeg", "png", "webp", "avif", "auto"}:
            raise ValueError("unsupported image format")
        if quality is not None and not 1 <= quality <= 100:
            raise ValueError("quality must be from 1 to 100")
        self._format, self._quality = image_format, quality
        return self

    def _ops(self) -> str:
        tokens: list[str] = []
        if self._width is not None:
            tokens.append(f"w_{self._width}")
        if self._height is not None:
            tokens.append(f"h_{self._height}")
        if self._fit is not None:
            tokens.append(f"fit_{self._fit}")
        if self._format is not None:
            tokens.append(f"f_{self._format}")
        if self._quality is not None:
            tokens.append(f"q_{self._quality}")
        if not tokens:
            raise ValueError("at least one transform operation is required")
        return ",".join(tokens)

    def url(self) -> str:
        route = REMOTE_IMAGE_ROUTE.replace("{ops}", self._ops()).replace(
            "{*}", quote(_normalize(self.source), safe="")
        )
        return f"{self._base_url}{route}"

    def signed_url(
        self,
        secret: str,
        *,
        expires_in_seconds: int | None = None,
        expires_at: int | None = None,
    ) -> str:
        if expires_in_seconds is not None and expires_at is not None:
            raise ValueError("set expires_in_seconds or expires_at, not both")
        expiry = expires_at
        if expires_in_seconds is not None:
            if expires_in_seconds <= 0:
                raise ValueError("expires_in_seconds must be positive")
            expiry = int(time.time()) + expires_in_seconds
        if expiry is not None and not 0 < expiry <= 9_007_199_254_740_991:
            raise ValueError("expires_at must be a positive Unix timestamp")
        ops = self._ops()
        canonical_ops = _canonicalize_ops(ops)
        canonical_expiry = str(expiry) if expiry is not None else ""
        payload = (
            f"/v1/img/{canonical_ops}/{_normalize(self.source)}\n{canonical_expiry}"
        ).encode()
        signature = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
        url = (
            f"{self._base_url}/v1/img/{signature}/{ops}/"
            f"{quote(_normalize(self.source), safe='')}"
        )
        if expiry is not None:
            url += f"?expires={expiry}"
        return url


class CraftClient:
    def __init__(self, base_url: str = "http://localhost:3000") -> None:
        self.base_url = base_url.rstrip("/")

    def image(self, source: str) -> ImageBuilder:
        return ImageBuilder(self.base_url, source)


def _normalize(source: str) -> str:
    parsed = urlsplit(source)
    if (
        parsed.scheme.lower() not in ("http", "https")
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("source must be a credential-free HTTP(S) URL")
    host = parsed.hostname.lower() if parsed.hostname else ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = host
    if parsed.port is not None and not (
        parsed.scheme.lower() == "https" and parsed.port == 443
    ) and not (parsed.scheme.lower() == "http" and parsed.port == 80):
        netloc = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, ""))


def _canonicalize_ops(ops: str) -> str:
    categories = {
        "w": "resize",
        "h": "resize",
        "fit": "resize",
        "strategy": "resize",
        "fx": "resize",
        "fy": "resize",
        "f": "format",
        "q": "format",
    }
    groups: dict[str, list[str]] = {}
    order: list[str] = []
    for token in ops.split(","):
        key = token.split("_", maxsplit=1)[0]
        category = categories.get(key, key)
        if category not in groups:
            groups[category] = []
            order.append(category)
        groups[category].append(token)
    return ",".join(token for category in order for token in sorted(groups[category]))


__all__ = ["CraftClient", "ImageBuilder"]
