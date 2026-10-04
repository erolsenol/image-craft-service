import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


def make_pdf(pages=1, page_width=72, page_height=72):
    children = "".join(f"{3 + index} 0 R " for index in range(pages))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{children}] /Count {pages} >>".encode(),
    ]
    for index in range(pages):
        content_id = 3 + pages + index
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_width} {page_height}] "
                f"/Resources << >> /Contents {content_id} 0 R >>"
            ).encode()
        )
    for _ in range(pages):
        objects.append(b"<< /Length 4 >>\nstream\nq Q\nendstream")

    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode())
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(
        (
            f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode()
    )
    return bytes(output)


class PdfRasterizerTests(unittest.TestCase):
    def test_renders_a_page_to_png(self):
        image = app.rasterize_pdf(make_pdf(), 1, 72)
        self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
        width, height = struct.unpack(">II", image[16:24])
        self.assertEqual((width, height), (72, 72))

    def test_renders_the_selected_page_and_rejects_missing_pages(self):
        document = make_pdf(pages=2, page_width=144)
        image = app.rasterize_pdf(document, 2, 72)
        width, height = struct.unpack(">II", image[16:24])
        self.assertEqual((width, height), (144, 72))
        with self.assertRaisesRegex(app.PdfFailure, "page does not exist"):
            app.rasterize_pdf(document, 3, 72)

    def test_rejects_malformed_pdf(self):
        with self.assertRaisesRegex(app.PdfFailure, "Invalid PDF"):
            app.rasterize_pdf(b"%PDF-1.4\nnot a real document", 1, 72)

    def test_rejects_pdf_over_page_limit(self):
        old_limit = app.MAX_PAGES
        app.MAX_PAGES = 2
        try:
            with self.assertRaisesRegex(app.PdfFailure, "page count exceeds"):
                app.rasterize_pdf(make_pdf(pages=3), 1, 72)
        finally:
            app.MAX_PAGES = old_limit

    def test_rejects_oversized_input_before_parsing(self):
        old_limit = app.MAX_INPUT_BYTES
        app.MAX_INPUT_BYTES = 12
        try:
            with self.assertRaisesRegex(app.PdfFailure, "input size limit"):
                app.rasterize_pdf(make_pdf(), 1, 72)
        finally:
            app.MAX_INPUT_BYTES = old_limit

    def test_rejects_render_size_over_pixel_budget(self):
        old_limit = app.MAX_PIXELS
        app.MAX_PIXELS = 100
        try:
            with self.assertRaisesRegex(app.PdfFailure, "pixel limit"):
                app.rasterize_pdf(make_pdf(page_width=200), 1, 72)
        finally:
            app.MAX_PIXELS = old_limit


if __name__ == "__main__":
    unittest.main()
