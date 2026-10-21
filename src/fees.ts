// Fee schedule (KASHOPAY LLC billing). The rules live in the `fee_rules` table so an admin can change them;
// this file holds the pure calculation and validation logic (no database or environment access, so it is unit tested).
import { round2 } from "./config.js";

export const FEE_OPERATIONS = ["card_creation", "wallet_deposit", "wallet_withdrawal", "card_fund", "card_withdraw", "transfer"] as const;
export type FeeOperation = (typeof FEE_OPERATIONS)[number];

/** Operations whose fee depends on amount brackets (the others have one rule without min / max). */
export const TIERED_OPERATIONS: readonly FeeOperation[] = ["wallet_deposit", "wallet_withdrawal"];

export type FeeRule = {
  id: string;
  operation: FeeOperation;
  label: string;
  feeType: "flat" | "percent";
  minAmount: number | null;
  maxAmount: number | null;
  feeValue: number;
  active: boolean;
};

/** Raised for a fee problem the user can act on (amount outside the brackets, fees not configured). */
export class FeeError extends Error {}

const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export function rowToRule(r: any): FeeRule {
  return {
    id: String(r.id),
    operation: r.operation,
    label: String(r.label ?? ""),
    feeType: r.fee_type === "percent" ? "percent" : "flat",
    minAmount: r.min_amount === null || r.min_amount === undefined ? null : Number(r.min_amount),
    maxAmount: r.max_amount === null || r.max_amount === undefined ? null : Number(r.max_amount),
    feeValue: Number(r.fee_value),
    active: r.active !== false,
  };
}

export async function loadFeeRules(db: any): Promise<FeeRule[]> {
  const { data, error } = await db.from("fee_rules").select("*").eq("active", true);
  if (error) {
    console.error("[fees] could not read fee_rules (run supabase/migrations/20261021000000_fee_rules.sql):", error.message);
    throw new FeeError("Fees are temporarily unavailable. Please try again later.");
  }
  return (data ?? []).map(rowToRule);
}

const isTier = (r: FeeRule) => r.minAmount !== null && r.maxAmount !== null;

function rulesFor(rules: FeeRule[], op: FeeOperation): FeeRule[] {
  return rules.filter((r) => r.active && r.operation === op)
    .sort((a, b) => (a.minAmount ?? 0) - (b.minAmount ?? 0));
}

/** Smallest and largest amount the brackets of a tiered operation accept, or null when it has no brackets. */
export function amountRange(rules: FeeRule[], op: FeeOperation): { min: number; max: number } | null {
  const tiers = rulesFor(rules, op).filter(isTier);
  if (!tiers.length) return null;
  return { min: Math.min(...tiers.map((t) => t.minAmount!)), max: Math.max(...tiers.map((t) => t.maxAmount!)) };
}

/**
 * Fee in USD for `amount` (always rounded to cents). Brackets match when min <= amount <= max;
 * on a shared boundary (10 in 5-10 and 10-25) the lower bracket wins.
 */
export function computeFee(rules: FeeRule[], op: FeeOperation, amount: number): number {
  const list = rulesFor(rules, op);
  if (!list.length) {
    console.error("[fees] no active fee rule for", op);
    throw new FeeError("Fees are temporarily unavailable. Please try again later.");
  }
  const tiers = list.filter(isTier);
  let rule: FeeRule | undefined;
  if (tiers.length) {
    const a = round2(amount);
    rule = tiers.find((t) => a >= t.minAmount! && a <= t.maxAmount!);
    if (!rule) {
      const range = amountRange(rules, op)!;
      throw new FeeError(a < range.min || a > range.max
        ? `The amount must be between ${usd(range.min)} and ${usd(range.max)}.`
        : "No fee is defined for that amount. Please try a different amount.");
    }
  } else {
    rule = list[0]!;
  }
  if (rule.feeType === "flat") return round2(rule.feeValue);
  const pct = round2((amount * rule.feeValue) / 100);
  return rule.feeValue > 0 ? Math.max(0.01, pct) : 0;
}

/** Checks a rule an admin wants to save against the other rules of the same operation. Returns an error message or null. */
export function validateRule(rule: Omit<FeeRule, "id" | "label"> & { id?: string }, others: FeeRule[]): string | null {
  const tiered = TIERED_OPERATIONS.includes(rule.operation);
  if (rule.feeType === "percent" && rule.feeValue > 100) return "A percentage fee cannot be more than 100.";
  if ((rule.minAmount === null) !== (rule.maxAmount === null)) return "Set both the minimum and the maximum amount, or neither.";
  if (tiered && rule.minAmount === null) return "This operation needs an amount bracket (minimum and maximum).";
  if (!tiered && rule.minAmount !== null) return "This operation has a single fee: remove the minimum and maximum amount.";
  if (rule.minAmount !== null && rule.maxAmount !== null && rule.maxAmount < rule.minAmount) return "The maximum must not be below the minimum.";

  const same = others.filter((o) => o.operation === rule.operation && o.id !== rule.id && o.active);
  if (rule.active) {
    if (!tiered && same.length) return "This operation already has an active fee: edit it instead of adding another.";
    if (tiered) {
      // Brackets may share a boundary (5-10 and 10-25) but must not overlap.
      const clash = same.find((o) => isTier(o) && rule.minAmount! < o.maxAmount! && o.minAmount! < rule.maxAmount!);
      if (clash) return `This bracket overlaps ${usd(clash.minAmount!)} - ${usd(clash.maxAmount!)}.`;
    }
  }
  return null;
}
