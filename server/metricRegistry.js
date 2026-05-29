export const METRIC_REGISTRY = {
  gross_margin: entry("profitability", "gross_profit / revenue", ["gross_profit", "revenue"], "grossMargin"),
  net_margin: entry("profitability", "net_profit / revenue", ["net_profit", "revenue"], "netMargin"),
  operating_margin: entry("profitability", "operating_profit / revenue", ["operating_profit", "revenue"]),
  cost_ratio: entry("profitability", "cost_of_sales / revenue", ["cost_of_sales", "revenue"], null, "lower_is_better"),
  return_on_assets: entry("profitability", "net_profit / average_total_assets", ["net_profit", "total_assets"]),
  return_on_equity: entry("profitability", "net_profit / average_total_equity", ["net_profit", "total_equity"]),
  operating_expense_ratio: entry(
    "profitability",
    "(selling_expenses + administrative_expenses + finance_expenses) / revenue",
    ["selling_expenses", "administrative_expenses", "finance_expenses", "revenue"],
    null,
    "lower_is_better",
  ),
  selling_expense_ratio: entry("profitability", "selling_expenses / revenue", ["selling_expenses", "revenue"], null, "lower_is_better"),
  admin_expense_ratio: entry("profitability", "administrative_expenses / revenue", ["administrative_expenses", "revenue"], null, "lower_is_better"),
  finance_expense_ratio: entry("solvency", "finance_expenses / revenue", ["finance_expenses", "revenue"], null, "lower_is_better"),
  tax_burden: entry("profitability", "income_tax / total_profit", ["income_tax", "total_profit"], null, "range"),
  ocf_to_net_profit: entry("cash_flow_quality", "net_operating_cash_flow / net_profit", ["net_operating_cash_flow", "net_profit"], "operatingCashFlowToNetProfit"),
  cash_conversion_quality: entry("cash_flow_quality", "net_operating_cash_flow / operating_profit", ["net_operating_cash_flow", "operating_profit"]),
  ocf_margin: entry("cash_flow_quality", "net_operating_cash_flow / revenue", ["net_operating_cash_flow", "revenue"]),
  cash_return_on_assets: entry("cash_flow_quality", "net_operating_cash_flow / average_total_assets", ["net_operating_cash_flow", "total_assets"]),
  reinvestment_coverage: entry("cash_flow_quality", "net_operating_cash_flow / abs(net_investing_cash_flow)", ["net_operating_cash_flow", "net_investing_cash_flow"]),
  free_cash_flow_proxy: entry("cash_flow_quality", "net_operating_cash_flow + net_investing_cash_flow", ["net_operating_cash_flow", "net_investing_cash_flow"], null, "positive_amount"),
  financing_cash_flow: entry("cash_flow_quality", "net_financing_cash_flow", ["net_financing_cash_flow"], null, "contextual_amount"),
  debt_to_asset: entry("solvency", "total_liabilities / total_assets", ["total_liabilities", "total_assets"], null, "lower_is_better"),
  debt_to_equity: entry("solvency", "total_liabilities / total_equity", ["total_liabilities", "total_equity"], null, "lower_is_better"),
  current_ratio: entry("solvency", "total_current_assets / total_current_liabilities", ["total_current_assets", "total_current_liabilities"]),
  quick_ratio: entry("solvency", "(total_current_assets - inventory) / total_current_liabilities", ["total_current_assets", "inventory", "total_current_liabilities"]),
  cash_ratio: entry("solvency", "cash / total_current_liabilities", ["cash", "total_current_liabilities"]),
  interest_coverage: entry("solvency", "operating_profit / finance_expenses", ["operating_profit", "finance_expenses"]),
  equity_ratio: entry("financial_structure", "total_equity / total_assets", ["total_equity", "total_assets"]),
  cash_to_assets: entry("solvency", "cash / total_assets", ["cash", "total_assets"]),
  current_assets_to_assets: entry("financial_structure", "total_current_assets / total_assets", ["total_current_assets", "total_assets"], null, "range"),
  receivables_to_revenue: entry("operating_efficiency", "accounts_receivable / revenue", ["accounts_receivable", "revenue"], null, "lower_is_better"),
  inventory_to_revenue: entry("operating_efficiency", "inventory / revenue", ["inventory", "revenue"], null, "lower_is_better"),
  asset_turnover: entry("operating_efficiency", "revenue / average_total_assets", ["revenue", "total_assets"]),
  receivables_turnover: entry("operating_efficiency", "revenue / average_accounts_receivable", ["revenue", "accounts_receivable"]),
  receivables_days: entry("operating_efficiency", "365 / receivables_turnover", ["receivables_turnover"], null, "lower_is_better"),
  inventory_turnover: entry("operating_efficiency", "cost_of_sales / average_inventory", ["cost_of_sales", "inventory"]),
  inventory_days: entry("operating_efficiency", "365 / inventory_turnover", ["inventory_turnover"], null, "lower_is_better"),
  payables_to_cost: entry("operating_efficiency", "accounts_payable / cost_of_sales", ["accounts_payable", "cost_of_sales"], null, "range"),
  revenue_growth: entry("growth", "current_revenue / previous_revenue - 1", ["revenue.current", "revenue.previous"], null, "growth"),
  gross_profit_growth: entry("growth", "current_gross_profit / previous_gross_profit - 1", ["gross_profit.current", "gross_profit.previous"], null, "growth"),
  net_profit_growth: entry("growth", "current_net_profit / previous_net_profit - 1", ["net_profit.current", "net_profit.previous"], null, "growth"),
  ocf_growth: entry("growth", "current_net_operating_cash_flow / previous_net_operating_cash_flow - 1", ["net_operating_cash_flow.current", "net_operating_cash_flow.previous"], null, "growth"),
  total_assets_growth: entry("growth", "current_total_assets / previous_total_assets - 1", ["total_assets.current", "total_assets.previous"], null, "growth"),
  equity_growth: entry("growth", "current_total_equity / previous_total_equity - 1", ["total_equity.current", "total_equity.previous"], null, "growth"),
  liabilities_growth: entry("growth", "current_total_liabilities / previous_total_liabilities - 1", ["total_liabilities.current", "total_liabilities.previous"], null, "growth"),
};

export const DEFAULT_INDUSTRY_BENCHMARKS = {
  default: {
    grossMargin: [0.18, 0.35],
    netMargin: [0.04, 0.12],
    operatingCashFlowToNetProfit: [0.7, 1.2],
    returnOnAssets: [0.03, 0.08],
    returnOnEquity: [0.06, 0.15],
    currentRatio: [1.2, 2],
    quickRatio: [0.8, 1.2],
    receivablesTurnover: [4, 8],
    inventoryTurnover: [3, 6],
    interestCoverage: [2, 5],
  },
  manufacturing: {
    grossMargin: [0.18, 0.35],
    netMargin: [0.04, 0.12],
    operatingCashFlowToNetProfit: [0.7, 1.3],
    inventoryTurnover: [3, 6],
    receivablesTurnover: [4, 8],
  },
  software: {
    grossMargin: [0.3, 0.55],
    netMargin: [0.08, 0.22],
    operatingCashFlowToNetProfit: [0.8, 1.5],
    currentRatio: [1.5, 3],
    returnOnEquity: [0.08, 0.18],
  },
  retail: {
    grossMargin: [0.15, 0.35],
    netMargin: [0.02, 0.08],
    operatingCashFlowToNetProfit: [0.8, 1.4],
    inventoryTurnover: [5, 10],
  },
};

function entry(category, formula, inputs, benchmarkKey = null, polarity = "higher_is_better") {
  return {
    category,
    formulaId: formula.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
    formula,
    inputs,
    benchmarkKey,
    polarity,
    exceptionPolicy:
      "If any required input is blank or the denominator is zero, return null and mark the metric as data-insufficient instead of forcing a zero.",
  };
}

export function enrichMetric(metric, benchmarkValues = {}) {
  const registry = METRIC_REGISTRY[metric.key];
  if (!registry) {
    return {
      ...metric,
      formulaId: `unregistered_${metric.key}`,
      formulaInputs: [],
      exceptionPolicy: "Unregistered metric. Treat as review-required.",
    };
  }
  return {
    ...metric,
    formulaId: registry.formulaId,
    formulaInputs: registry.inputs,
    formulaCategory: registry.category,
    formulaPolarity: registry.polarity,
    exceptionPolicy: registry.exceptionPolicy,
    benchmarkKey: registry.benchmarkKey,
    benchmarkRange: registry.benchmarkKey ? benchmarkValues[registry.benchmarkKey] || null : null,
  };
}

export function listMetricRegistryKeys() {
  return Object.keys(METRIC_REGISTRY);
}
