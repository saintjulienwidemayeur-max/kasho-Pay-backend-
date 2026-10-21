// Business rules, read from environment variables (see .env).
// Fees are not here: they live in the fee_rules table (see fees.ts).
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function getConfig() {
  return {
    htgPerUsd: num("HTG_PER_USD", 131) || 131,
    minDepositUsd: num("MIN_DEPOSIT_USD", 1),
    minWithdrawUsd: num("MIN_WITHDRAW_USD", 1),
    minCardFundUsd: num("MIN_CARD_FUND_USD", 1),
    // Rolling 24h caps per user (0 disables a cap)
    dailyTransferLimitUsd: num("DAILY_TRANSFER_LIMIT_USD", 2000),
    dailyWithdrawLimitUsd: num("DAILY_WITHDRAW_LIMIT_USD", 2000),
    requireKycForCards: (process.env["REQUIRE_KYC_FOR_CARDS"] ?? "true").toLowerCase() === "true",
  };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Haiti numbers: accepts "+509 3700 1234", "37001234", "50937001234" -> "50937001234"
export function normalizeHaitiPhone(input: string): string | null {
  const digits = (input ?? "").replace(/\D/g, "");
  if (digits.length === 8) return `509${digits}`;
  if (digits.length === 11 && digits.startsWith("509")) return digits;
  return null;
}
