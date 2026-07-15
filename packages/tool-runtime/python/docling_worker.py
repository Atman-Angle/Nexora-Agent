import hashlib
import json
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path

MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_PAGES = 200
MAX_SEGMENTS = 100
MAX_SEGMENT_CHARS = 1600
DOCUMENT_SUFFIXES = {".pdf", ".docx", ".pptx", ".xlsx", ".png", ".jpg", ".jpeg", ".tiff", ".bmp"}


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}), flush=True)
    raise SystemExit(1)


def main() -> None:
    try:
        request = json.loads(sys.stdin.readline())
        root = Path(request["workspaceRoot"]).resolve()
        files = request["files"]
        model_dir = Path(request["modelDir"]).resolve()
        if not isinstance(files, list) or not all(isinstance(path, str) for path in files):
            fail("files must be an array of workspace-relative paths")
        if not model_dir.is_dir():
            fail("preloaded Docling model directory was not found")
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        fail(f"invalid worker request: {error}")

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ.pop("HTTP_PROXY", None)
    os.environ.pop("HTTPS_PROXY", None)
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    options = PdfPipelineOptions(artifacts_path=model_dir, ocr_options=RapidOcrOptions(lang=["en"], backend="torch"))
    converter = DocumentConverter(format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=options),
        InputFormat.IMAGE: ImageFormatOption(pipeline_options=options)
    })
    segments = []
    read_bytes = 0
    truncated = False
    for relative_path in files:
        candidate = (root / relative_path).resolve()
        if root not in candidate.parents or candidate.suffix.lower() not in DOCUMENT_SUFFIXES:
            fail("document path escapes the workspace or has an unsupported type")
        if not candidate.is_file():
            fail("document file was not found")
        size = candidate.stat().st_size
        if size > MAX_FILE_BYTES:
            truncated = True
            continue
        read_bytes += size
        with redirect_stdout(sys.stderr):
            result = converter.convert(candidate)
        if len(result.document.pages) > MAX_PAGES:
            truncated = True
            continue
        index = 0
        document_segments = 0
        for item, _ in result.document.iterate_items():
            text = getattr(item, "text", "").strip()
            if not text:
                continue
            index += 1
            provenance = getattr(item, "prov", [])
            page = getattr(provenance[0], "page_no", None) if provenance else None
            segments.append({"path": relative_path.replace("\\", "/"), "mime": result.document.origin.mimetype, "text": text[:MAX_SEGMENT_CHARS], "location": f"page={page}" if page else f"paragraph={index}", "contentHash": hashlib.sha256(text.encode()).hexdigest()})
            document_segments += 1
            if len(segments) >= MAX_SEGMENTS:
                print(json.dumps({"ok": True, "segments": segments, "readBytes": read_bytes, "truncated": True}), flush=True)
                return
        if document_segments == 0:
            text = result.document.export_to_markdown().strip()
            if text:
                segments.append({"path": relative_path.replace("\\", "/"), "mime": result.document.origin.mimetype, "text": text[:MAX_SEGMENT_CHARS], "location": "document", "contentHash": hashlib.sha256(text.encode()).hexdigest()})
    print(json.dumps({"ok": True, "segments": segments, "readBytes": read_bytes, "truncated": truncated}), flush=True)


if __name__ == "__main__":
    main()
