// Run: npm test   (uses only Node's built-in test runner)
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { bearerToken, createRateLimiter, getHandler, isJsonRequest, isOwnStoragePath, makeOriginCheck, noStore, securityHeaders } from "../src/security.js";
import { FredaError, verifyWebhookSignature } from "../src/freda.js";
import { normalizeHaitiPhone, round2 } from "../src/config.js";

const UID = "11111111-2222-3333-4444-555555555555";
const mkRes = () => {
  const r: any = { headers: {} as Record<string, string>, code: 200, body: null as any };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
};

test("handler lookup refuses prototype names (would crash the server)", () => {
  const map: Record<string, number> = { sendMoney: 1 };
  assert.equal(getHandler(map, "sendMoney"), 1);
  for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", "a/b", "../x", 5, null, undefined, "x".repeat(80)]) {
    assert.equal(getHandler(map, bad), undefined, `must reject ${String(bad)}`);
  }
});

test("KYC storage path must be exactly <ownUserId>/<safe file>", () => {
  assert.ok(isOwnStoragePath(`${UID}/1700000000-id.jpg`, UID));
  for (const bad of [
    `${UID}/../other/id.jpg`, `${UID}/..`, `${UID}/a/b.jpg`, `other/id.jpg`, `${UID}`, `/${UID}/id.jpg`,
    `${UID}/.hidden`, `${UID}/a b.jpg`, `${UID}/x..y.jpg`, `${UID}%2f..%2fx`, "", `${UID}/`, `${UID}//id.jpg`,
  ]) assert.equal(isOwnStoragePath(bad, UID), false, `must reject ${bad}`);
  assert.equal(isOwnStoragePath(123, UID), false);
  assert.equal(isOwnStoragePath(`${UID}/id.jpg`, ""), false);
});

test("rate limiter blocks after max, sends Retry-After, isolates keys and resets", async () => {
  const lim = createRateLimiter({ windowMs: 200, max: 3, key: (r) => r.k });
  const hit = (k: string) => { const res = mkRes(); let passed = false; lim({ k }, res, () => { passed = true; }); return { res, passed }; };
  assert.ok(hit("a").passed && hit("a").passed && hit("a").passed);
  const blocked = hit("a");
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.code, 429);
  assert.ok(Number(blocked.res.headers["Retry-After"]) >= 1);
  assert.ok(hit("b").passed, "another key is not affected");
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(hit("a").passed, "window reset");
});

test("bearer token parsing", () => {
  assert.equal(bearerToken("Bearer abc.def.ghi-1234567"), "abc.def.ghi-1234567");
  for (const bad of [undefined, null, "", "Bearer", "Bearer ", "bearer abc.def.ghi-1234567", "Basic abc.def.ghi-1234567", "Bearer a b", "Bearer short", "Bearer x\r\nInjected: 1"])
    assert.equal(bearerToken(bad as any), null);
});

test("only application/json bodies are accepted", () => {
  assert.ok(isJsonRequest("application/json") && isJsonRequest("application/json; charset=utf-8"));
  for (const bad of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "", undefined, "application/jsonx"]) assert.equal(isJsonRequest(bad as any), false);
});

test("CORS: production allows only listed origins, dev also allows LAN", () => {
  const prod = makeOriginCheck(["https://app.kasho.com"], false);
  assert.ok(prod("https://app.kasho.com") && prod(undefined));
  for (const o of ["http://localhost:5173", "http://192.168.1.155:5173", "https://evil.com", "https://app.kasho.com.evil.com", "null"]) assert.equal(prod(o), false, o);
  const dev = makeOriginCheck(["http://localhost:5173"], true);
  assert.ok(dev("http://192.168.1.155:5173") && dev("http://10.0.0.5:5173") && dev("http://172.20.1.1:5173"));
  for (const o of ["http://172.32.0.1:5173", "http://192.168.1.1.evil.com", "https://evil.com", "http://evil.com/192.168.1.1"]) assert.equal(dev(o), false, o);
});

test("security headers and no-store", () => {
  const res = mkRes(); let next = false;
  securityHeaders(true)({}, res, () => { next = true; });
  assert.ok(next);
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["X-Frame-Options"], "DENY");
  assert.match(res.headers["Strict-Transport-Security"] ?? "", /max-age=/);
  const dev = mkRes(); securityHeaders(false)({}, dev, () => {});
  assert.equal(dev.headers["Strict-Transport-Security"], undefined);
  const r2 = mkRes(); noStore({}, r2, () => {});
  assert.match(r2.headers["Cache-Control"] ?? "", /no-store/);
});

test("webhook signature: valid accepted, tampered/missing/wrong secret rejected", () => {
  const secret = "whsec_test_secret"; const body = JSON.stringify({ id: "evt_1", event: "payment.succeeded", data: { id: "pay_1" } });
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyWebhookSignature(body, sig, secret), true);
  assert.equal(verifyWebhookSignature(body + " ", sig, secret), false, "modified body");
  assert.equal(verifyWebhookSignature(body, sig, "whsec_other"), false, "wrong secret");
  assert.equal(verifyWebhookSignature(body, null, secret), false);
  assert.equal(verifyWebhookSignature(body, "sha256=", secret), false);
  assert.equal(verifyWebhookSignature(body, sig.slice(0, -2), secret), false, "truncated");
  assert.equal(verifyWebhookSignature(body, sig, ""), false, "empty secret must never validate");
  assert.equal(verifyWebhookSignature("", "sha256=" + createHmac("sha256", "").update("").digest("hex"), ""), false);
});

test("Freda errors: only unknown outcomes are 'ambiguous' (never auto-refund those)", () => {
  assert.equal(new FredaError(502, "NETWORK", "x").ambiguous, true);
  assert.equal(new FredaError(500, "PROVIDER_ERROR", "x").ambiguous, true);
  assert.equal(new FredaError(503, "CARD_PROVIDER_AUTH", "x").ambiguous, false);
  assert.equal(new FredaError(400, "INVALID_RECIPIENT", "x").ambiguous, false);
  assert.equal(new FredaError(409, "CARD_FROZEN", "x").ambiguous, false);
});

test("phone normalization and rounding", () => {
  assert.equal(normalizeHaitiPhone("+509 3700 1234"), "50937001234");
  assert.equal(normalizeHaitiPhone("37001234"), "50937001234");
  for (const bad of ["", "123", "5093700123", "+1 202 555 0123", "abcdefgh", "509370012345"]) assert.equal(normalizeHaitiPhone(bad), null, bad);
  assert.equal(round2(1.005 + 0.0001), 1.01);
  assert.equal(round2(0.1 + 0.2), 0.3);
});

// ------------------------------------------------------------ Didit
import { createHmac as _hmac } from "node:crypto";
import { mapStatus, verifyDiditWebhook } from "../src/didit.js";

test("didit: status mapping", () => {
  assert.equal(mapStatus("Approved"), "verified");
  assert.equal(mapStatus("Declined"), "rejected");
  assert.equal(mapStatus("In Review"), "pending");
  assert.equal(mapStatus("Not Started"), "pending");
  assert.equal(mapStatus(undefined), "pending");
});

test("didit: webhook signature (raw + v2), timestamp window, tampering", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ b: 1, a: { d: 2, c: 3 }, session_id: "x" });
  const now = 1_800_000_000;
  const raw = _hmac("sha256", secret).update(body).digest("hex");
  const canon = JSON.stringify({ a: { c: 3, d: 2 }, b: 1, session_id: "x" });
  const v2 = _hmac("sha256", secret).update(canon).digest("hex");
  assert.equal(verifyDiditWebhook(body, { signature: raw, timestamp: String(now) }, secret, now), true);
  assert.equal(verifyDiditWebhook(body, { signatureV2: v2, timestamp: String(now) }, secret, now), true);
  assert.equal(verifyDiditWebhook(body + " ", { signature: raw, timestamp: String(now) }, secret, now), false);
  assert.equal(verifyDiditWebhook(body, { signature: raw, timestamp: String(now - 301) }, secret, now), false);
  assert.equal(verifyDiditWebhook(body, { signature: raw, timestamp: "abc" }, secret, now), false);
  assert.equal(verifyDiditWebhook(body, { signature: raw, timestamp: String(now) }, "", now), false);
  assert.equal(verifyDiditWebhook(body, { timestamp: String(now) }, secret, now), false);
});

// ------------------------------------------------------------ step-up + encryption
import { STEP_UP, tokenAal, hasVerifiedTotp, recordStepUpFailure, stepUpLocked, clearStepUpFailures } from "../src/stepup.js";
import { encryptField, decryptField, isEncrypted } from "../src/crypto.js";

test("stepup: sensitive endpoints are covered", () => {
  for (const n of ["revealCardFn", "startWithdrawal", "changePassword"]) assert.ok(STEP_UP[n], n);
});

test("stepup: aal claim, totp detection, lockout", () => {
  const tok = (aal: string) => `x.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.y`;
  assert.equal(tokenAal(tok("aal2")), "aal2");
  assert.equal(tokenAal(tok("aal1")), "aal1");
  assert.equal(tokenAal("garbage"), "aal1");
  assert.equal(hasVerifiedTotp({ factors: [{ factor_type: "totp", status: "verified" }] }), true);
  assert.equal(hasVerifiedTotp({ factors: [{ factor_type: "totp", status: "unverified" }] }), false);
  assert.equal(hasVerifiedTotp({}), false);
  const u = "lock-test";
  for (let i = 0; i < 4; i++) recordStepUpFailure(u);
  assert.equal(stepUpLocked(u), false);
  recordStepUpFailure(u);
  assert.equal(stepUpLocked(u), true);
  assert.equal(stepUpLocked(u, Date.now() + 16 * 60_000), false);
  clearStepUpFailures(u);
  assert.equal(stepUpLocked(u), false);
});

test("crypto: AES-GCM round trip, random IV, tamper detection, legacy plaintext", () => {
  process.env["DATA_ENCRYPTION_KEY"] = "a".repeat(64);
  const a = encryptField("HT-123456"), b = encryptField("HT-123456");
  assert.ok(isEncrypted(a));
  assert.notEqual(a, b);
  assert.equal(decryptField(a), "HT-123456");
  assert.equal(encryptField(a), a);
  assert.equal(decryptField("legacy-plain"), "legacy-plain");
  const parts = a.split(":"); parts[4] = Buffer.from("tampered!").toString("base64");
  assert.throws(() => decryptField(parts.join(":")));
  process.env["DATA_ENCRYPTION_KEY"] = "b".repeat(64);
  assert.throws(() => decryptField(a));
});

test("card code: hash round trip, wrong code, salt, bad input", async () => {
  const { hashCardCode, verifyCardCode } = await import("../src/crypto.js");
  process.env["DATA_ENCRYPTION_KEY"] = "c".repeat(64);
  const h1 = hashCardCode("4821"), h2 = hashCardCode("4821");
  assert.notEqual(h1, h2);
  assert.equal(verifyCardCode("4821", h1), true);
  assert.equal(verifyCardCode("4822", h1), false);
  assert.equal(verifyCardCode("48210", h1), false);
  assert.equal(verifyCardCode("4821", null), false);
  assert.equal(verifyCardCode("4821", "scrypt:v1:x"), false);
  process.env["DATA_ENCRYPTION_KEY"] = "d".repeat(64);
  assert.equal(verifyCardCode("4821", h1), false); // different server key
  assert.ok(!h1.includes("4821"));
});
