// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
process.env["SUPABASE_URL"] ??= "http://localhost:1";
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test-key";
const P: any = await import("../src/push.js");

test("isAllowedPushEndpoint accepts real push services", () => {
  for (const u of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com/wp/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://updates-autopush.stage.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QWERTY",
    "https://abc.push.apple.com/x",
    "https://db5p.notify.windows.com/?token=x",
    "https://wns2-par02p.wns.windows.com/x",
  ]) assert.equal(P.isAllowedPushEndpoint(u), true, u);
});

test("isAllowedPushEndpoint rejects everything else", () => {
  for (const u of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://127.0.0.1/x", "https://10.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/latest",
    "https://localhost/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x",
    "https://fcm.googleapis.com.evil.com/x", "https://evilfcm.googleapis.com.attacker.io/x",
    "https://evil-push.apple.com.evil.com/x", "https://notify.windows.com.evil.com/x",
    "https://push.apple.com/x", "https://xpush.apple.com/x", "https://evil.com/fcm.googleapis.com",
    "https://fcm.googleapis.com@evil.com/x", "ftp://fcm.googleapis.com/x", "not a url", "", "javascript:alert(1)",
    "https://fcm.googleapis.com/" + "a".repeat(2100),
  ]) assert.equal(P.isAllowedPushEndpoint(u), false, u);
  assert.equal(P.isAllowedPushEndpoint(undefined), false);
  assert.equal(P.isAllowedPushEndpoint(42), false);
});

test("validPushKeys checks base64url and lengths", () => {
  const p = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
  const a = Buffer.alloc(16, 9).toString("base64url");
  assert.equal(P.validPushKeys(p, a), true);
  assert.equal(P.validPushKeys(a, a), false);
  assert.equal(P.validPushKeys(p, p), false);
  assert.equal(P.validPushKeys(p + "!", a), false);
  assert.equal(P.validPushKeys(Buffer.concat([Buffer.from([3]), Buffer.alloc(64)]).toString("base64url"), a), false);
  assert.equal(P.validPushKeys("", ""), false);
  assert.equal(P.validPushKeys(null, a), false);
});

test("validTimeZone", () => {
  assert.equal(P.validTimeZone("America/Port-au-Prince"), true);
  assert.equal(P.validTimeZone("Europe/Paris"), true);
  assert.equal(P.validTimeZone("Mars/Base"), false);
  assert.equal(P.validTimeZone(""), false);
  assert.equal(P.validTimeZone(5), false);
});

// Haiti is UTC-5 in winter (EST) and UTC-4 in summer (EDT). 2026-01-15 is winter, 2026-07-15 summer.
const HT = "America/Port-au-Prince";
const at = (iso: string) => new Date(iso);
test("shouldGreet window in Haiti time (winter)", () => {
  const g = (iso: string, last: string | null = null) => P.shouldGreet({ now: at(iso), tz: HT, lastGreetingOn: last });
  assert.equal(g("2026-01-15T12:59:00Z"), false); // 07:59
  assert.equal(g("2026-01-15T13:00:00Z"), true); // 08:00
  assert.equal(g("2026-01-15T15:59:00Z"), true); // 10:59
  assert.equal(g("2026-01-15T16:00:00Z"), false); // 11:00
  assert.equal(g("2026-01-15T13:30:00Z", "2026-01-15"), false); // already greeted today
  assert.equal(g("2026-01-15T13:30:00Z", "2026-01-14"), true);
});

test("shouldGreet follows DST and other zones", () => {
  const g = (iso: string, tz: string) => P.shouldGreet({ now: at(iso), tz, lastGreetingOn: null });
  assert.equal(g("2026-07-15T12:00:00Z", HT), true); // 08:00 EDT
  assert.equal(g("2026-07-15T11:59:00Z", HT), false); // 07:59 EDT
  assert.equal(g("2026-07-15T13:00:00Z", "Europe/Paris"), false); // 15:00
  assert.equal(g("2026-07-15T07:00:00Z", "Europe/Paris"), true); // 09:00 CEST
  assert.equal(g("2026-01-15T08:00:00Z", "Europe/Paris"), true); // 09:00 CET
  assert.equal(g("2026-01-15T13:00:00Z", "Not/AZone"), true); // invalid zone -> Haiti
  assert.equal(g("2026-01-15T12:00:00Z", "Not/AZone"), false);
  assert.equal(P.localDate(at("2026-01-15T03:00:00Z"), HT), "2026-01-14");
});

test("greeting message: names, languages, never an amount", () => {
  const fr = P.buildGreeting("fr", "Marie");
  assert.equal(fr.title, "Bonjour Marie 👋");
  assert.equal(fr.body, "Bonne journée ! Ouvrez Kasho Pay pour voir votre portefeuille.");
  assert.equal(fr.tag, "morning");
  assert.equal(P.buildGreeting("fr", "").title, "Bonjour 👋");
  assert.equal(P.buildGreeting("fr", null).title, "Bonjour 👋");
  const en = P.buildGreeting("en", "Marie");
  assert.equal(en.title, "Good morning Marie 👋");
  assert.equal(en.body, "Have a great day! Open Kasho Pay to see your wallet.");
  assert.equal(P.buildGreeting("en", " ").title, "Good morning 👋");
  for (const m of [fr, en]) assert.doesNotMatch(m.title + m.body, /\$|\d/);
});

// One realistic English sample per notify() title. A new notify() call without an entry here (and a French rule) fails.
const SAMPLES: Record<string, string[]> = {
  "Deposit not credited": ["We received 500 HTG instead of the 655 HTG you requested, so your wallet was not credited. Our support team will contact you about the amount we received."],
  "Wallet funded": ["$10.00 added via moncash"],
  "Deposit failed": ["Your moncash payment did not go through."],
  "Withdrawal sent": ["$5.00 sent to natcash"],
  "Withdrawal failed": ["Your withdrawal could not be sent. The money is back in your wallet."],
  "Card funding failed": ["We could not add money to your card. The money is back in your wallet."],
  "Card funded": ["$20.00 added to My card."],
  "Card creation failed": ["We could not create your card. The money is back in your wallet."],
  "Card withdrawal completed": ["$7.50 returned to your wallet."],
  "Card ready": ["My card is active and ready to use."],
  "Card closed": ["My card was closed and can no longer be used.", "My card was closed permanently."],
  "Identity verified": ["Your identity has been confirmed."],
  "Verification declined": ["We could not verify your identity. You can try again."],
  "Email change requested": ["Confirm the change from the link we emailed you. If this was not you, change your password now."],
  "Password changed": ["Your password was changed. If this was not you, contact support now."],
  "Money received": ["Marie sent you $12.00"],
  "Money sent": ["$12.00 sent to Jean", "$12.00 sent to Jean (fee $0.50)"],
  "Dispute submitted": ["DSP-12345 for Money sent"],
  "Balance adjusted": ["$25.00 was added to your wallet by Kasho Pay.", "$10.50 was removed from your wallet by Kasho Pay."],
};

test("every notify() call in src has a French translation", () => {
  let calls = 0;
  const titles = new Set<string>();
  for (const f of readdirSync(new URL("../src/", import.meta.url)).filter((x) => x.endsWith(".ts") && x !== "push.ts")) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const all = (src.match(/\bnotify\(/g) ?? []).length - (/function notify\(/.test(src) ? 1 : 0);
    const lit = [...src.matchAll(/\bnotify\(\s*[^,()]+,\s*"([^"]+)"/g)];
    assert.equal(lit.length, all, `${f}: notify() must be called with a string-literal title`);
    calls += all;
    lit.forEach((m) => titles.add(m[1]!));
  }
  assert.ok(calls >= 20, "found the notify() calls");
  for (const t of titles) {
    assert.ok(SAMPLES[t], `add a sample for notify title "${t}" in scripts/push.test.ts`);
    for (const body of SAMPLES[t]!) {
      const fr = P.pushText(t, body, "fr");
      assert.notEqual(fr.title, t, `French title missing for "${t}"`);
      assert.notEqual(fr.body, body, `French body pattern missing for "${t}": ${body}`);
      assert.deepEqual(P.pushText(t, body, "en"), { title: t, body });
    }
  }
  for (const t of Object.keys(SAMPLES)) assert.ok(titles.has(t), `sample "${t}" is not used by any notify() call`);
});

test("pushText keeps amounts and falls back to English", () => {
  assert.deepEqual(P.pushText("Money received", "Marie sent you $12.00", "fr"), { title: "Argent reçu", body: "Marie vous a envoyé $12.00" });
  assert.deepEqual(P.pushText("Money sent", "$12.00 sent to Jean (fee $0.50)", "fr"), { title: "Argent envoyé", body: "$12.00 envoyés à Jean (frais $0.50)" });
  assert.deepEqual(P.pushText("Wallet funded", "$10.00 added via moncash", "fr"), { title: "Portefeuille rechargé", body: "$10.00 ajoutés via moncash" });
  assert.deepEqual(P.pushText("Brand new thing", "Hello", "fr"), { title: "Brand new thing", body: "Hello" });
  assert.deepEqual(P.pushText("Wallet funded", "unexpected text", "fr"), { title: "Wallet funded", body: "unexpected text" });
});

test("push stays disabled without VAPID keys", async () => {
  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) delete process.env[k];
  assert.equal(P.initPush().configured, false);
  assert.equal(P.pushPublicKey(), null);
  assert.equal(await P.sendPushToUser("00000000-0000-0000-0000-000000000000", { title: "a", body: "b" }), 0);
});
