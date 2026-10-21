// Run: npm test   (uses only Node's built-in test runner)
import test from "node:test";
import assert from "node:assert/strict";
import { FeeError, amountRange, computeFee, rowToRule, validateRule, type FeeRule } from "../src/fees.js";

// Same defaults as supabase/migrations/20261021000000_fee_rules.sql
const row = (operation: string, fee_type: string, min: number | null, max: number | null, fee_value: number, extra: Record<string, unknown> = {}) =>
  rowToRule({ id: `${operation}-${min}`, operation, label: "", fee_type, min_amount: min, max_amount: max, fee_value, active: true, ...extra });
const RULES: FeeRule[] = [
  row("card_creation", "flat", null, null, 10),
  row("wallet_deposit", "flat", 5, 10, 0.8), row("wallet_deposit", "flat", 10, 25, 1.15),
  row("wallet_deposit", "flat", 25, 50, 1.5), row("wallet_deposit", "flat", 50, 100, 2),
  row("wallet_withdrawal", "flat", 5, 10, 0.7), row("wallet_withdrawal", "flat", 10, 25, 1),
  row("wallet_withdrawal", "flat", 25, 50, 1.25), row("wallet_withdrawal", "flat", 50, 100, 1.75),
  row("card_fund", "flat", null, null, 2.3), row("card_withdraw", "flat", null, null, 2.15),
  row("transfer", "percent", null, null, 1.5),
];

test("flat fees", () => {
  assert.equal(computeFee(RULES, "card_creation", 25), 10);
  assert.equal(computeFee(RULES, "card_fund", 40), 2.3);
  assert.equal(computeFee(RULES, "card_withdraw", 40), 2.15);
});

test("deposit and withdrawal brackets", () => {
  const dep: [number, number][] = [[5, 0.8], [7.5, 0.8], [10.01, 1.15], [25, 1.15], [25.01, 1.5], [50, 1.5], [50.01, 2], [100, 2]];
  for (const [amount, fee] of dep) assert.equal(computeFee(RULES, "wallet_deposit", amount), fee, `deposit ${amount}`);
  const wd: [number, number][] = [[5, 0.7], [10.01, 1], [30, 1.25], [100, 1.75]];
  for (const [amount, fee] of wd) assert.equal(computeFee(RULES, "wallet_withdrawal", amount), fee, `withdrawal ${amount}`);
});

test("a shared boundary belongs to the lower bracket", () => {
  assert.equal(computeFee(RULES, "wallet_deposit", 10), 0.8);
  assert.equal(computeFee(RULES, "wallet_withdrawal", 25), 1);
});

test("amounts outside the brackets are refused with the allowed range", () => {
  for (const a of [4.99, 100.01, 500]) {
    assert.throws(() => computeFee(RULES, "wallet_deposit", a), (e: any) => e instanceof FeeError && /between \$5 and \$100/.test(e.message));
  }
  assert.deepEqual(amountRange(RULES, "wallet_deposit"), { min: 5, max: 100 });
  assert.equal(amountRange(RULES, "transfer"), null);
});

test("transfer fee is 1.5 % rounded to cents, never zero", () => {
  assert.equal(computeFee(RULES, "transfer", 100), 1.5);
  assert.equal(computeFee(RULES, "transfer", 33.33), 0.5);
  assert.equal(computeFee(RULES, "transfer", 1), 0.02);
  assert.equal(computeFee(RULES, "transfer", 0.1), 0.01);
});

test("inactive rules are ignored and a missing rule fails closed", () => {
  const off = RULES.map((r) => (r.operation === "card_fund" ? { ...r, active: false } : r));
  assert.throws(() => computeFee(off, "card_fund", 10), FeeError);
  assert.throws(() => computeFee([], "transfer", 10), FeeError);
});

test("rule validation", () => {
  const base = { operation: "wallet_deposit" as const, feeType: "flat" as const, minAmount: 100, maxAmount: 200, feeValue: 3, active: true };
  assert.equal(validateRule(base, RULES), null, "a bracket right after the last one is fine");
  assert.match(validateRule({ ...base, minAmount: 40, maxAmount: 60 }, RULES) ?? "", /overlaps/);
  assert.equal(validateRule({ ...base, minAmount: 40, maxAmount: 60, active: false }, RULES), null, "inactive rules may overlap");
  const existing = RULES.find((r) => r.operation === "wallet_deposit" && r.minAmount === 25)!;
  assert.equal(validateRule({ ...existing, feeValue: 9 }, RULES), null, "editing a bracket does not clash with itself");
  assert.match(validateRule({ ...base, minAmount: null, maxAmount: null }, RULES) ?? "", /bracket/);
  assert.match(validateRule({ ...base, minAmount: 9, maxAmount: 3 }, RULES) ?? "", /maximum/);
  assert.match(validateRule({ ...base, minAmount: 5, maxAmount: null }, RULES) ?? "", /both/);
  assert.match(validateRule({ operation: "card_fund", feeType: "flat", minAmount: null, maxAmount: null, feeValue: 3, active: true }, RULES) ?? "", /already has an active fee/);
  assert.match(validateRule({ operation: "transfer", feeType: "percent", minAmount: 1, maxAmount: 5, feeValue: 3, active: true, id: "x" }, RULES) ?? "", /single fee/);
  assert.match(validateRule({ operation: "transfer", feeType: "percent", minAmount: null, maxAmount: null, feeValue: 101, active: true, id: "x" }, RULES) ?? "", /100/);
});
