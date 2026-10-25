// Prints a fresh VAPID key pair as env lines. Nothing is written to disk. Run: npm run vapid:generate
import webpush from "web-push";

const k = webpush.generateVAPIDKeys();
console.log("# Add these three variables to your environment (Render dashboard / .env). Keep the private key secret.");
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
console.log("VAPID_SUBJECT=mailto:support@your-domain.example");
