import json
import os
import sys
import warnings
from pathlib import Path
from statistics import mean

warnings.filterwarnings("ignore")


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def clean_text(value):
    return " ".join(str(value or "").replace("\x00", " ").split())


def add_line(lines, value):
    text = clean_text(value)
    if text:
        lines.append(text)


def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return str(value).lower() in {"1", "true", "yes", "on"}


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except Exception:
        return default


def env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except Exception:
        return default


def env_json(name, default):
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def env_list(name, default):
    raw = os.environ.get(name)
    if not raw:
        return default
    values = [item.strip() for item in raw.replace("\n", ";").split(";") if item.strip()]
    return values or default


def safe_bbox(value):
    if not value:
        return None
    try:
        items = list(value)
        if len(items) != 4:
            return None
        return [round(float(item), 2) for item in items]
    except Exception:
        return None


def parse_with_pdfplumber(path):
    import pdfplumber

    lines = []
    row_tables = []
    structured_tables = []
    audit = {
        "engine": "pdfplumber",
        "pages": [],
        "tableCount": 0,
        "coordinateTraceCount": 0,
        "visualPreviews": [],
        "warnings": [],
    }
    table_settings = env_json("PARSER_PDFPLUMBER_TABLE_SETTINGS", {})
    save_visuals = env_bool("PARSER_SAVE_VISUAL_DEBUG_IMAGES", False)
    visual_limit = env_int("PARSER_VISUAL_DEBUG_LIMIT", 3)
    coordinate_limit = env_int("PARSER_COORDINATE_TRACE_LIMIT", 160)
    preview_dir = Path(os.environ.get("PARSER_PREVIEW_DIR", "exports/parse-previews"))
    preview_dir.mkdir(parents=True, exist_ok=True)
    pdf_stem = Path(path).stem

    with pdfplumber.open(path) as pdf:
        for page_index, page in enumerate(pdf.pages, start=1):
            page_audit = {
                "page": page_index,
                "width": round(float(page.width), 2),
                "height": round(float(page.height), 2),
                "tableBboxes": [],
                "wordSample": [],
            }
            text = page.extract_text(layout=True) or page.extract_text() or ""
            for line in text.splitlines():
                add_line(lines, line)

            words = page.extract_words() or []
            for word in words[: min(coordinate_limit, len(words))]:
                page_audit["wordSample"].append(
                    {
                        "text": clean_text(word.get("text")),
                        "bbox": safe_bbox([word.get("x0"), word.get("top"), word.get("x1"), word.get("bottom")]),
                    }
                )

            finder_tables = []
            try:
                finder_tables = page.find_tables(table_settings=table_settings or None) or []
            except TypeError:
                finder_tables = page.find_tables() or []
            except Exception as exc:
                audit["warnings"].append(f"PDFPLUMBER_TABLE_FINDER_FAILED_PAGE_{page_index}:{exc}")

            for table_index, found_table in enumerate(finder_tables, start=1):
                bbox = safe_bbox(getattr(found_table, "bbox", None))
                page_audit["tableBboxes"].append(bbox)
                try:
                    extracted = found_table.extract() or []
                except Exception:
                    extracted = []
                rows = []
                for row in extracted:
                    cells = [clean_text(cell) for cell in (row or [])]
                    if any(cells):
                        row_text = " | ".join([cell for cell in cells if cell])
                        rows.append(cells)
                        row_tables.append(
                            {
                                "engine": "pdfplumber",
                                "page": page_index,
                                "table": table_index,
                                "bbox": bbox,
                                "row": row_text,
                            }
                        )
                        add_line(lines, row_text)
                structured_tables.append(
                    {
                        "engine": "pdfplumber",
                        "page": page_index,
                        "table": table_index,
                        "bbox": bbox,
                        "rowCount": len(rows),
                        "columnCount": max([len(row) for row in rows], default=0),
                        "rows": rows,
                        "sourceTrace": {
                            "page": page_index,
                            "bbox": bbox,
                            "strategy": "page.find_tables",
                        },
                    }
                )

            if save_visuals and len(audit["visualPreviews"]) < visual_limit:
                try:
                    image_path = preview_dir / f"{pdf_stem}-page-{page_index}-tablefinder.png"
                    page.to_image(resolution=120).debug_tablefinder(table_settings or {}).save(str(image_path))
                    audit["visualPreviews"].append(
                        {
                            "page": page_index,
                            "type": "pdfplumber_debug_tablefinder",
                            "path": str(image_path),
                        }
                    )
                except Exception as exc:
                    audit["warnings"].append(f"PDFPLUMBER_VISUAL_PREVIEW_FAILED_PAGE_{page_index}:{exc}")

            audit["pages"].append(page_audit)

    audit["tableCount"] = len(structured_tables)
    audit["coordinateTraceCount"] = sum(len(page["wordSample"]) for page in audit["pages"])
    if audit["tableCount"] == 0:
        audit["warnings"].append("PDFPLUMBER_NO_TABLES")
    return lines, row_tables, structured_tables, audit


def camelot_kwargs_for_attempt(attempt):
    kwargs = {"pages": "all"}
    flavor = attempt.get("flavor")
    if flavor and flavor != "auto":
        kwargs["flavor"] = flavor
    if attempt.get("table_areas"):
        kwargs["table_areas"] = attempt["table_areas"]
    if attempt.get("table_regions"):
        kwargs["table_regions"] = attempt["table_regions"]
    return kwargs


def build_camelot_attempts():
    flavors = env_list("PARSER_CAMELOT_FLAVORS", ["lattice", "stream"])
    areas = env_list("PARSER_CAMELOT_TABLE_AREAS", [])
    regions = env_list("PARSER_CAMELOT_TABLE_REGIONS", [])
    attempts = []
    for flavor in flavors:
        attempts.append({"flavor": flavor, "label": f"{flavor}:default"})
        if areas:
            attempts.append({"flavor": flavor, "table_areas": areas, "label": f"{flavor}:areas"})
        if regions:
            attempts.append({"flavor": flavor, "table_regions": regions, "label": f"{flavor}:regions"})
    return attempts


def parse_with_camelot(path):
    import camelot

    lines = []
    row_tables = []
    structured_tables = []
    seen = set()
    min_accuracy = env_float("PARSER_CAMELOT_MIN_ACCURACY", env_float("PARSER_TABLE_CONFIDENCE", 0.75) * 100)
    retry_low_accuracy = env_bool("PARSER_CAMELOT_RETRY_LOW_ACCURACY", True)
    attempts = build_camelot_attempts()
    audit = {
        "engine": "camelot",
        "minAccuracy": min_accuracy,
        "attempts": [],
        "tableCount": 0,
        "lowConfidenceTables": [],
        "warnings": [],
    }

    for attempt_index, attempt in enumerate(attempts, start=1):
        parsed_count = 0
        accepted_count = 0
        low_count = 0
        try:
            parsed_tables = camelot.read_pdf(path, **camelot_kwargs_for_attempt(attempt))
        except Exception as exc:
            audit["attempts"].append(
                {
                    "attempt": attempt_index,
                    "label": attempt.get("label"),
                    "status": "failed",
                    "error": str(exc),
                    "params": attempt,
                }
            )
            continue

        for table_index, table in enumerate(parsed_tables, start=1):
            parsed_count += 1
            report = getattr(table, "parsing_report", {}) or {}
            accuracy = float(report.get("accuracy") or 0)
            whitespace = float(report.get("whitespace") or 0)
            page = report.get("page") or "?"
            bbox = safe_bbox(getattr(table, "_bbox", None))
            rows = []
            for _, row in table.df.iterrows():
                cells = [clean_text(cell) for cell in row.tolist()]
                if not any(cells):
                    continue
                row_text = " | ".join([cell for cell in cells if cell])
                key = (page, row_text)
                if key in seen:
                    continue
                seen.add(key)
                rows.append(cells)
                row_tables.append(
                    {
                        "engine": "camelot",
                        "page": page,
                        "table": table_index,
                        "accuracy": accuracy,
                        "whitespace": whitespace,
                        "bbox": bbox,
                        "attempt": attempt.get("label"),
                        "row": row_text,
                    }
                )
                add_line(lines, row_text)

            low_confidence = accuracy < min_accuracy
            if low_confidence:
                low_count += 1
                audit["lowConfidenceTables"].append(
                    {
                        "page": page,
                        "table": table_index,
                        "accuracy": accuracy,
                        "attempt": attempt.get("label"),
                        "bbox": bbox,
                    }
                )

            if rows:
                accepted_count += 1
                structured_tables.append(
                    {
                        "engine": "camelot",
                        "page": page,
                        "table": table_index,
                        "accuracy": accuracy,
                        "whitespace": whitespace,
                        "bbox": bbox,
                        "rowCount": len(rows),
                        "columnCount": max([len(row) for row in rows], default=0),
                        "rows": rows,
                        "sourceTrace": {
                            "page": page,
                            "bbox": bbox,
                            "strategy": attempt.get("label"),
                            "parsingReport": report,
                        },
                    }
                )

        audit["attempts"].append(
            {
                "attempt": attempt_index,
                "label": attempt.get("label"),
                "status": "ok",
                "parsedTableCount": parsed_count,
                "acceptedTableCount": accepted_count,
                "lowConfidenceTableCount": low_count,
                "params": attempt,
            }
        )
        if accepted_count and (not retry_low_accuracy or low_count == 0):
            break

    audit["tableCount"] = len(structured_tables)
    if audit["tableCount"] == 0:
        audit["warnings"].append("CAMELOT_NO_TABLES")
    if audit["lowConfidenceTables"]:
        audit["warnings"].append("CAMELOT_LOW_CONFIDENCE_TABLES")
    return lines, row_tables, structured_tables, audit


def parse_with_docling(path):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        PdfPipelineOptions,
        RapidOcrOptions,
        TableStructureOptions,
    )
    from docling.document_converter import DocumentConverter, PdfFormatOption

    force_full_page_ocr = os.environ.get("PARSER_FORCE_FULL_PAGE_OCR") == "1"
    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = True
    pipeline_options.do_table_structure = True
    pipeline_options.table_structure_options = TableStructureOptions(do_cell_matching=True)
    pipeline_options.ocr_options = RapidOcrOptions(force_full_page_ocr=force_full_page_ocr)
    pipeline_options.generate_page_images = False

    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)})
    result = converter.convert(path)
    document = result.document
    markdown = document.export_to_markdown()
    lines = []
    for line in markdown.splitlines():
        add_line(lines, line)

    tables = []
    for table_index, table in enumerate(getattr(document, "tables", []) or [], start=1):
        try:
            dataframe = table.export_to_dataframe(doc=document)
            rows = [
                [clean_text(cell) for cell in row if clean_text(cell)]
                for row in dataframe.astype(str).values.tolist()
            ]
            rows = [row for row in rows if row]
            for row in rows:
                add_line(lines, " | ".join(row))
            tables.append(
                {
                    "engine": "docling",
                    "table": table_index,
                    "rows": rows,
                    "rowCount": len(rows),
                    "columnCount": int(len(dataframe.columns)),
                    "columns": [clean_text(column) for column in dataframe.columns.tolist()],
                    "html": table.export_to_html(doc=document),
                    "sourceTrace": {"strategy": "docling_table_structure"},
                }
            )
        except Exception as exc:
            tables.append({"engine": "docling", "table": table_index, "error": str(exc)})

    return lines, tables, build_docling_audit(result, markdown)


def build_docling_audit(result, markdown):
    document = result.document
    pages = []
    page_map = getattr(result, "pages", {}) or {}
    if isinstance(page_map, dict):
        iterable_pages = page_map.items()
    else:
        iterable_pages = enumerate(page_map, start=1)

    for page_no, page in iterable_pages:
        cells = getattr(page, "cells", []) or []
        cell_text_lengths = [len(clean_text(getattr(cell, "text", ""))) for cell in cells]
        predictions = getattr(page, "predictions", None)
        layout = getattr(predictions, "layout", None) if predictions else None
        clusters = getattr(layout, "clusters", []) or []
        pages.append(
            {
                "page": int(page_no) if str(page_no).isdigit() else page_no,
                "textCellCount": len(cells),
                "avgCellTextLength": round(mean(cell_text_lengths), 2) if cell_text_lengths else 0,
                "layoutClusterCount": len(clusters),
                "hasLayoutPrediction": bool(layout),
            }
        )

    table_count = len(getattr(document, "tables", []) or [])
    text_count = len(getattr(document, "texts", []) or [])
    picture_count = len(getattr(document, "pictures", []) or [])
    page_count = len(pages)
    text_chars = len(clean_text(markdown))
    warnings_list = []
    if page_count and text_chars / page_count < env_int("PARSER_SCAN_MIN_TEXT_CHARS", 80):
        warnings_list.append("LOW_TEXT_DENSITY")
    if table_count == 0:
        warnings_list.append("NO_STRUCTURED_TABLES")

    return {
        "engine": "docling",
        "pageCount": page_count,
        "textChars": text_chars,
        "textItemCount": text_count,
        "tableCount": table_count,
        "pictureCount": picture_count,
        "pages": pages,
        "warnings": warnings_list,
    }


def merge_audits(audits):
    warnings_list = []
    visual_previews = []
    pages = []
    for audit in audits:
        warnings_list.extend(audit.get("warnings", []) or [])
        visual_previews.extend(audit.get("visualPreviews", []) or [])
        if audit.get("pages"):
            pages.append({"engine": audit.get("engine"), "pages": audit.get("pages")})
    return {
        "engine": "+".join([audit.get("engine") for audit in audits if audit.get("engine")]),
        "tableCount": sum(int(audit.get("tableCount") or 0) for audit in audits),
        "warnings": sorted(set(warnings_list)),
        "visualPreviews": visual_previews,
        "parserAudits": audits,
        "pageEvidence": pages,
    }


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "missing file path"})
        return 2

    path = sys.argv[1]
    ocr_enabled = os.environ.get("PARSER_OCR_ENABLED") == "1"
    deep_layout = os.environ.get("PARSER_DEEP_LAYOUT") == "1"
    docling_mode = os.environ.get("PARSER_DOCLING_MODE", "auto")
    lines = []
    tables = []
    structured_tables = []
    audits = []
    engines = []
    errors = []

    try:
        pdfplumber_lines, pdfplumber_tables, pdfplumber_structured, pdfplumber_audit = parse_with_pdfplumber(path)
        audits.append(pdfplumber_audit)
        if pdfplumber_lines:
            engines.append("pdfplumber")
            lines.extend(pdfplumber_lines)
            tables.extend(pdfplumber_tables)
            structured_tables.extend(pdfplumber_structured)
    except Exception as exc:
        errors.append({"engine": "pdfplumber", "message": str(exc)})

    try:
        camelot_lines, camelot_tables, camelot_structured, camelot_audit = parse_with_camelot(path)
        audits.append(camelot_audit)
        if camelot_lines:
            engines.append("camelot")
            lines.extend(camelot_lines)
            tables.extend(camelot_tables)
            structured_tables.extend(camelot_structured)
    except Exception as exc:
        errors.append({"engine": "camelot", "message": str(exc)})

    should_try_docling = docling_mode == "always" or deep_layout or ocr_enabled or len(" ".join(lines)) < 120
    if should_try_docling:
        try:
            docling_lines, docling_tables, docling_audit = parse_with_docling(path)
            audits.append(docling_audit)
            if docling_lines:
                engines.append("docling")
                lines.extend(docling_lines)
            if docling_tables:
                structured_tables.extend(docling_tables)
        except Exception as exc:
            errors.append({"engine": "docling", "message": str(exc)})

    deduped = []
    seen = set()
    for line in lines:
        if line not in seen:
            deduped.append(line)
            seen.add(line)

    layout_audit = merge_audits(audits)
    if errors:
        layout_audit["errors"] = errors

    emit(
        {
            "ok": bool(deduped),
            "engine": "+".join(engines),
            "lines": deduped,
            "tables": tables,
            "structuredTables": structured_tables,
            "layoutAudit": layout_audit,
            "errors": errors,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
