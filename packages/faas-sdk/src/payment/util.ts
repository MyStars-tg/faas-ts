/**
 * Universal byte/base64/CRC helpers for TON cell + BoC serialization.
 *
 * No dependencies — works in Node ≥18, Deno, Bun, Cloudflare Workers, and
 * browsers (prefers `btoa`/`atob`, falls back to `Buffer`).
 */

/** Encode bytes to standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  if (typeof btoa === "function") return btoa(binary);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  throw new Error("no base64 encoder available in this runtime");
}

/** Decode standard base64 (not url-safe) to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  throw new Error("no base64 decoder available in this runtime");
}

/** CRC32-C (Castagnoli) — TON BoC serialization checksum. */
export function crc32c(data: Uint8Array): number {
  const POLY = 0x82f63b78;
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ POLY : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC16-XMODEM — TON friendly-address checksum (poly 0x1021, init 0x0000). */
export function crc16xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}
