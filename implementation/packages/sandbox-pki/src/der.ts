/**
 * A minimal ASN.1 DER encoder and decoder — exactly what the sandbox's certificates, CRLs and
 * certification requests need, and nothing else.
 *
 * Written instead of taking a dependency (specification Q-S6, decided by the user on 12 November
 * 2026): the repository signs everything with `node:crypto`, and owning the encoder lets the
 * sandbox build the deliberately defective certificates of its catalogue without fighting a
 * library that refuses to. Every structure built with it is checked in the tests by Node's own
 * `X509Certificate` and by `openssl`, so a wrong byte fails the build rather than a wallet run.
 *
 * DER (ITU-T X.690 §10): definite lengths, minimal length octets, minimal integer encoding.
 */

export const Tag = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** An encoded element: tag, length and value, ready to be concatenated into a parent. */
export type Der = Buffer;

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Any element, from its tag octet and its content octets. */
export function tlv(tag: number, content: Buffer): Der {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const sequence = (...items: Der[]): Der => tlv(Tag.SEQUENCE, Buffer.concat(items));

/** A SET OF, sorted as DER requires (X.690 §11.6) — by the encodings, as octet strings. */
export const setOf = (...items: Der[]): Der =>
  tlv(Tag.SET, Buffer.concat([...items].sort(Buffer.compare)));

export const nullValue = (): Der => tlv(Tag.NULL, Buffer.alloc(0));

export const boolean = (value: boolean): Der =>
  tlv(Tag.BOOLEAN, Buffer.from([value ? 0xff : 0x00]));

/**
 * A non-negative INTEGER from its big-endian magnitude. Leading zero octets are removed and one is
 * added back when the top bit is set, so the value is never read as negative.
 */
export function unsignedInteger(magnitude: Buffer): Der {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  let bytes = magnitude.subarray(start);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(Tag.INTEGER, bytes);
}

export function integer(value: number | bigint): Der {
  const big = BigInt(value);
  if (big < 0n) throw new RangeError("negative INTEGER values are not used by the sandbox");
  let hex = big.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return unsignedInteger(Buffer.from(hex, "hex"));
}

function base128(value: bigint): number[] {
  const out = [Number(value & 0x7fn)];
  let rest = value >> 7n;
  while (rest > 0n) {
    out.unshift(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  return out;
}

/** An OBJECT IDENTIFIER from its dotted form. Arcs are BigInt-safe, for the `2.25.<UUID>` arc. */
export function oid(dotted: string): Der {
  if (!/^[0-2](\.(0|[1-9][0-9]*))+$/.test(dotted)) throw new Error(`not an OID: ${dotted}`);
  const arcs = dotted.split(".").map((arc) => BigInt(arc));
  const [first, second, ...rest] = arcs as [bigint, bigint, ...bigint[]];
  if (first < 2n && second > 39n) throw new Error(`invalid second arc in ${dotted}`);
  const bytes = [...base128(first * 40n + second), ...rest.flatMap(base128)];
  return tlv(Tag.OID, Buffer.from(bytes));
}

const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/;

export function printableString(value: string): Der {
  if (!PRINTABLE.test(value)) throw new Error("value is not a PrintableString");
  return tlv(Tag.PRINTABLE_STRING, Buffer.from(value, "ascii"));
}

export const utf8String = (value: string): Der =>
  tlv(Tag.UTF8_STRING, Buffer.from(value, "utf8"));

export function ia5String(value: string): Der {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: IA5 is exactly the 7-bit range.
  if (!/^[\x00-\x7f]*$/.test(value)) throw new Error("value is not an IA5String");
  return tlv(Tag.IA5_STRING, Buffer.from(value, "ascii"));
}

export const octetString = (value: Buffer): Der => tlv(Tag.OCTET_STRING, value);

/** A BIT STRING carrying whole octets (a signature, a public key). */
export const bitString = (value: Buffer): Der =>
  tlv(Tag.BIT_STRING, Buffer.concat([Buffer.from([0]), value]));

/**
 * A BIT STRING of named bits (KeyUsage), DER-minimal: trailing zero bits removed and the count of
 * unused bits in the last octet stated (X.690 §11.2.2).
 */
export function namedBits(bits: readonly number[]): Der {
  if (bits.length === 0) return tlv(Tag.BIT_STRING, Buffer.from([0]));
  const highest = Math.max(...bits);
  const bytes = Buffer.alloc(Math.floor(highest / 8) + 1);
  for (const bit of bits) {
    const index = Math.floor(bit / 8);
    bytes[index] = (bytes[index] ?? 0) | (0x80 >> (bit % 8));
  }
  const unused = 7 - (highest % 8);
  return tlv(Tag.BIT_STRING, Buffer.concat([Buffer.from([unused]), bytes]));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * A Time as RFC 5280 §4.1.2.5 requires: UTCTime through 2049, GeneralizedTime from 2050, always in
 * UTC with seconds and no fraction.
 */
export function time(at: Date): Der {
  const year = at.getUTCFullYear();
  const rest =
    pad(at.getUTCMonth() + 1) +
    pad(at.getUTCDate()) +
    pad(at.getUTCHours()) +
    pad(at.getUTCMinutes()) +
    pad(at.getUTCSeconds());
  if (year >= 1950 && year < 2050) {
    return tlv(Tag.UTC_TIME, Buffer.from(`${pad(year % 100)}${rest}Z`, "ascii"));
  }
  return tlv(Tag.GENERALIZED_TIME, Buffer.from(`${pad(year, 4)}${rest}Z`, "ascii"));
}

/** `[n] EXPLICIT` — a constructed context tag wrapping one complete element. */
export const explicit = (n: number, inner: Der): Der => tlv(0xa0 | n, inner);

/** `[n] IMPLICIT` over a primitive type: the content octets under a context tag. */
export const implicitPrimitive = (n: number, content: Buffer): Der => tlv(0x80 | n, content);

/** `[n] IMPLICIT` over a constructed type (SEQUENCE OF, SET OF): its content under a context tag. */
export const implicitConstructed = (n: number, ...items: Der[]): Der =>
  tlv(0xa0 | n, Buffer.concat(items));

// --- Decoding --------------------------------------------------------------------------------

export interface Element {
  readonly tag: number;
  /** The whole element, header included — what a signature is computed over. */
  readonly raw: Buffer;
  readonly content: Buffer;
}

/**
 * Read one element at `offset`. Strict: indefinite lengths, non-minimal lengths and lengths that
 * run past the input are refused, because an uploaded request is attacker-controlled.
 */
export function readElement(input: Buffer, offset = 0): Element {
  const tag = input[offset];
  if (tag === undefined) throw new Error("DER: unexpected end of input");
  if ((tag & 0x1f) === 0x1f) throw new Error("DER: high tag numbers are not supported");
  const first = input[offset + 1];
  if (first === undefined) throw new Error("DER: unexpected end of input");
  let length: number;
  let header = 2;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new Error("DER: indefinite length");
    if (count > 4) throw new Error("DER: length too large");
    length = 0;
    for (let i = 0; i < count; i++) {
      const byte = input[offset + 2 + i];
      if (byte === undefined) throw new Error("DER: unexpected end of input");
      if (i === 0 && byte === 0) throw new Error("DER: non-minimal length");
      length = length * 256 + byte;
    }
    if (length < 0x80) throw new Error("DER: non-minimal length");
    header += count;
  }
  const end = offset + header + length;
  if (end > input.length) throw new Error("DER: length runs past the input");
  return {
    tag,
    raw: input.subarray(offset, end),
    content: input.subarray(offset + header, end),
  };
}

/** The children of a constructed element, which must fill its content exactly. */
export function children(element: Element): Element[] {
  if ((element.tag & 0x20) === 0) throw new Error("DER: not a constructed element");
  const out: Element[] = [];
  let offset = 0;
  while (offset < element.content.length) {
    const child = readElement(element.content, offset);
    out.push(child);
    offset += child.raw.length;
  }
  return out;
}

/** Decode a whole input that must be exactly one element. */
export function decode(input: Buffer): Element {
  const element = readElement(input, 0);
  if (element.raw.length !== input.length) throw new Error("DER: trailing data");
  return element;
}

export function decodeOid(element: Element): string {
  if (element.tag !== Tag.OID) throw new Error("DER: not an OID");
  const arcs: bigint[] = [];
  let value = 0n;
  for (const byte of element.content) {
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0n;
    }
  }
  const [head, ...rest] = arcs;
  if (head === undefined) throw new Error("DER: empty OID");
  const first = head < 80n ? head / 40n : 2n;
  return [first, head - first * 40n, ...rest].join(".");
}
