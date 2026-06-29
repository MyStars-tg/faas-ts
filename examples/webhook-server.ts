/**
 * Minimal webhook receiver — verifies the X-Faas-Signature over the RAW body and
 * dedups on order_id (delivery is at-least-once).
 *
 * Uses only Node's built-in http server (zero extra deps). For Express/Fastify use the
 * exported `expressWebhook` / `fastifyWebhook` adapters instead — see the package README.
 *
 * Run:
 *   MYSTARS_WEBHOOK_SECRET=… npx tsx examples/webhook-server.ts
 */
import { createServer } from "node:http";
import { constructEvent, WebhookSignatureError } from "@mystars-tg/faas-sdk";

const secret = process.env.MYSTARS_WEBHOOK_SECRET;
if (!secret) throw new Error("set MYSTARS_WEBHOOK_SECRET");

// Replace with a durable store — delivery is at-least-once, so dedup on order_id.
const seen = new Set<string>();

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks/mystars") {
    res.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    // Node types a header as string | string[]; X-Faas-Signature is single-valued.
    const sigHeader = req.headers["x-faas-signature"];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    try {
      // constructEvent verifies the signature (handling the 24h "current,previous"
      // rotation header) BEFORE you trust the body. Never act on an unverified payload.
      const event = await constructEvent(rawBody, signature, secret);
      if (!seen.has(event.order_id)) {
        seen.add(event.order_id);
        console.log("order", event.order_id, "→", event.status, event.purchase_tx ?? "");
        // … advance your own order state here …
      }
      res.writeHead(200).end("ok");
    } catch (err) {
      // A bad/missing signature is a 400; anything else is a 500.
      res.writeHead(err instanceof WebhookSignatureError ? 400 : 500).end();
    }
  });
});

server.listen(8080, () => console.log("listening on http://localhost:8080/webhooks/mystars"));
