/**
 * Base64url without padding (RFC 4648 §5). Written here because Hermes, the browser and
 * Node disagree on what they offer (`atob` works on binary strings, `Buffer` is Node only).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeBase64url(bytes: Uint8Array): string {
  let result = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    result +=
      ALPHABET.charAt(chunk >> 18) +
      ALPHABET.charAt((chunk >> 12) & 63) +
      ALPHABET.charAt((chunk >> 6) & 63) +
      ALPHABET.charAt(chunk & 63);
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const chunk = (bytes[index] ?? 0) << 16;
    result += ALPHABET.charAt(chunk >> 18) + ALPHABET.charAt((chunk >> 12) & 63);
  } else if (rest === 2) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    result +=
      ALPHABET.charAt(chunk >> 18) +
      ALPHABET.charAt((chunk >> 12) & 63) +
      ALPHABET.charAt((chunk >> 6) & 63);
  }
  return result;
}

/**
 * The decode table pre-shifted for each of the four characters of a group, indexed by character
 * code (0–255), so a group of four becomes its 24 bits with four reads and three ORs: an invalid
 * character is -1 in every table, and -1 ORed with anything stays negative. In Hermes, without a
 * JIT, a function call per character cost more than the decoding itself (ADR-008 §7, 15/11/2026):
 * the reads are inline, and the character codes come in one native call (`charCodes`).
 */
const SHIFTED: readonly [Int32Array, Int32Array, Int32Array, Int32Array] = [18, 12, 6, 0].map(
  (shift) => {
    const table = new Int32Array(256).fill(-1);
    for (let index = 0; index < ALPHABET.length; index++) {
      table[ALPHABET.charCodeAt(index)] = index << shift;
    }
    return table;
  },
) as unknown as [Int32Array, Int32Array, Int32Array, Int32Array];

/** `TextEncoder`, where the runtime has one (Hermes, browsers, Node); the lib types leave it out. */
interface Utf8Encoder {
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}
const encoder: Utf8Encoder | null = (() => {
  const Encoder = (globalThis as { TextEncoder?: new () => Utf8Encoder }).TextEncoder;
  return typeof Encoder === 'function' ? new Encoder() : null;
})();

/** Reused buffer of character codes, grown as needed. */
let codeBuffer = new Uint8Array(1024);

/**
 * The codes of the characters `from` to `to` of `text`, one byte each, from index 0 of the
 * returned buffer. A character outside ASCII gives bytes of 0x80 or more (UTF-8), which the
 * tables reject, and any byte left unwritten is 0, which they reject too: so the result is only
 * trusted where it decodes. With `TextEncoder` it is one native call instead of one per character.
 */
function charCodes(text: string, from: number, to: number): Uint8Array {
  const length = to - from;
  if (codeBuffer.length < length)
    codeBuffer = new Uint8Array(Math.max(length, codeBuffer.length * 2));
  const codes = codeBuffer;
  if (encoder) {
    const view = codes.subarray(0, length);
    const { read, written } = encoder.encodeInto(text.substring(from, to), view);
    // Fewer bytes than characters: a character outside ASCII stopped the copy short of the end.
    if (written < length) view.fill(0, written);
    else if (read < length) view.fill(0);
  } else {
    for (let index = 0; index < length; index++) {
      const code = text.charCodeAt(from + index);
      codes[index] = code < 0x80 ? code : 0;
    }
  }
  return codes;
}

/** Bytes that `text` decodes to, or -1 for an impossible length. */
export function base64urlByteLength(text: string): number {
  return text.length % 4 === 1 ? -1 : Math.floor((text.length * 3) / 4);
}

/**
 * Decodes the characters `from` to `to` of `text` into `bytes` (at `from / 4 * 3`), so a long
 * string can be decoded a part at a time (`PointsDecoder`). `from` is a multiple of 4, and so is
 * `to` unless it is the end of the text; the caller checks the length with `base64urlByteLength`
 * first. False for a character outside the alphabet, an impossible last group of one character
 * or, in the last group, non-zero trailing bits.
 */
export function decodeBase64urlInto(
  text: string,
  bytes: Uint8Array,
  from: number,
  to: number,
): boolean {
  const [t18, t12, t6, t0] = SHIFTED;
  const codes = charCodes(text, from, to);
  const whole = (to === text.length ? to - (to % 4) : to) - from;
  let written = (from / 4) * 3;
  // The `??` never apply (the loop bounds and the 256-entry tables) but cost no call. Checked in
  // Hermes bytecode like the points loop (a test of the app's compiled bundle).
  // hermes-hot-loop: decodeBase64urlInto
  for (let index = 0; index < whole; index += 4) {
    const chunk =
      (t18[codes[index] ?? 0] ?? -1) |
      (t12[codes[index + 1] ?? 0] ?? -1) |
      (t6[codes[index + 2] ?? 0] ?? -1) |
      (t0[codes[index + 3] ?? 0] ?? -1);
    if (chunk < 0) return false;
    bytes[written] = chunk >> 16;
    bytes[written + 1] = (chunk >> 8) & 0xff;
    bytes[written + 2] = chunk & 0xff;
    written += 3;
  }
  // hermes-hot-loop-end
  const rest = to - from - whole;
  if (rest === 1) return false;
  if (rest === 2) {
    const chunk = (t18[codes[whole] ?? 0] ?? -1) | (t12[codes[whole + 1] ?? 0] ?? -1);
    // Leftover bits must be zero padding: 12 bits read, 8 kept.
    if (chunk < 0 || (chunk & 0xffff) !== 0) return false;
    bytes[written] = chunk >> 16;
  } else if (rest === 3) {
    const chunk =
      (t18[codes[whole] ?? 0] ?? -1) |
      (t12[codes[whole + 1] ?? 0] ?? -1) |
      (t6[codes[whole + 2] ?? 0] ?? -1);
    // 18 bits read, 16 kept.
    if (chunk < 0 || (chunk & 0xff) !== 0) return false;
    bytes[written] = chunk >> 16;
    bytes[written + 1] = (chunk >> 8) & 0xff;
  }
  return true;
}

/**
 * Returns null for a character outside the alphabet, padding, an impossible length, or
 * non-zero trailing bits (so every byte string has exactly one encoding).
 */
export function decodeBase64url(text: string): Uint8Array | null {
  const length = base64urlByteLength(text);
  if (length < 0) return null;
  const bytes = new Uint8Array(length);
  return decodeBase64urlInto(text, bytes, 0, text.length) ? bytes : null;
}
