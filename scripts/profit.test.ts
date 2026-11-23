// Run: npm test
// The benefit figures: fees customers paid minus what Freda charged. Exact where recorded, estimated (and shown apart) otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { computeProfit, estimateCostUsd, recordedCostUsd, type PartnerRule } from "../src/profit.js";

const rule = (o: Partial<PartnerRule> & { operation: string }): PartnerRule => ({ label: "", percent: 0, flatUsd: 0, flatHtg: 0, thresholdUsd: null, active: true, note: "", ...o });
const RULES = [
  rule({ operation: "deposit", percent: 6, flatHtg: 10 }),
  rule({ operation: "withdrawal", percent: 5 }),
  rule({ operation: "card_creation", flatUsd: 5 }),
  rule({ operation: "card_fund", percent: 3, flatUsd: 1.6, thresholdUsd: 100 }),
  rule({ operation: "card_purchase", flatUsd: 0.1 }),
];

test("estimated cost follows the price list: percent + flat, a threshold switches flat <-> percent, an inactive rule costs nothing", () => {
  assert.equal(estimateCostUsd(RULES[0], 100, 131), 6 + 10 / 131);
  assert.equal(estimateCostUsd(RULES[2], 50, 131), 5);
  assert.equal(estimateCostUsd(RULES[3], 50, 131), 1.6, "up to $100: flat");
  assert.equal(estimateCostUsd(RULES[3], 200, 131), 6, "above: 3 %");
  assert.equal(estimateCostUsd({ ...RULES[2]!, active: false }, 50, 131), 0);
  assert.equal(estimateCostUsd(undefined, 50, 131), 0);
});

test("what Freda really charged is used when it was recorded (in HTG with the rate of the operation, or in USD), else null", () => {
  assert.equal(recordedCostUsd("deposit", { fee_htg: 262, rate: 131 }, 140), 2, "HTG fee at the rate the operation used");
  assert.equal(recordedCostUsd("deposit", { fee_htg: 280 }, 140), 2, "no rate on the row: the current one");
  assert.equal(recordedCostUsd("withdrawal", { payout_fee_htg: 131 }, 131), 1);
  assert.equal(recordedCostUsd("card_fund", { provider_fee_usd: 1.6 }, 131), 1.6);
  assert.equal(recordedCostUsd("card_creation", {}, 131), null, "creation is not recorded: estimated");
  assert.equal(recordedCostUsd("deposit", {}, 131), null);
  assert.equal(recordedCostUsd("transfer_out", {}, 131), 0, "between two Kasho wallets: no partner");
});

test("profit = fees - exact cost - estimated cost, per operation and in total; the estimate is kept apart and counted", () => {
  const txs = [
    { kind: "deposit", amount: 100, fee: 3, meta: { fee_htg: 262, rate: 131 } },          // exact cost $2 -> profit 1
    { kind: "deposit", amount: 100, fee: 3, meta: {} },                                     // estimated: 6 + 10/131
    { kind: "card_creation", amount: -10, fee: 3, meta: {} },                               // estimated: $5 -> profit -2
    { kind: "card_fund", amount: -20, fee: 2, meta: { provider_fee_usd: 1.6 } },            // exact -> 0.4
    { kind: "transfer_out", amount: -5, fee: 0.5, meta: {} },                               // no cost
    { kind: "wallet_adjust", amount: 99, fee: 99, meta: {} },                               // not a fee kind: ignored
  ];
  const events = [{ type: "AUTHORIZATION", amount: 12 }, { type: "DECLINE", amount: 3 }, { type: "FUNDING", amount: 20 }, { type: "AUTHORIZATION", amount: 7 }];
  const r = computeProfit(txs, events, RULES, 131);
  const by = Object.fromEntries(r.rows.map((x) => [x.kind, x]));
  assert.deepEqual([by["deposit"]!.count, by["deposit"]!.fees, by["deposit"]!.costExact, by["deposit"]!.estimatedCount], [2, 6, 2, 1]);
  assert.equal(by["deposit"]!.costEstimated, Math.round((6 + 10 / 131) * 100) / 100);
  assert.deepEqual([by["card_creation"]!.fees, by["card_creation"]!.costEstimated, by["card_creation"]!.profit], [3, 5, -2]);
  assert.deepEqual([by["card_fund"]!.costExact, by["card_fund"]!.costEstimated, by["card_fund"]!.profit], [1.6, 0, 0.4]);
  assert.deepEqual([by["transfer_out"]!.fees, by["transfer_out"]!.profit], [0.5, 0.5]);
  assert.deepEqual([by["card_purchase"]!.count, by["card_purchase"]!.fees, by["card_purchase"]!.costEstimated, by["card_purchase"]!.profit], [2, 0, 0.2, -0.2], "only real purchases, a cost without a fee");
  assert.equal(by["wallet_adjust"], undefined);
  assert.equal(r.totals.fees, 11.5); // 3+3 + 3 + 2 + 0.5
  assert.equal(r.totals.costExact, 3.6);
  assert.equal(r.totals.profit, Math.round((r.totals.fees - r.totals.costExact - r.totals.costEstimated) * 100) / 100);
  assert.equal(r.totals.estimatedCount, 4);
});
