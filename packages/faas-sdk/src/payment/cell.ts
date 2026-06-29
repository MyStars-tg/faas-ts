/**
 * TON text-comment payload (TEP standard comment).
 *
 * Builds a minimal single-cell BoC manually (no `@ton/core`): 32 zero bits
 * (comment opcode 0) + UTF-8 text, serialized with CRC32-C. Ported byte-for-byte
 * from the verified MyStars reference builder. Returns a base64 BoC suitable for a
 * TON Connect message `payload`.
 */

import { MyStarsValidationError } from "../internal/validate.js";
import { bytesToBase64, crc32c } from "./util.js";

/** Max UTF-8 bytes a single-cell op-0 comment can hold: (1023 data bits − 32 opcode bits) / 8. */
export const MAX_COMMENT_BYTES = 123;

/** Build the op-0 text-comment payload for `comment`, as a base64 BoC. */
export function buildCommentPayload(comment: string): string {
  const textBytes = new TextEncoder().encode(comment);
  // A single TON cell holds at most 1023 data bits. This builder is single-cell
  // (no refs/snake encoding), so a longer comment would silently overflow into a
  // corrupt BoC. Refuse loudly — order memos are bare UUIDs (36 bytes), so this
  // only trips on misuse.
  if (32 + textBytes.length * 8 > 1023) {
    throw new MyStarsValidationError(
      `comment is ${textBytes.length} UTF-8 bytes; max ${MAX_COMMENT_BYTES} fit in a single-cell op-0 payload`,
    );
  }
  const totalBits = 32 + textBytes.length * 8;
  const dataBytes = Math.ceil(totalBits / 8);

  const data = new Uint8Array(dataBytes);
  data.set(textBytes, 4); // first 4 bytes are 0 (comment opcode)

  const d1 = 0; // refs_count=0, is_exotic=false, level=0
  const d2Actual = totalBits % 8 === 0 ? (totalBits / 8) * 2 : Math.floor(totalBits / 8) * 2 + 1;

  const cellData = new Uint8Array(Math.ceil(totalBits / 8));
  cellData.set(data.subarray(0, cellData.length));
  if (totalBits % 8 !== 0) {
    const shift = 8 - (totalBits % 8);
    cellData[cellData.length - 1]! |= 1 << (shift - 1);
  }

  const cellPayload = new Uint8Array(2 + cellData.length);
  cellPayload[0] = d1;
  cellPayload[1] = d2Actual;
  cellPayload.set(cellData, 2);

  const cellsSize = cellPayload.length;
  const offsetBytes = 1;
  const headerSize = 4 + 1 + 1 + 1 + 1 + 1 + offsetBytes + 1;
  const boc = new Uint8Array(headerSize + cellsSize + 4);

  let pos = 0;
  boc[pos++] = 0xb5;
  boc[pos++] = 0xee;
  boc[pos++] = 0x9c;
  boc[pos++] = 0x72;
  boc[pos++] = (1 << 6) | offsetBytes; // has_crc32c=true, ref_byte_size=1
  boc[pos++] = offsetBytes;
  boc[pos++] = 1; // cell count
  boc[pos++] = 1; // root count
  boc[pos++] = 0; // absent count
  boc[pos++] = cellsSize; // total cells data size
  boc[pos++] = 0; // root index
  boc.set(cellPayload, pos);
  pos += cellsSize;

  const crc = crc32c(boc.subarray(0, pos));
  boc[pos++] = crc & 0xff;
  boc[pos++] = (crc >> 8) & 0xff;
  boc[pos++] = (crc >> 16) & 0xff;
  boc[pos++] = (crc >> 24) & 0xff;

  return bytesToBase64(boc);
}
