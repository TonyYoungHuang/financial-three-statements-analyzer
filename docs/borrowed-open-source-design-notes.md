# Open-source reference notes

This project does not copy code from the referenced projects. The following ideas are adapted as product and architecture patterns.

## Document parsing layer

- Docling: use as the future heavy parser for scanned PDFs, OCR, reading order, page-level source tracking, and table structure extraction.
- Camelot / pdfplumber: use as future lightweight Python engines for text-based PDF table extraction before falling back to OCR.
- Current implementation status: Node now calls `server/python_pdf_parser.py` before falling back to `pdfjs-dist`. The Python bridge tries `pdfplumber` and Camelot for electronic PDFs, then Docling when OCR is enabled or the PDF has too little extractable text. Install `requirements-parser.txt` on the production server before enabling this path for customer traffic.
- Docling zip integration status: after reviewing the local `github-xiangmu/docling-main.zip`, the project now persists `parseAudit` and `structuredTables` on every uploaded statement file. `parseAudit` records page count, text density, layout cluster count, table count, and warnings such as low text density or missing structured tables. `structuredTables` stores reconstructed table rows from pdfplumber, Camelot, and Docling table exports.
- Batch scanned-file verification: run `python scripts/scanned_pdf_batch_audit.py --input-dir <folder> --output exports/scanned-pdf-batch-audit.json`. By default it uses Docling's `tests/data_scanned` sample directory when the zip has been extracted.

Recommended production parser route:

1. Try native text/table extraction for electronic PDFs.
2. Keep page number, source text, confidence, and table position for every mapped statement item.
3. If the PDF has no useful text layer or table confidence is low, route to OCR/table-structure extraction.
4. Always let the user confirm values before scoring.

## Financial indicators

- FinanceToolkit / OpenBB: borrow the idea of transparent ratio categories and formula-first presentation.
- Current implementation status: metrics now return formula text and learning notes. The metric registry has been expanded from the original 16 indicators to 30+ indicators, including ROA, ROE, current ratio, quick ratio, receivables turnover, inventory turnover, interest coverage, and cash conversion quality.

## Period comparison

- OpenBB-style financial workflow: compare statement values across periods before interpreting ratios.
- Current implementation status: result data now includes `periodComparisons` for revenue, profit, operating cash flow, cash, receivables, inventory, assets, liabilities, and equity. The result page and PDF report include a dedicated two-period comparison section.

## AI report generation

- FinRobot-style pattern: split the task into modules and require structured JSON from the model instead of free-form text.
- Current implementation status: DeepSeek is called through the OpenAI-compatible `/chat/completions` API when `ai_settings.enabled` is true and an API key is configured. The model receives only confirmed statements, calculated metrics, period comparisons, risks, and context; original PDFs are never sent.
- DeepSeek output schema:

```json
{
  "summary": "",
  "profitabilityAnalysis": "",
  "cashFlowAnalysis": "",
  "periodComparisonAnalysis": "",
  "riskExplanation": [],
  "nextCheckSuggestions": [],
  "scoreAdjustment": 0,
  "scoreAdjustmentReason": ""
}
```

Production rule: AI receives only confirmed structured statements, calculated metrics, period comparisons, risk items, industry, standard, currency, and disclaimers. It must not receive original PDFs.
