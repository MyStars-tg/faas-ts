/**
 * Drop-in webhook handlers for Express and Fastify.
 *
 * Both verify the `X-Faas-Signature` over the RAW body, parse the event, hand it
 * to your `onEvent`, and reply `2xx` fast (the server needs a 2xx within 5s).
 * They are structurally typed (no `express`/`fastify` runtime dependency), so the
 * SDK stays dependency-free.
 *
 * Dedup is YOUR job — delivery is at-least-once and unordered; key on
 * `event.order_id` (+ `status`).
 */

import { WebhookSignatureError } from "../errors.js";
import type { WebhookEvent } from "../types.js";
import { constructEvent } from "./verify.js";

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Coerce a raw body (Buffer/Uint8Array/string) into the exact bytes the signature covers. */
function rawBodyString(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  // Node Buffer is a Uint8Array, so the check above covers it.
  return undefined;
}

// ─── Express ──────────────────────────────────────────────────────────────

interface ExpressLikeReq {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
}
interface ExpressLikeRes {
  status(code: number): ExpressLikeRes;
  send(body?: unknown): unknown;
}
type ExpressLikeHandler = (req: ExpressLikeReq, res: ExpressLikeRes) => Promise<void>;

/** Options for {@link expressWebhook} / {@link fastifyWebhook} — the secret, the event handler, and an error hook. */
export interface WebhookMiddlewareOptions<Req = unknown> {
  /** The tenant webhook secret, or a function resolving it per-request (e.g. multi-tenant routing). */
  secret: string | ((req: Req) => string | Promise<string>);
  /** Called with the verified, parsed event. Keep it fast; offload heavy work to a queue. */
  onEvent: (event: WebhookEvent, ctx: { rawBody: string; req: Req }) => void | Promise<void>;
  /** Optional hook for signature/handler errors (after the response is sent). */
  onError?: (err: unknown, req: Req) => void;
}

/**
 * Express handler. REQUIRES the raw body — mount with `express.raw({ type: "*\/*" })`
 * (or any raw-body parser) on the webhook route so `req.body`/`req.rawBody` is a
 * Buffer/string, NOT a pre-parsed object.
 */
export function expressWebhook(opts: WebhookMiddlewareOptions<ExpressLikeReq>): ExpressLikeHandler {
  return async (req, res) => {
    const raw = rawBodyString(req.rawBody) ?? rawBodyString(req.body);
    if (raw === undefined) {
      res.status(400).send("raw body required (mount express.raw on this route)");
      return;
    }
    const sig = headerValue(req.headers["x-faas-signature"]);
    try {
      const secret = typeof opts.secret === "function" ? await opts.secret(req) : opts.secret;
      const event = await constructEvent(raw, sig, secret);
      await opts.onEvent(event, { rawBody: raw, req });
      res.status(200).send("ok");
    } catch (err) {
      const status = err instanceof WebhookSignatureError ? 400 : 500;
      res.status(status).send(status === 400 ? "invalid signature" : "handler error");
      opts.onError?.(err, req);
    }
  };
}

// ─── Fastify ────────────────────────────────────────────────────────────────

interface FastifyLikeReq {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
}
interface FastifyLikeReply {
  code(statusCode: number): FastifyLikeReply;
  send(payload?: unknown): unknown;
}
type FastifyLikeHandler = (req: FastifyLikeReq, reply: FastifyLikeReply) => Promise<void>;

/**
 * Fastify handler. REQUIRES the raw body — register a content-type parser that
 * keeps the Buffer (e.g. `addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => done(null, body))`)
 * so `req.body` is a Buffer/string, not a pre-parsed object.
 */
export function fastifyWebhook(opts: WebhookMiddlewareOptions<FastifyLikeReq>): FastifyLikeHandler {
  return async (req, reply) => {
    const raw = rawBodyString(req.rawBody) ?? rawBodyString(req.body);
    if (raw === undefined) {
      reply.code(400).send("raw body required (use a buffer content-type parser)");
      return;
    }
    const sig = headerValue(req.headers["x-faas-signature"]);
    try {
      const secret = typeof opts.secret === "function" ? await opts.secret(req) : opts.secret;
      const event = await constructEvent(raw, sig, secret);
      await opts.onEvent(event, { rawBody: raw, req });
      reply.code(200).send("ok");
    } catch (err) {
      const status = err instanceof WebhookSignatureError ? 400 : 500;
      reply.code(status).send(status === 400 ? "invalid signature" : "handler error");
      opts.onError?.(err, req);
    }
  };
}
