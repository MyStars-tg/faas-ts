/**
 * Jetton (USDT) transfer payload builder — TEP-74.
 *
 * Ported byte-for-byte from the verified MyStars reference builder. Manually
 * builds TON cells + serializes to BoC (no `@ton/core`), so it runs in every runtime.
 *
 * The signed jetton message goes to the PAYER's own USDT jetton wallet; the FaaS
 * treasury owner (`pay_to_address`) is the `destination` field INSIDE the body,
 * and the order memo (bare UUID) is the op-0 comment in the forward payload.
 */

import { MyStarsValidationError } from "../internal/validate.js";
import { base64ToBytes, bytesToBase64, crc16xmodem, crc32c } from "./util.js";

/** Max UTF-8 bytes the single-cell op-0 forward-payload memo can hold: (1023 − 32) / 8. */
export const MAX_MEMO_BYTES = 123;

/** `forward_ton_amount` carried inside the transfer (0 — the memo still survives in internal_transfer). */
export const FORWARD_TON_AMOUNT_NANO = BigInt(0);
/** Jetton transfer opcode (TEP-74). */
export const JETTON_TRANSFER_OP = 0xf8a7ea5;

/** Bit-level cell data builder. Accumulates bits MSB-first and flushes complete bytes. */
export class BitBuilder {
  private fullBytes: number[] = [];
  private currentByte = 0;
  private bitPos = 0;

  storeUint(value: number | bigint, bits: number): this {
    const v = BigInt(value);
    for (let i = bits - 1; i >= 0; i--) {
      const bit = Number((v >> BigInt(i)) & BigInt(1));
      this.currentByte = (this.currentByte << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.fullBytes.push(this.currentByte);
        this.currentByte = 0;
        this.bitPos = 0;
      }
    }
    return this;
  }

  storeBit(bit: 0 | 1): this {
    return this.storeUint(bit, 1);
  }

  /** Store a Coins value (VarUInteger 16): 4-bit byte-length prefix + big-endian bytes. Zero → 4 zero bits. */
  storeCoins(amount: bigint): this {
    if (amount === BigInt(0)) return this.storeUint(0, 4);
    const hex = amount.toString(16);
    const byteLen = Math.ceil(hex.length / 2);
    this.storeUint(byteLen, 4);
    const padded = hex.padStart(byteLen * 2, "0");
    for (let i = 0; i < byteLen; i++) {
      this.storeUint(parseInt(padded.slice(i * 2, i * 2 + 2), 16), 8);
    }
    return this;
  }

  /** Store MsgAddress std (addr_std$10). Accepts friendly (base64url) or raw (`wc:hex`) forms. */
  storeAddress(address: string): this {
    const { workchain, hash } = parseTonAddress(address);
    this.storeUint(0b10, 2);
    this.storeBit(0);
    this.storeUint(workchain < 0 ? 256 + workchain : workchain, 8);
    for (const byte of hash) this.storeUint(byte, 8);
    return this;
  }

  /** Store a UTF-8 string as raw bytes (no length prefix). */
  storeStringTail(text: string): this {
    const bytes = new TextEncoder().encode(text);
    for (const byte of bytes) this.storeUint(byte, 8);
    return this;
  }

  get totalBits(): number {
    return this.fullBytes.length * 8 + this.bitPos;
  }

  finalize(): { data: Uint8Array; bits: number } {
    const bits = this.totalBits;
    const byteLen = Math.ceil(bits / 8);
    const result = new Uint8Array(byteLen);
    for (let i = 0; i < this.fullBytes.length; i++) result[i] = this.fullBytes[i]!;
    if (this.bitPos > 0) result[this.fullBytes.length] = this.currentByte << (8 - this.bitPos);
    return { data: result, bits };
  }
}

/** Parse a TON address (friendly base64url or raw `wc:hex`) into workchain + 32-byte hash. Throws on a bad checksum/shape. */
export function parseTonAddress(address: string): { workchain: number; hash: Uint8Array } {
  if (address.includes(":")) {
    const colonIdx = address.indexOf(":");
    const wc = address.slice(0, colonIdx);
    const hashHex = address.slice(colonIdx + 1);
    if (!/^-?\d+$/.test(wc)) throw new Error(`Invalid TON address: bad workchain "${wc}"`);
    const workchain = Number(wc);
    if (workchain !== 0 && workchain !== -1) {
      throw new Error(`Invalid TON address: workchain must be 0 or -1, got ${workchain}`);
    }
    if (!hashHex || hashHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hashHex)) {
      throw new Error("Invalid TON address: hash must be 64 hex characters");
    }
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hash[i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
    return { workchain, hash };
  }

  const standard = address.replace(/-/g, "+").replace(/_/g, "/");
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(standard);
  } catch {
    throw new Error("Invalid TON address: not valid base64");
  }
  if (bytes.length !== 36) throw new Error(`Invalid TON address: expected 36 bytes, got ${bytes.length}`);

  const payload = bytes.subarray(0, 34);
  const expectedCrc = (bytes[34]! << 8) | bytes[35]!;
  const actualCrc = crc16xmodem(payload);
  if (expectedCrc !== actualCrc) {
    throw new Error(
      `Invalid TON address: checksum mismatch (expected ${expectedCrc.toString(16)}, got ${actualCrc.toString(16)})`,
    );
  }
  const workchain = bytes[1]! > 127 ? bytes[1]! - 256 : bytes[1]!;
  const hash = bytes.slice(2, 34);
  return { workchain, hash };
}

function serializeCell(data: Uint8Array, bits: number, refIndices: number[]): Uint8Array {
  const dataLen = Math.ceil(bits / 8);
  const d1 = refIndices.length;
  const d2 = bits % 8 === 0 ? (bits / 8) * 2 : Math.floor(bits / 8) * 2 + 1;

  const cellData = new Uint8Array(dataLen);
  cellData.set(data.subarray(0, dataLen));
  if (bits % 8 !== 0) {
    const remaining = bits % 8;
    cellData[dataLen - 1]! |= 1 << (8 - remaining - 1);
  }

  const result = new Uint8Array(2 + dataLen + refIndices.length);
  result[0] = d1;
  result[1] = d2;
  result.set(cellData, 2);
  for (let i = 0; i < refIndices.length; i++) result[2 + dataLen + i] = refIndices[i]!;
  return result;
}

function serializeBoC(cells: Uint8Array[]): string {
  const cellCount = cells.length;
  const totalCellsSize = cells.reduce((sum, c) => sum + c.length, 0);
  const offsetBytes = totalCellsSize < 256 ? 1 : 2;
  const refByteSize = 1;

  const headerSize = 4 + 1 + 1 + refByteSize * 3 + offsetBytes + refByteSize;
  const boc = new Uint8Array(headerSize + totalCellsSize + 4);

  let pos = 0;
  boc[pos++] = 0xb5;
  boc[pos++] = 0xee;
  boc[pos++] = 0x9c;
  boc[pos++] = 0x72;
  boc[pos++] = (1 << 6) | refByteSize;
  boc[pos++] = offsetBytes;
  boc[pos++] = cellCount;
  boc[pos++] = 1;
  boc[pos++] = 0;
  if (offsetBytes === 2) boc[pos++] = (totalCellsSize >> 8) & 0xff;
  boc[pos++] = totalCellsSize & 0xff;
  boc[pos++] = 0;

  for (const cell of cells) {
    boc.set(cell, pos);
    pos += cell.length;
  }

  const crc = crc32c(boc.subarray(0, pos));
  boc[pos++] = crc & 0xff;
  boc[pos++] = (crc >> 8) & 0xff;
  boc[pos++] = (crc >> 16) & 0xff;
  boc[pos++] = (crc >> 24) & 0xff;

  return bytesToBase64(boc);
}

/**
 * Build the TEP-74 jetton transfer BoC payload (base64).
 *
 * @param amountMicro - jetton amount in micro-units (e.g. "4990000" for 4.99 USDT)
 * @param destination - the recipient OWNER address (the FaaS `pay_to_address`), raw or friendly
 * @param sender - the payer's wallet address (`response_destination`), raw or friendly
 * @param memo - the bare order UUID (op-0 comment in the forward payload)
 */
export function buildJettonTransferPayload(
  amountMicro: string | bigint,
  destination: string,
  sender: string,
  memo: string,
): string {
  // The forward-payload memo lives in a single op-0 ref cell (1023-bit max). A
  // longer memo would overflow into a corrupt BoC — refuse loudly. Order memos
  // are bare UUIDs (36 bytes), so this only trips on misuse.
  const memoBytes = new TextEncoder().encode(memo).length;
  if (32 + memoBytes * 8 > 1023) {
    throw new MyStarsValidationError(
      `memo is ${memoBytes} UTF-8 bytes; max ${MAX_MEMO_BYTES} fit in a single-cell op-0 forward payload`,
    );
  }
  const refBuilder = new BitBuilder();
  refBuilder.storeUint(0, 32).storeStringTail(memo);
  const refCell = refBuilder.finalize();
  const serializedRef = serializeCell(refCell.data, refCell.bits, []);

  const bodyBuilder = new BitBuilder();
  bodyBuilder
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(0, 64)
    .storeCoins(BigInt(amountMicro))
    .storeAddress(destination)
    .storeAddress(sender)
    .storeBit(0)
    .storeCoins(FORWARD_TON_AMOUNT_NANO)
    .storeBit(1);
  const bodyCell = bodyBuilder.finalize();
  const serializedBody = serializeCell(bodyCell.data, bodyCell.bits, [1]);

  return serializeBoC([serializedBody, serializedRef]);
}
