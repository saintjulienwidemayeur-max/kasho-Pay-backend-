// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSafeRemoteUrl } from "../src/security.js";
import { cardCodeAttemptAllowed, resetCardCodeAttempts } from "../src/cardcode.js";
import { MFA_ENDPOINTS, STEP_UP, mfaEndpointRequired } from "../src/stepup.js";

test("ssrf guard: only https URLs on public host names", () => {
  assert.equal(isSafeRemoteUrl("https://cdn.didit.me/a/b.jpg?sig=1"), true);
  for (const bad of [
    "http://cdn.didit.me/a.jpg", "https://localhost/a", "https://127.0.0.1/a", "https://169.254.169.254/latest/meta-data",
    "https://[::1]/a", "https://10.0.0.5/a", "https://metadata.internal/a", "https://db.local/a", "https://intranet/a",
    "https://user:pw@cdn.didit.me/a", "https://cdn.didit.me:8443/a", "file:///etc/passwd", "javascript:alert(1)", "not a url", "", 5, null,
    "https://2130706433/a", "https://x.corp/a",
  ]) assert.equal(isSafeRemoteUrl(bad as any), false, `must reject ${String(bad)}`);
});

test("card code attempts: allowed until the database says locked, fails open to the in-memory lock", async () => {
  const calls: string[] = [];
  const mk = (res: any, throws = false) => ({ rpc: async (name: string, args: any) => { calls.push(`${name}:${args.p_user}`); if (throws) throw new Error("down"); return res; } });
  assert.equal(await cardCodeAttemptAllowed(mk({ data: true, error: null }), "u1"), true);
  assert.equal(await cardCodeAttemptAllowed(mk({ data: false, error: null }), "u1"), false);
  assert.equal(await cardCodeAttemptAllowed(mk({ data: null, error: { message: "function not found" } }), "u1"), true);
  assert.equal(await cardCodeAttemptAllowed(mk(null, true), "u1"), true);
  await resetCardCodeAttempts(mk({ error: null }), "u2");
  await resetCardCodeAttempts(mk(null, true), "u2"); // never throws
  assert.deepEqual(calls.slice(0, 1), ["kasho_card_code_attempt:u1"]);
  assert.ok(calls.includes("kasho_card_code_reset:u2"));
});

test("mfa: every STEP_UP endpoint is in the opt-in list, and the flag defaults to off", () => {
  for (const n of Object.keys(STEP_UP)) assert.ok(MFA_ENDPOINTS.has(n), n);
  for (const n of ["sendMoney", "fundCardFn", "withdrawCardFn", "adminSaveFee"]) assert.ok(MFA_ENDPOINTS.has(n), n);
  assert.equal(mfaEndpointRequired("sendMoney", false), false);
  assert.equal(mfaEndpointRequired("sendMoney", true), true);
  assert.equal(mfaEndpointRequired("getPublicConfig", true), false);
  assert.equal(mfaEndpointRequired("constructor", true), false);
});

test("daily limit error is mapped to a user message (no raw SQL error)", async () => {
  process.env["SUPABASE_URL"] ??= "http://localhost:1"; // ledger.ts builds a client at import time; nothing is called
  process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test-key";
  const { toUserError } = await import("../src/ledger.js");
  assert.equal(toUserError({ message: "DAILY_LIMIT" }).message, "Daily limit reached. Please try again later.");
});

test("migration: kasho_transfer / kasho_debit enforce the daily cap under the wallet lock and stay service-role only", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261021010000_security_hardening.sql", import.meta.url), "utf8");
  assert.match(sql, /drop function if exists public\.kasho_transfer\(uuid, uuid, numeric, text, numeric\)/);
  assert.match(sql, /drop function if exists public\.kasho_debit\(uuid, text, text, text, text, numeric, numeric, text, uuid, text, jsonb\)/);
  assert.equal((sql.match(/raise exception 'DAILY_LIMIT'/g) ?? []).length, 2);
  for (const fn of ["kasho_transfer\\(uuid, uuid, numeric, text, numeric, numeric\\)", "kasho_debit\\(uuid, text, text, text, text, numeric, numeric, text, uuid, text, jsonb, numeric\\)",
    "kasho_card_code_attempt\\(uuid\\)", "kasho_card_code_reset\\(uuid\\)"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn} to service_role`));
  }
  assert.equal((sql.match(/security definer set search_path = public, pg_temp/g) ?? []).length, 4);
});
