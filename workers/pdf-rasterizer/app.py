#!/usr/bin/env python3
"""Minimal HTTP adapter around sandboxed Poppler PDF rasterization."""

from __future__ import annotations

import json
import math
import os
import re
import resource
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MAX_INPUT_BYTES = min(
    int(os.environ.get("MAX_UPLOAD_BYTES", 20 * 1024 * 1024)),
    128 * 1024 * 1024,
)
MAX_OUTPUT_BYTES = min(
    int(os.environ.get("PDF_MAX_OUTPUT_BYTES", 20 * 1024 * 1024)),
    128 * 1024 * 1024,
)
MAX_PAGES = min(int(os.environ.get("PDF_MAX_PAGES", 50)), 100)
MAX_DPI = min(int(os.environ.get("PDF_MAX_DPI", 200)), 300)
MAX_PIXELS = min(
    int(os.environ.get("PDF_MAX_PIXELS", 20_000_000)), 40_000_000
)
CPU_SECONDS = min(int(os.environ.get("PDF_CPU_SECONDS", 5)), 30)
MEMORY_BYTES = min(int(os.environ.get("PDF_MEMORY_MB", 512)), 1024) * 1024 * 1024
PROCESS_TIMEOUT_SECONDS = min(
    float(os.environ.get("PDF_PROCESS_TIMEOUT_SECONDS", 8)), 30
)
POPPLER_BIN_DIR = Path(shutil.which("pdfinfo") or "/usr/bin/pdfinfo").parent


class PdfFailure(Exception):
    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def _set_process_limits() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS + 1))
    # Darwin maps large shared libraries into virtual memory; deployment uses
    # the container cgroup for a hard memory ceiling on the complete process tree.
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    if hasattr(resource, "RLIMIT_NPROC"):
        resource.setrlimit(resource.RLIMIT_NPROC, (8, 8))


def _run_limited(
    args: list[str], *, capture_stdout: bool
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=PROCESS_TIMEOUT_SECONDS,
            preexec_fn=_set_process_limits,
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C"},
        )
    except subprocess.TimeoutExpired as error:
        raise PdfFailure("PDF processing timed out", 413) from error
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise PdfFailure("PDF processor is unavailable", 503) from error
    return result


def _pdf_page_count(info: bytes) -> int:
    match = re.search(rb"(?m)^Pages:\s+(\d+)\s*$", info)
    if match is None:
        raise PdfFailure("Invalid PDF document", 400)
    return int(match.group(1))


def _raise_if_resource_killed(result: subprocess.CompletedProcess[bytes]) -> None:
    if result.returncode in {
        -signal.SIGXCPU,
        -signal.SIGXFSZ,
        -signal.SIGKILL,
    }:
        raise PdfFailure("PDF processing exceeded a resource limit", 413)


def _page_size_points(info: bytes, page: int) -> tuple[float, float]:
    # pdfinfo -f/-l emits the selected page's MediaBox and page size.
    lines = info.decode("latin-1", errors="replace").splitlines()
    in_page = False
    for line in lines:
        if re.match(rf"^Page\s+{page}\s+size:", line):
            match = re.search(r"([0-9.]+)\s+x\s+([0-9.]+)\s+pts", line)
            if match:
                return float(match.group(1)), float(match.group(2))
            in_page = True
            continue
        if in_page:
            match = re.match(r"^\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts", line)
            if match:
                return float(match.group(1)), float(match.group(2))
    match = re.search(rb"(?m)^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts", info)
    if match:
        return float(match.group(1)), float(match.group(2))
    raise PdfFailure("Invalid PDF page dimensions", 400)


def rasterize_pdf(pdf: bytes, page: int, dpi: int) -> bytes:
    if len(pdf) > MAX_INPUT_BYTES:
        raise PdfFailure("PDF exceeds input size limit", 413)
    if pdf[:1024].find(b"%PDF-") < 0:
        raise PdfFailure("Invalid PDF document", 400)
    if page < 1 or dpi < 36 or dpi > MAX_DPI:
        raise PdfFailure("Invalid page or DPI value", 400)

    with tempfile.TemporaryDirectory(prefix="pdf-job-") as temp_dir:
        os.chmod(temp_dir, 0o700)
        root = Path(temp_dir)
        source = root / "source.pdf"
        source.write_bytes(pdf)
        os.chmod(source, 0o600)

        info_result = _run_limited(
            [
                str(POPPLER_BIN_DIR / "pdfinfo"),
                "-f",
                str(page),
                "-l",
                str(page),
                str(source),
            ],
            capture_stdout=True,
        )
        _raise_if_resource_killed(info_result)
        if info_result.returncode != 0:
            document_info = _run_limited(
                [str(POPPLER_BIN_DIR / "pdfinfo"), str(source)],
                capture_stdout=True,
            )
            _raise_if_resource_killed(document_info)
            if document_info.returncode == 0:
                total_pages = _pdf_page_count(document_info.stdout)
                if total_pages > MAX_PAGES:
                    raise PdfFailure("PDF page count exceeds limit", 413)
                if page > total_pages:
                    raise PdfFailure("Requested PDF page does not exist", 400)
            raise PdfFailure("Invalid PDF document", 400)
        total_pages = _pdf_page_count(info_result.stdout)
        if total_pages > MAX_PAGES:
            raise PdfFailure("PDF page count exceeds limit", 413)
        if page > total_pages:
            raise PdfFailure("Requested PDF page does not exist", 400)

        width_points, height_points = _page_size_points(info_result.stdout, page)
        estimated_pixels = (
            math.ceil(width_points * dpi / 72)
            * math.ceil(height_points * dpi / 72)
        )
        if not math.isfinite(estimated_pixels) or estimated_pixels > MAX_PIXELS:
            raise PdfFailure("Rendered PDF page exceeds pixel limit", 413)

        prefix = root / "page"
        render_result = _run_limited(
            [
                str(POPPLER_BIN_DIR / "pdftoppm"),
                "-f",
                str(page),
                "-l",
                str(page),
                "-singlefile",
                "-png",
                "-r",
                str(dpi),
                str(source),
                str(prefix),
            ],
            capture_stdout=False,
        )
        _raise_if_resource_killed(render_result)
        output = root / "page.png"
        if render_result.returncode != 0 or not output.is_file():
            raise PdfFailure("PDF page could not be rendered", 400)
        if output.stat().st_size > MAX_OUTPUT_BYTES:
            raise PdfFailure("Rendered PDF page exceeds size limit", 413)
        return output.read_bytes()


class PdfHandler(BaseHTTPRequestHandler):
    server_version = "pdf-rasterizer"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(PROCESS_TIMEOUT_SECONDS + 2)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_response(204)
            self.end_headers()
            return
        self._send_error(404, "Not found")

    def do_POST(self) -> None:
        if self.path != "/render":
            self._send_error(404, "Not found")
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 1 or content_length > MAX_INPUT_BYTES:
                raise PdfFailure("PDF exceeds input size limit", 413)
            page = int(self.headers.get("X-PDF-Page", "1"))
            dpi = int(self.headers.get("X-PDF-DPI", "150"))
            pdf = self.rfile.read(content_length)
            if len(pdf) != content_length:
                raise PdfFailure("Incomplete PDF body", 400)
            image = rasterize_pdf(pdf, page, dpi)
        except PdfFailure as error:
            self._send_error(error.status, str(error))
            return
        except (ValueError, OverflowError):
            self._send_error(400, "Invalid page or DPI value")
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(image)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(image)

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send_error(self, status: int, message: str) -> None:
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    request_semaphore = threading.BoundedSemaphore(1)
    daemon_threads = True

    def process_request(self, request, client_address) -> None:
        if not self.request_semaphore.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_semaphore.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_semaphore.release()


if __name__ == "__main__":
    server = BoundedThreadingHTTPServer(("0.0.0.0", 8000), PdfHandler)
    server.serve_forever()
