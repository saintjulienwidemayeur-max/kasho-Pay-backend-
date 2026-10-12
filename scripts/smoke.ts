// Quick check of a running backend:  npm run smoke
import "../src/env.js";
const base = `http://localhost:${process.env["PORT"] ?? 4000}`;

async function main() {
  let ok = true;
  const check = (name: string, pass: boolean, extra = "") => {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    if (!pass) ok = false;
  };

  const h = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  check("GET /health", !!h?.ok, JSON.stringify(h));

  const r = await fetch(`${base}/api/getPublicConfig`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("API rejects requests without a token (401)", r.status === 401, `status ${r.status}`);

  const r2 = await fetch(`${base}/api/getPublicConfig`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" }, body: "{}",
  });
  check("API rejects a fake token (401)", r2.status === 401, `status ${r2.status}`);

  // ---- security probes (no login needed)
  const hdr = await fetch(`${base}/health`).catch(() => null);
  check("Security headers present (nosniff, frame deny)", hdr?.headers.get("x-content-type-options") === "nosniff" && hdr?.headers.get("x-frame-options") === "DENY");
  check("X-Powered-By hidden", !hdr?.headers.get("x-powered-by"));

  const wrongType = await fetch(`${base}/api/getPublicConfig`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  check("Non-JSON body refused (415)", wrongType.status === 415, `status ${wrongType.status}`);

  const proto = await fetch(`${base}/api/constructor`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token-123" }, body: "{}" });
  check("/api/constructor does not crash the server (401)", proto.status === 401, `status ${proto.status}`);
  const alive = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
  check("Server still alive after prototype probe", alive);

  const badJson = await fetch(`${base}/api/getPublicConfig`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  const badText = await badJson.text();
  check("Malformed JSON gives a clean error, no stack trace", badJson.status < 500 && !/at .*\.(js|ts):\d+/.test(badText), `status ${badJson.status}`);

  const evil = await fetch(`${base}/health`, { headers: { Origin: "https://evil.example" } });
  check("Unknown origin gets no CORS permission", evil.headers.get("access-control-allow-origin") === null);

  const hook = await fetch(`${base}/api/webhooks/freda`, { method: "POST", headers: { "Content-Type": "application/json", "X-Freda-Signature": "sha256=deadbeef" }, body: '{"event":"payment.succeeded"}' });
  check("Webhook with a bad signature refused (401)", hook.status === 401, `status ${hook.status}`);

  let limited = 0;
  for (let i = 0; i < 130; i++) {
    const r = await fetch(`${base}/api/getPublicConfig`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token-123" }, body: "{}" });
    if (r.status === 429) { limited++; break; }
  }
  check("Rate limiting kicks in (429)", limited > 0, limited ? "" : "no 429 after 130 requests (limit is 300/min per IP, run again to hit it)");

  const key = process.env["FREDA_API_KEY"] ?? "";
  check("FREDA_API_KEY looks set", key.startsWith("sk_test_") || key.startsWith("sk_live_"));
  if (key.startsWith("sk_")) {
    const b = await fetch(`${process.env["FREDA_API_BASE"] ?? "https://api.fredapay.com"}/v1/balance`, { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
    check("Freda API reachable and key accepted (GET /v1/balance)", !!b && b.ok, b ? `status ${b.status}` : "no response");
  }

  const sb = await fetch(`${process.env["SUPABASE_URL"]}/rest/v1/wallets?select=user_id&limit=1`, {
    headers: { apikey: process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "", Authorization: `Bearer ${process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? ""}` },
  }).catch(() => null);
  check("Supabase tables exist (migration was run)", !!sb && sb.ok, sb ? `status ${sb.status}` : "no response");

  process.exit(ok ? 0 : 1);
}
main();
