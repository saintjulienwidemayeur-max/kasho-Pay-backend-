// Benefits (profit) for the admin site: what customers paid in fees, minus what the partner (Freda) charged us.
// Exact where Freda's real charge was recorded on the operation (meta.fee_htg for a top-up, meta.payout_fee_htg for a withdrawal,
// meta.provider_fee_usd for a card top-up / withdrawal); for what is not recorded (card creation, card purchases, older operations) the
// cost is ESTIMATED from the partner price list (table partner_costs, editable by a super administrator) and shown apart, never mixed in
// silently. Pure functions: no I/O (the handler in admin.ts reads the rows).

export type PartnerRule = { operation: string; label: string; percent: number; flatUsd: number; flatHtg: number; thresholdUsd: number | null; active: boolean; note: string };
export type ProfitTx = { kind: string; amount: unknown; fee: unknown; meta?: any };
export type ProfitEvent = { type: string; amount: unknown };

/** The kinds of ledger rows that earn a fee. */
export const PROFIT_KINDS = ["deposit", "withdrawal", "card_creation", "card_fund", "card_withdraw", "transfer_out"] as const;
export const PARTNER_OPERATIONS = ["deposit", "withdrawal", "card_creation", "card_fund", "card_withdraw", "card_closure", "card_purchase", "master_wallet_funding"] as const;

/** Card events that are not purchases (Freda charges per purchase only). */
const NOT_PURCHASES = new Set(["FUNDING", "WITHDRAWAL", "TERMINATION", "SETTLEMENT", "DECLINE", "REFUND", "REVERSAL"]);

export const LABELS: Record<string, string> = {
  deposit: "Wallet top-up (MonCash / NatCash)", withdrawal: "Wallet withdrawal", card_creation: "Card creation", card_fund: "Card top-up",
  card_withdraw: "Card withdrawal", transfer_out: "Kasho transfer", card_purchase: "Card purchases (Freda commission)",
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown): number => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : 0; };
const posNum = (v: unknown): number | null => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null; };

/** What the partner price list says one operation of `amountUsd` costs us (USD). */
export function estimateCostUsd(rule: PartnerRule | undefined, amountUsd: number, rate: number): number {
  if (!rule || !rule.active) return 0;
  const a = Math.abs(amountUsd);
  if (rule.thresholdUsd !== null) return a <= rule.thresholdUsd ? rule.flatUsd + rule.flatHtg / rate : (rule.percent / 100) * a;
  return (rule.percent / 100) * a + rule.flatUsd + rule.flatHtg / rate;
}

/** What Freda REALLY charged, when it was recorded on the operation (USD), else null. */
export function recordedCostUsd(kind: string, meta: any, rate: number): number | null {
  if (kind === "transfer_out") return 0; // between two Kasho wallets: no partner involved
  const r = posNum(meta?.rate) ?? rate;
  if (kind === "deposit") { const h = posNum(meta?.fee_htg); return h === null ? null : h / (r || rate); }
  if (kind === "withdrawal") { const h = posNum(meta?.payout_fee_htg); return h === null ? null : h / (r || rate); }
  if (kind === "card_fund" || kind === "card_withdraw") return posNum(meta?.provider_fee_usd);
  return null;
}

export type ProfitRow = {
  kind: string; label: string; count: number; volume: number;
  /** What customers paid in fees. */
  fees: number;
  /** What Freda charged, from the amounts it reported. */
  costExact: number;
  /** What Freda probably charged, from the price list, for the operations without a recorded charge. */
  costEstimated: number; estimatedCount: number;
  /** fees - costExact - costEstimated */
  profit: number;
};
export type ProfitReport = { rows: ProfitRow[]; totals: Omit<ProfitRow, "kind" | "label"> };

export function computeProfit(txs: ProfitTx[], events: ProfitEvent[], rules: PartnerRule[], rate: number): ProfitReport {
  const rule = (op: string) => rules.find((x) => x.operation === op);
  const rows = new Map<string, ProfitRow>();
  const row = (kind: string): ProfitRow => {
    let r = rows.get(kind);
    if (!r) { r = { kind, label: LABELS[kind] ?? kind, count: 0, volume: 0, fees: 0, costExact: 0, costEstimated: 0, estimatedCount: 0, profit: 0 }; rows.set(kind, r); }
    return r;
  };
  for (const t of txs) {
    if (!(PROFIT_KINDS as readonly string[]).includes(t.kind)) continue;
    const r = row(t.kind);
    const amount = Math.abs(num(t.amount));
    r.count += 1; r.volume += amount; r.fees += num(t.fee);
    const exact = recordedCostUsd(t.kind, t.meta, rate);
    if (exact !== null) r.costExact += exact;
    else { r.costEstimated += estimateCostUsd(rule(t.kind), amount, posNum(t.meta?.rate) ?? rate); r.estimatedCount += 1; }
  }
  // Freda charges a commission on every card purchase: a cost without any fee of ours.
  for (const e of events) {
    if (NOT_PURCHASES.has(String(e.type).toUpperCase())) continue;
    const r = row("card_purchase");
    const amount = Math.abs(num(e.amount));
    r.count += 1; r.volume += amount;
    r.costEstimated += estimateCostUsd(rule("card_purchase"), amount, rate); r.estimatedCount += 1;
  }
  const out = [...rows.values()].map((r) => {
    const x = { ...r, volume: r2(r.volume), fees: r2(r.fees), costExact: r2(r.costExact), costEstimated: r2(r.costEstimated) };
    return { ...x, profit: r2(x.fees - x.costExact - x.costEstimated) };
  });
  const order = [...PROFIT_KINDS, "card_purchase"] as string[];
  out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const sum = (k: "count" | "volume" | "fees" | "costExact" | "costEstimated" | "estimatedCount") => out.reduce((s, r) => s + r[k], 0);
  const totals = { count: sum("count"), volume: r2(sum("volume")), fees: r2(sum("fees")), costExact: r2(sum("costExact")), costEstimated: r2(sum("costEstimated")), estimatedCount: sum("estimatedCount"), profit: 0 };
  totals.profit = r2(totals.fees - totals.costExact - totals.costEstimated);
  return { rows: out, totals };
}

export function rowToPartnerRule(r: any): PartnerRule {
  return {
    operation: String(r.operation), label: String(r.label ?? ""), percent: num(r.percent), flatUsd: num(r.flat_usd), flatHtg: num(r.flat_htg),
    thresholdUsd: r.threshold_usd === null || r.threshold_usd === undefined ? null : num(r.threshold_usd), active: r.active !== false, note: String(r.note ?? ""),
  };
}
