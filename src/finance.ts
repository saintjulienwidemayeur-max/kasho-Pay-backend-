// Profit and loss of Kasho Pay: what customers pay us (their fees) against what Freda Pay Issuing charges us.
// Pure functions only (no database, no network), so they are unit tested. The admin handlers feed them rows.
//
// Customer fees live in the fee_rules table (see fees.ts). What Freda charges lives in partner_costs: one rule per
// operation, filled with Freda's public price list for the plans chosen in the admin page.
import { round2 } from "./config.js";
import { computeFee, FeeError, type FeeOperation, type FeeRule } from "./fees.js";

export const PARTNER_OPERATIONS = [
  "deposit", "withdrawal", "card_creation", "card_fund", "card_withdraw", "card_closure", "card_purchase", "master_wallet_funding",
] as const;
export type PartnerOperation = (typeof PARTNER_OPERATIONS)[number];

/**
 * One Freda price. The cost of one operation of `amount` USD is:
 *   thresholdUsd === null -> percent % of amount + flatUsd + flatHtg / rate
 *   thresholdUsd set      -> flatUsd while amount <= thresholdUsd, percent % of amount above it
 */
export type PartnerRule = {
  operation: PartnerOperation;
  label: string;
  percent: number;
  flatUsd: number;
  flatHtg: number;
  thresholdUsd: number | null;
  active: boolean;
  note: string;
};

// ------------------------------------------------------------------ Freda's price list (https://issuing.fredapay.com)
export const GATEWAY_PLANS = ["standard", "pro", "business"] as const;
export const ISSUING_PLANS = ["startup", "pro", "premium"] as const;
export type GatewayPlan = (typeof GATEWAY_PLANS)[number];
export type IssuingPlan = (typeof ISSUING_PLANS)[number];

/** Payment Gateway: MonCash / NatCash payments cost `percent` % + 10 HTG; payouts 5 %; monthly price in HTG. */
const GATEWAY: Record<GatewayPlan, { percent: number; monthlyHtg: number }> = {
  standard: { percent: 6, monthlyHtg: 0 },
  pro: { percent: 4.2, monthlyHtg: 1000 },
  business: { percent: 4, monthlyHtg: 5000 },
};
const PAYMENT_FLAT_HTG = 10;
const PAYOUT_PERCENT = 5;

/** Card issuing: per card created, per top-up (flat up to 100 USD, then a percentage), per withdrawal, Master Wallet funding %. */
const ISSUING: Record<IssuingPlan, { creation: number; fund: number; fundPercent: number; withdraw: number; funding: number; monthlyUsd: number }> = {
  startup: { creation: 5, fund: 1.6, fundPercent: 3, withdraw: 1.3, funding: 4.5, monthlyUsd: 0 },
  pro: { creation: 3.5, fund: 1.25, fundPercent: 2, withdraw: 1.15, funding: 3, monthlyUsd: 150 },
  premium: { creation: 2.5, fund: 1.1, fundPercent: 2, withdraw: 1.1, funding: 2.5, monthlyUsd: 500 },
};
const FUND_THRESHOLD_USD = 100;
const CARD_PURCHASE_USD = 0.1; // listed for Startup; kept for the other plans too (prudent: check your contract)
const CARD_CLOSURE_USD = 0.5;

export const isGatewayPlan = (v: unknown): v is GatewayPlan => (GATEWAY_PLANS as readonly string[]).includes(String(v));
export const isIssuingPlan = (v: unknown): v is IssuingPlan => (ISSUING_PLANS as readonly string[]).includes(String(v));

/** The partner price rules of the two chosen plans. */
export function presetRules(gateway: GatewayPlan, issuing: IssuingPlan): PartnerRule[] {
  const g = GATEWAY[gateway];
  const i = ISSUING[issuing];
  const r = (operation: PartnerOperation, label: string, v: Partial<PartnerRule>, note: string): PartnerRule => ({
    operation, label, percent: 0, flatUsd: 0, flatHtg: 0, thresholdUsd: null, active: true, note, ...v,
  });
  return [
    r("deposit", "MonCash / NatCash payment (Gateway)", { percent: g.percent, flatHtg: PAYMENT_FLAT_HTG }, `${g.percent} % + ${PAYMENT_FLAT_HTG} HTG per payment (${gateway} plan)`),
    r("withdrawal", "MonCash / NatCash payout", { percent: PAYOUT_PERCENT }, `${PAYOUT_PERCENT} % of the amount sent`),
    r("card_creation", "Card creation", { flatUsd: i.creation }, `$${i.creation.toFixed(2)} per card (${issuing} plan)`),
    r("card_fund", "Card top-up", { flatUsd: i.fund, percent: i.fundPercent, thresholdUsd: FUND_THRESHOLD_USD }, `$${i.fund.toFixed(2)} up to $${FUND_THRESHOLD_USD}, then ${i.fundPercent} % (${issuing} plan)`),
    r("card_withdraw", "Card withdrawal", { flatUsd: i.withdraw }, `$${i.withdraw.toFixed(2)} per withdrawal (${issuing} plan)`),
    r("card_closure", "Card closing", { flatUsd: CARD_CLOSURE_USD }, "$0.50, never more than what is left on the card"),
    r("card_purchase", "Card purchase", { flatUsd: CARD_PURCHASE_USD }, "$0.10 per purchase (Freda's Startup price; check the other plans)"),
    r("master_wallet_funding", "Adding money to the Master Wallet", { percent: i.funding }, `${i.funding} % of the money added (${issuing} plan)`),
  ];
}

/** Fixed monthly price of the two plans, in USD (the Gateway plan is priced in HTG). */
export function monthlyPlanUsd(gateway: GatewayPlan, issuing: IssuingPlan, htgPerUsd: number): number {
  return round2(ISSUING[issuing].monthlyUsd + (htgPerUsd > 0 ? GATEWAY[gateway].monthlyHtg / htgPerUsd : 0));
}

// ------------------------------------------------------------------ cost of one operation
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Cost in USD of one operation of `amountUsd` under `rule` (0 when the rule is missing or switched off). */
export function partnerCostOf(rule: PartnerRule | undefined, amountUsd: number, htgPerUsd: number): number {
  if (!rule || !rule.active) return 0;
  const a = Math.abs(Number(amountUsd) || 0);
  if (rule.thresholdUsd !== null) return a <= rule.thresholdUsd ? rule.flatUsd : (a * rule.percent) / 100;
  return (a * rule.percent) / 100 + rule.flatUsd + (htgPerUsd > 0 ? rule.flatHtg / htgPerUsd : 0);
}

// ------------------------------------------------------------------ ledger rows -> finance operations
export type FinanceOp = "deposit" | "withdrawal" | "card_creation" | "card_fund" | "card_withdraw" | "card_closure" | "transfer";
export const FINANCE_OPS: readonly FinanceOp[] = ["deposit", "withdrawal", "card_creation", "card_fund", "card_withdraw", "card_closure", "transfer"];

export type FinanceRow = { kind: string; status: string; amount: number | string; fee: number | string; created_at: string; meta?: any };

/** Which operation a ledger row belongs to (null = not part of the profit: transfers received, manual adjustments...). */
export function financeOp(row: Pick<FinanceRow, "kind" | "meta">): FinanceOp | null {
  switch (row.kind) {
    case "deposit": case "withdrawal": case "card_creation": case "card_fund": return row.kind;
    case "card_withdraw": return row.meta?.terminate ? "card_closure" : "card_withdraw";
    case "transfer_out": return "transfer";
    default: return null;
  }
}

/**
 * What Freda charged for one completed ledger row. The real figure Freda reported is used when it was recorded
 * (deposit fee_htg, payout fee, card top-up / withdrawal fee), otherwise the partner rule gives an estimate.
 */
export function rowPartnerCost(op: FinanceOp, row: FinanceRow, rules: Map<PartnerOperation, PartnerRule>, htgPerUsd: number): { cost: number; real: boolean } {
  const amount = Math.abs(Number(row.amount) || 0);
  const meta = row.meta ?? {};
  const rate = num(meta.rate) && (num(meta.rate) as number) > 0 ? (num(meta.rate) as number) : htgPerUsd;
  switch (op) {
    case "deposit": {
      const htg = num(meta.fee_htg);
      return htg !== null && htg >= 0 && rate > 0 ? { cost: htg / rate, real: true } : { cost: partnerCostOf(rules.get("deposit"), amount, rate), real: false };
    }
    case "withdrawal": {
      const htg = num(meta.payout_fee_htg);
      return htg !== null && htg >= 0 && rate > 0 ? { cost: htg / rate, real: true } : { cost: partnerCostOf(rules.get("withdrawal"), amount, rate), real: false };
    }
    case "card_creation":
      return { cost: partnerCostOf(rules.get("card_creation"), amount, rate), real: false };
    case "card_fund": {
      const usd = num(meta.provider_fee_usd);
      return usd !== null && usd >= 0 ? { cost: usd, real: true } : { cost: partnerCostOf(rules.get("card_fund"), amount, rate), real: false };
    }
    case "card_withdraw": {
      const usd = num(meta.provider_fee_usd);
      return usd !== null && usd >= 0 ? { cost: usd, real: true } : { cost: partnerCostOf(rules.get("card_withdraw"), amount, rate), real: false };
    }
    case "card_closure": {
      const rule = rules.get("card_closure");
      return { cost: rule && rule.active ? Math.min(rule.flatUsd, amount) : 0, real: false }; // never more than what was left on the card
    }
    case "transfer":
      return { cost: 0, real: true }; // Kasho to Kasho: nothing leaves Freda
  }
}

// ------------------------------------------------------------------ profit and loss
export type OpSummary = {
  operation: FinanceOp | "master_wallet_funding" | "card_purchase" | "plans";
  count: number;
  /** Money moved (USD). For master_wallet_funding: the net card money added to the Master Wallet. */
  volume: number;
  /** What customers paid us (their fees). */
  revenue: number;
  /** What Freda charged us (estimated unless `estimated` is 0). */
  partnerCost: number;
  profit: number;
  /** How many rows were priced with the partner rule instead of a figure reported by Freda. */
  estimated: number;
};

export type Pnl = {
  lines: OpSummary[];
  totals: { revenue: number; partnerCost: number; profit: number; margin: number | null };
  daily: { date: string; revenue: number; partnerCost: number; profit: number }[];
};

const emptyLine = (operation: OpSummary["operation"]): OpSummary => ({ operation, count: 0, volume: 0, revenue: 0, partnerCost: 0, profit: 0, estimated: 0 });

/** Calendar date (YYYY-MM-DD) of an instant in Haiti. */
export function haitiDate(iso: string | Date, timeZone = "America/Port-au-Prince"): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export type PnlInput = {
  /** Completed ledger rows of the period (other statuses are ignored). */
  rows: FinanceRow[];
  rules: PartnerRule[];
  htgPerUsd: number;
  /** Card purchases of the period (card.transaction webhooks): [{ created_at }] */
  purchases: { created_at: string }[];
  /** Fixed monthly price of the plans, prorated over `days`. */
  monthlyPlanUsd: number;
  days: number;
};

export function buildPnl(input: PnlInput): Pnl {
  const rules = new Map(input.rules.map((r) => [r.operation, r] as const));
  const lines = new Map<OpSummary["operation"], OpSummary>(FINANCE_OPS.map((op) => [op, emptyLine(op)]));
  const day = new Map<string, { revenue: number; partnerCost: number }>();
  const bump = (date: string, revenue: number, cost: number) => {
    if (!date) return;
    const d = day.get(date) ?? { revenue: 0, partnerCost: 0 };
    d.revenue += revenue; d.partnerCost += cost;
    day.set(date, d);
  };

  let cardPrincipal = 0; // card money added to (+) / taken back from (-) the Master Wallet
  for (const row of input.rows) {
    if (row.status !== "completed") continue;
    const op = financeOp(row);
    if (!op) continue;
    const line = lines.get(op)!;
    const amount = Math.abs(Number(row.amount) || 0);
    const revenue = Math.max(0, Number(row.fee) || 0);
    const { cost, real } = rowPartnerCost(op, row, rules, input.htgPerUsd);
    line.count += 1; line.volume += amount; line.revenue += revenue; line.partnerCost += cost;
    if (!real) line.estimated += 1;
    bump(haitiDate(row.created_at), revenue, cost);
    if (op === "card_creation" || op === "card_fund") cardPrincipal += amount;
    else if (op === "card_withdraw" || op === "card_closure") cardPrincipal -= amount;
  }

  // Freda keeps a percentage of the money you add to the Master Wallet. The card money that left the wallet in the
  // period (prefunds + top-ups, minus what came back) is what had to be added, so it carries that percentage.
  const funding = emptyLine("master_wallet_funding");
  const fundingRule = rules.get("master_wallet_funding");
  funding.volume = Math.max(0, cardPrincipal);
  funding.partnerCost = fundingRule && fundingRule.active ? (funding.volume * fundingRule.percent) / 100 + fundingRule.flatUsd : 0;
  funding.estimated = funding.volume > 0 ? 1 : 0;
  funding.count = funding.volume > 0 ? 1 : 0;

  // Freda charges per card purchase, and we charge customers nothing for it.
  const purchase = emptyLine("card_purchase");
  const purchaseRule = rules.get("card_purchase");
  purchase.count = input.purchases.length;
  purchase.partnerCost = purchaseRule && purchaseRule.active ? purchase.count * purchaseRule.flatUsd : 0;
  purchase.estimated = purchase.count;
  for (const p of input.purchases) bump(haitiDate(p.created_at), 0, purchaseRule && purchaseRule.active ? purchaseRule.flatUsd : 0);

  // Monthly plan prices, prorated.
  const plans = emptyLine("plans");
  plans.partnerCost = (Math.max(0, input.monthlyPlanUsd) * Math.max(0, input.days)) / 30;
  plans.count = plans.partnerCost > 0 ? 1 : 0;

  const all = [...lines.values(), funding, purchase, plans];
  for (const l of all) {
    l.volume = round2(l.volume); l.revenue = round2(l.revenue); l.partnerCost = round2(l.partnerCost);
    l.profit = round2(l.revenue - l.partnerCost);
  }
  const revenue = round2(all.reduce((s, l) => s + l.revenue, 0));
  const partnerCost = round2(all.reduce((s, l) => s + l.partnerCost, 0));
  const profit = round2(revenue - partnerCost);
  const daily = [...day.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, revenue: round2(v.revenue), partnerCost: round2(v.partnerCost), profit: round2(v.revenue - v.partnerCost) }));
  return { lines: all, totals: { revenue, partnerCost, profit, margin: revenue > 0 ? Math.round((profit / revenue) * 10000) / 10000 : null }, daily };
}

// ------------------------------------------------------------------ fee analysis: one customer operation, sample amounts
export type AnalysisRow = {
  /** Customer fee operation (fee_rules). */
  operation: FeeOperation;
  amount: number;
  /** What the customer pays us; null when the amount is outside the fee brackets. */
  ourFee: number | null;
  /** What Freda charges us for it, including the Master Wallet funding percentage for card money. */
  partnerCost: number;
  /** ourFee - partnerCost (null when ourFee is null). Negative = we lose money on this operation. */
  margin: number | null;
};

export const ANALYSIS_AMOUNTS = [5, 10, 25, 50, 100] as const;
export const ANALYSIS_PREFUNDS = [2, 10, 25, 50, 100] as const;

export function feeAnalysis(ourRules: FeeRule[], partner: PartnerRule[], htgPerUsd: number): AnalysisRow[] {
  const rules = new Map(partner.map((r) => [r.operation, r] as const));
  const fundingPct = rules.get("master_wallet_funding");
  const funding = (a: number) => (fundingPct && fundingPct.active ? (a * fundingPct.percent) / 100 + fundingPct.flatUsd : 0);
  const rows: AnalysisRow[] = [];
  const add = (operation: FeeOperation, amount: number, partnerCost: number) => {
    let ourFee: number | null = null;
    try { ourFee = computeFee(ourRules, operation, amount); } catch (e) { if (!(e instanceof FeeError)) throw e; }
    rows.push({ operation, amount, ourFee, partnerCost: round2(partnerCost), margin: ourFee === null ? null : round2(ourFee - partnerCost) });
  };
  for (const a of ANALYSIS_AMOUNTS) add("wallet_deposit", a, partnerCostOf(rules.get("deposit"), a, htgPerUsd));
  for (const a of ANALYSIS_AMOUNTS) add("wallet_withdrawal", a, partnerCostOf(rules.get("withdrawal"), a, htgPerUsd));
  for (const a of ANALYSIS_PREFUNDS) add("card_creation", a, partnerCostOf(rules.get("card_creation"), a, htgPerUsd) + funding(a));
  for (const a of ANALYSIS_AMOUNTS) add("card_fund", a, partnerCostOf(rules.get("card_fund"), a, htgPerUsd) + funding(a));
  for (const a of ANALYSIS_AMOUNTS) add("card_withdraw", a, partnerCostOf(rules.get("card_withdraw"), a, htgPerUsd));
  for (const a of ANALYSIS_AMOUNTS) add("transfer", a, 0);
  return rows;
}

/** Row of the partner_costs table -> PartnerRule. */
export function rowToPartnerRule(r: any): PartnerRule {
  return {
    operation: r.operation, label: String(r.label ?? ""), percent: Number(r.percent) || 0, flatUsd: Number(r.flat_usd) || 0,
    flatHtg: Number(r.flat_htg) || 0, thresholdUsd: num(r.threshold_usd), active: r.active !== false, note: String(r.note ?? ""),
  };
}
