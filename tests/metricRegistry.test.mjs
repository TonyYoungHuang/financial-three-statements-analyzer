import assert from "node:assert/strict";
import { enrichMetric, listMetricRegistryKeys, METRIC_REGISTRY } from "../server/metricRegistry.js";

const expectedKeys = [
  "gross_margin",
  "net_margin",
  "operating_margin",
  "cost_ratio",
  "return_on_assets",
  "return_on_equity",
  "operating_expense_ratio",
  "selling_expense_ratio",
  "admin_expense_ratio",
  "finance_expense_ratio",
  "tax_burden",
  "ocf_to_net_profit",
  "cash_conversion_quality",
  "ocf_margin",
  "cash_return_on_assets",
  "reinvestment_coverage",
  "free_cash_flow_proxy",
  "financing_cash_flow",
  "debt_to_asset",
  "debt_to_equity",
  "current_ratio",
  "quick_ratio",
  "cash_ratio",
  "interest_coverage",
  "equity_ratio",
  "cash_to_assets",
  "current_assets_to_assets",
  "receivables_to_revenue",
  "inventory_to_revenue",
  "asset_turnover",
  "receivables_turnover",
  "receivables_days",
  "inventory_turnover",
  "inventory_days",
  "payables_to_cost",
  "revenue_growth",
  "gross_profit_growth",
  "net_profit_growth",
  "ocf_growth",
  "total_assets_growth",
  "equity_growth",
  "liabilities_growth",
];

const actualKeys = listMetricRegistryKeys();
assert.deepEqual([...actualKeys].sort(), [...expectedKeys].sort(), "metric registry should cover all production metrics");

for (const key of actualKeys) {
  const entry = METRIC_REGISTRY[key];
  assert.ok(entry.formulaId, `${key} should have formulaId`);
  assert.ok(entry.formula, `${key} should have formula`);
  assert.ok(Array.isArray(entry.inputs), `${key} should define formula inputs`);
  assert.ok(entry.exceptionPolicy.includes("denominator"), `${key} should document denominator/blank handling`);
}

const enriched = enrichMetric(
  { key: "gross_margin", value: 0.32, displayValue: "32.0%", status: "success" },
  { grossMargin: [0.18, 0.35] },
);
assert.equal(enriched.formulaCategory, "profitability");
assert.deepEqual(enriched.benchmarkRange, [0.18, 0.35]);

const unknown = enrichMetric({ key: "custom_metric", value: 1 });
assert.equal(unknown.formulaId, "unregistered_custom_metric");

console.log(`metric registry ok: ${actualKeys.length} metrics`);
