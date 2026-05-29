import argparse
import json
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_DOCLING_SCANNED_DIR = (
    Path(__file__).resolve().parents[1]
    / "github-xiangmu"
    / "docling-main"
    / "docling-main"
    / "tests"
    / "data_scanned"
)


def collect_files(input_dir: Path):
    suffixes = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}
    return sorted(path for path in input_dir.rglob("*") if path.suffix.lower() in suffixes)


def run_parser(parser: Path, file_path: Path, timeout: int):
    start = time.time()
    completed = subprocess.run(
        [sys.executable, str(parser), str(file_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={
            **dict(**__import__("os").environ),
            "PARSER_OCR_ENABLED": "1",
            "PARSER_DEEP_LAYOUT": "1",
            "PARSER_DOCLING_MODE": "always",
            "PARSER_FORCE_FULL_PAGE_OCR": "1",
        },
    )
    elapsed = time.time() - start
    stdout = completed.stdout.strip()
    payload = {}
    try:
        payload = json.loads(stdout)
    except Exception:
        start_idx = stdout.find("{")
        end_idx = stdout.rfind("}")
        if start_idx >= 0 and end_idx > start_idx:
            payload = json.loads(stdout[start_idx : end_idx + 1])

    return {
        "file": str(file_path),
        "ok": completed.returncode == 0 and bool(payload.get("ok")),
        "seconds": round(elapsed, 2),
        "engine": payload.get("engine", ""),
        "lineCount": len(payload.get("lines", [])),
        "structuredTableCount": len(payload.get("structuredTables", [])),
        "layoutAudit": payload.get("layoutAudit", {}),
        "errors": payload.get("errors", []),
        "stderrTail": completed.stderr[-800:],
    }


def main():
    parser = argparse.ArgumentParser(description="Run scanned PDF/OCR batch audit through the project parser.")
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_DOCLING_SCANNED_DIR)
    parser.add_argument("--output", type=Path, default=Path("exports/scanned-pdf-batch-audit.json"))
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    parser_script = project_root / "server" / "python_pdf_parser.py"
    files = collect_files(args.input_dir)
    if args.limit > 0:
        files = files[: args.limit]

    results = []
    for file_path in files:
        print(f"auditing {file_path}")
        try:
            results.append(run_parser(parser_script, file_path, args.timeout))
        except subprocess.TimeoutExpired:
            results.append({"file": str(file_path), "ok": False, "errors": [{"engine": "batch", "message": "timeout"}]})
        except Exception as exc:
            results.append({"file": str(file_path), "ok": False, "errors": [{"engine": "batch", "message": str(exc)}]})

    ok_count = sum(1 for item in results if item.get("ok"))
    table_count = sum(item.get("structuredTableCount", 0) for item in results)
    summary = {
        "inputDir": str(args.input_dir),
        "fileCount": len(files),
        "okCount": ok_count,
        "failCount": len(files) - ok_count,
        "structuredTableCount": table_count,
        "results": results,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ["fileCount", "okCount", "failCount", "structuredTableCount"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
