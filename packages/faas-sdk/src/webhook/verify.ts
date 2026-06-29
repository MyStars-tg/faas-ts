/**
 * Webhook signature verification.
 *
 * Reimplements the server's webhook signing byte-for-byte: the `X-Faas-Signature`
 * header is the lowercase-hex HMAC-SHA256 of the RAW request body under the tenant's
 * webhook secret — no timestamp. During a 24h secret rotation the header is two
 * comma-joined signatures (`"<current>,<previous>"`); we split on `,` and
 * constant-time-compare each, so verification holds with EITHER secret.
 *
 * Universal: prefers Web Crypto (`globalThis.crypto.subtle`) so it runs in Deno,
 * Bun, Cloudflare Workers, and browsers; on default Node 18 (where the global is
 * absent) it falls back to `node:crypto`'s `webcrypto`. The verifier is therefore async.
 */

import { WebhookSignatureError } from "../errors.js";
import type { WebhookEvent } from "../types.js";

async function getSubtle(): Promise<SubtleCrypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.subtle) return c.subtle;
  // Default Node 18 doesn't expose globalThis.crypto (unflagged only from v19/v20),
  // so fall back to node:crypto's webcrypto. The dynamic import keeps the browser
  // bundle clean and is only reached when the global is absent (never in a browser).
  try {
    const nodeCrypto = (await import("node:crypto")) as { webcrypto?: { subtle?: SubtleCrypto } };
    if (nodeCrypto.webcrypto?.subtle) return nodeCrypto.webcrypto.subtle;
  } catch {
    // not a Node runtime — fall through to the error below
  }
  throw new Error("Web Crypto (globalThis.crypto.subtle) is unavailable in this runtime");
}

/** Lowercase-hex HMAC-SHA256 of `body` under `secret`. */
async function hmacSha256Hex(secret: string, body: string | Uint8Array): Promise<string> {
  const subtle = await getSubtle();
  const enc = new TextEncoder();
  // Inline the conversion so inference yields an ArrayBuffer-backed Uint8Array
  // (Web Crypto's BufferSource won't accept a SharedArrayBuffer-backed view).
  const data = typeof body === "string" ? enc.encode(body) : new Uint8Array(body);
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await subtle.sign("HMAC", key, data);
  const out = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < out.length; i++) hex += out[i]!.toString(16).padStart(2, "0");
  return hex;
}

/** Constant-time compare of two equal-length hex strings. */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify an `X-Faas-Signature` header against the raw webhook body.
 * Handles the single-signature and the `"current,previous"` rotation forms.
 */
export async function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  let matched = false;
  for (const part of signatureHeader.split(",")) {
    // No early exit — compare against every candidate to avoid leaking which matched.
    if (timingSafeHexEqual(expected, part.trim())) matched = true;
  }
  return matched;
}

/**
 * Verify the signature, then JSON-parse the body into a typed {@link WebhookEvent}.
 * Throws {@link WebhookSignatureError} on a bad/missing signature or unparseable body.
 *
 * IMPORTANT: pass the RAW request bytes/string (verify before any framework
 * re-serializes the JSON), and dedup on `event.order_id` — delivery is
 * at-least-once and unordered.
 */
export async function constructEvent(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<WebhookEvent> {
  const ok = await verifyWebhookSignature(rawBody, signatureHeader, secret);
  if (!ok) throw new WebhookSignatureError("webhook signature verification failed");
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WebhookSignatureError("webhook body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WebhookSignatureError("webhook body is not a JSON object");
  }
  const obj = parsed as { order_id?: unknown; status?: unknown };
  if (typeof obj.order_id !== "string") throw new WebhookSignatureError("webhook body is missing order_id");
  // `status` is left un-enumerated for forward-compat, but must be present + a string.
  if (typeof obj.status !== "string") throw new WebhookSignatureError("webhook body is missing status");
  return parsed as WebhookEvent;
}
