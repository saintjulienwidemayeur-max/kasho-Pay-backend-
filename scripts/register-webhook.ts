// Registers the Freda webhook (POST /v1/webhooks) and prints the whsec_ secret (shown only once).
// Usage: npm run webhook:register -- https://your-public-backend.example.com
import "../src/env.js";
import { freda } from "../src/freda.js";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[^\s]+$/.test(base)) {
  console.error("Usage: npm run webhook:register -- https://<public https URL of this backend>\n(Locally use a tunnel such as ngrok or cloudflared.)");
  process.exit(1);
}
const url = `${base}/api/webhooks/freda`;
// The call helper is not exported for arbitrary paths, so reach it through a tiny local request.
const key = process.env["FREDA_API_KEY"]!;
const apiBase = (process.env["FREDA_API_BASE"] ?? "https://api.fredapay.com").replace(/\/+$/, "");
void freda;
const res = await fetch(`${apiBase}/v1/webhooks`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url }),
});
const body: any = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error("Freda refused:", res.status, body?.error?.message ?? body);
  process.exit(1);
}
const secret = body?.secret ?? body?.data?.secret ?? body?.webhook?.secret;
console.log(`Webhook registered: ${url}`);
console.log(secret ? `Put this in .env (shown only once):\nFREDA_WEBHOOK_SECRET=${secret}` : `Response: ${JSON.stringify(body)}`);
