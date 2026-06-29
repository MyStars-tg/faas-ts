import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyWebhookSignature, constructEvent } from "../src/webhook/verify.js";
import { expressWebhook, fastifyWebhook } from "../src/webhook/middleware.js";
import { WebhookSignatureError } from "../src/errors.js";
import type { WebhookEvent } from "../src/types.js";

interface WebhookVectors {
  cases: { name: string; secret: string; body: string; signature: string }[];
  rotation: { secret: string; previous_secret: string; body: string; header: string };
}
const vectors: WebhookVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../contract/webhook-vectors.json", import.meta.url)), "utf8"),
);
const C = vectors.cases[0]!;

describe("verifyWebhookSignature (contract vectors)", () => {
  it("verifies the canonical delivered vector", async () => {
    expect(await verifyWebhookSignature(C.body, C.signature, C.secret)).toBe(true);
  });
  it("rejects a tampered body", async () => {
    expect(await verifyWebhookSignature(C.body + " ", C.signature, C.secret)).toBe(false);
  });
  it("rejects a wrong secret", async () => {
    expect(await verifyWebhookSignature(C.body, C.signature, "wrong-secret")).toBe(false);
  });
  it("rejects a missing/empty header", async () => {
    expect(await verifyWebhookSignature(C.body, null, C.secret)).toBe(false);
    expect(await verifyWebhookSignature(C.body, "", C.secret)).toBe(false);
  });
  it("verifies with EITHER secret during a rotation (comma-joined header)", async () => {
    const r = vectors.rotation;
    expect(await verifyWebhookSignature(r.body, r.header, r.secret)).toBe(true);
    expect(await verifyWebhookSignature(r.body, r.header, r.previous_secret)).toBe(true);
    expect(await verifyWebhookSignature(r.body, r.header, "neither")).toBe(false);
  });
  it("accepts a Uint8Array raw body", async () => {
    expect(await verifyWebhookSignature(new TextEncoder().encode(C.body), C.signature, C.secret)).toBe(true);
  });
});

describe("constructEvent", () => {
  it("returns the typed event on a valid signature", async () => {
    const ev = await constructEvent(C.body, C.signature, C.secret);
    expect(ev.order_id).toBe("order-123");
    expect(ev.status).toBe("delivered");
  });
  it("throws WebhookSignatureError on a bad signature", async () => {
    await expect(constructEvent(C.body, "deadbeef", C.secret)).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it("throws WebhookSignatureError on a non-JSON body", async () => {
    // Sign a non-JSON body so the signature passes but the parse fails.
    const raw = "not json{";
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", C.secret).update(raw, "utf8").digest("hex");
    await expect(constructEvent(raw, sig, C.secret)).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it("throws WebhookSignatureError when status is missing", async () => {
    const raw = JSON.stringify({ order_id: "x" }); // valid JSON, signed, but no status
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", C.secret).update(raw, "utf8").digest("hex");
    await expect(constructEvent(raw, sig, C.secret)).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

interface MockRes {
  statusCode: number;
  body: unknown;
  status(c: number): MockRes;
  code(c: number): MockRes;
  send(b?: unknown): void;
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    code(c: number) {
      this.statusCode = c;
      return this;
    },
    send(b?: unknown) {
      this.body = b;
    },
  };
}

describe("expressWebhook", () => {
  it("verifies, hands the event to onEvent, and replies 200", async () => {
    const events: WebhookEvent[] = [];
    const handler = expressWebhook({ secret: C.secret, onEvent: (e) => void events.push(e) });
    const res = mockRes();
    await handler({ headers: { "x-faas-signature": C.signature }, body: C.body }, res);
    expect(res.statusCode).toBe(200);
    expect(events[0]!.order_id).toBe("order-123");
  });
  it("replies 400 on a bad signature", async () => {
    const handler = expressWebhook({ secret: C.secret, onEvent: () => {} });
    const res = mockRes();
    await handler({ headers: { "x-faas-signature": "bad" }, body: C.body }, res);
    expect(res.statusCode).toBe(400);
  });
  it("replies 400 when the body is a pre-parsed object (raw body required)", async () => {
    const handler = expressWebhook({ secret: C.secret, onEvent: () => {} });
    const res = mockRes();
    await handler({ headers: { "x-faas-signature": C.signature }, body: { order_id: "x" } }, res);
    expect(res.statusCode).toBe(400);
  });
  it("supports a per-request secret resolver", async () => {
    const handler = expressWebhook({ secret: () => C.secret, onEvent: () => {} });
    const res = mockRes();
    await handler({ headers: { "x-faas-signature": C.signature }, body: C.body }, res);
    expect(res.statusCode).toBe(200);
  });
});

describe("fastifyWebhook", () => {
  it("verifies and replies 200", async () => {
    const events: WebhookEvent[] = [];
    const handler = fastifyWebhook({ secret: C.secret, onEvent: (e) => void events.push(e) });
    const reply = mockRes();
    await handler({ headers: { "x-faas-signature": C.signature }, body: C.body }, reply);
    expect(reply.statusCode).toBe(200);
    expect(events[0]!.status).toBe("delivered");
  });
});
