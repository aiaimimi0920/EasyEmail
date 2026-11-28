import { Buffer } from "node:buffer";

export interface MuseTransportFrame {
  chunkId: bigint;
  chunkIndex: number;
  totalChunks: number;
  payload: Uint8Array;
}

export interface MuseHeaderKV {
  key: string;
  value: string;
}

export interface MuseAppRequestMsg {
  verb: string;
  path: string;
  headers: MuseHeaderKV[];
  body?: Uint8Array;
  endBody: boolean;
}

export interface MuseAppResponseMsg {
  status: number;
  headers: MuseHeaderKV[];
  body: Uint8Array;
  endBody: boolean;
}

export interface MuseBodyChunkMsg {
  data: Uint8Array;
  endBody: boolean;
}

export interface MuseResetMsg {
  code: number;
  reason: string;
}

export interface MuseServiceFrameMsg {
  streamId: bigint;
  response?: MuseAppResponseMsg;
  bodyChunk?: MuseBodyChunkMsg;
  reset?: MuseResetMsg;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

function appendVarint(out: number[], value: bigint): void {
  let v = BigInt.asUintN(64, value);
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

function appendTag(out: number[], fieldNumber: number, wireType: number): void {
  appendVarint(out, (BigInt(fieldNumber) << 3n) | BigInt(wireType));
}

function appendBytes(out: number[], bytes: Uint8Array): void {
  appendVarint(out, BigInt(bytes.byteLength));
  for (let i = 0; i < bytes.byteLength; i += 1) out.push(bytes[i]!);
}

function appendString(out: number[], text: string): void {
  appendBytes(out, Buffer.from(text, "utf8"));
}

function consumeVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i += 1) {
    if (offset + i >= buf.byteLength) throw new Error("truncated protobuf varint");
    const byte = buf[offset + i]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: offset + i + 1 };
    }
    shift += 7n;
  }
  throw new Error("protobuf varint overflow");
}

function consumeTag(buf: Uint8Array, offset: number): { field: number; wire: number; next: number } {
  const { value, next } = consumeVarint(buf, offset);
  const field = Number(value >> 3n);
  const wire = Number(value & 0x7n);
  if (field <= 0) throw new Error("invalid protobuf field number");
  return { field, wire, next };
}

function consumeBytes(buf: Uint8Array, offset: number): { data: Uint8Array; next: number } {
  const { value, next } = consumeVarint(buf, offset);
  const len = Number(value);
  if (!Number.isSafeInteger(len) || len < 0 || next + len > buf.byteLength) {
    throw new Error("invalid protobuf bytes length");
  }
  return { data: buf.slice(next, next + len), next: next + len };
}

function skipField(buf: Uint8Array, offset: number, wire: number): number {
  if (wire === WIRE_VARINT) return consumeVarint(buf, offset).next;
  if (wire === WIRE_FIXED64) {
    if (offset + 8 > buf.byteLength) throw new Error("truncated fixed64");
    return offset + 8;
  }
  if (wire === WIRE_BYTES) return consumeBytes(buf, offset).next;
  if (wire === WIRE_FIXED32) {
    if (offset + 4 > buf.byteLength) throw new Error("truncated fixed32");
    return offset + 4;
  }
  throw new Error(`unsupported protobuf wire type ${wire}`);
}

export function encodeMuseTransportFrame(frame: MuseTransportFrame): Uint8Array {
  const out: number[] = [];
  if (frame.chunkId !== 0n) {
    appendTag(out, 1, WIRE_VARINT);
    appendVarint(out, frame.chunkId);
  }
  if (frame.chunkIndex !== 0) {
    appendTag(out, 2, WIRE_VARINT);
    appendVarint(out, BigInt(frame.chunkIndex));
  }
  if (frame.totalChunks !== 0) {
    appendTag(out, 3, WIRE_VARINT);
    appendVarint(out, BigInt(frame.totalChunks));
  }
  if (frame.payload.byteLength > 0) {
    appendTag(out, 4, WIRE_BYTES);
    appendBytes(out, frame.payload);
  }
  return Uint8Array.from(out);
}

export function decodeMuseTransportFrame(raw: Uint8Array): MuseTransportFrame {
  let chunkId = 0n;
  let chunkIndex = 0;
  let totalChunks = 0;
  let payload: Uint8Array = new Uint8Array(0);
  let pos = 0;
  while (pos < raw.byteLength) {
    const tag = consumeTag(raw, pos);
    pos = tag.next;
    if (tag.field === 1 && tag.wire === WIRE_VARINT) {
      const v = consumeVarint(raw, pos);
      chunkId = BigInt.asIntN(64, v.value);
      pos = v.next;
    } else if (tag.field === 2 && tag.wire === WIRE_VARINT) {
      const v = consumeVarint(raw, pos);
      chunkIndex = Number(v.value);
      pos = v.next;
    } else if (tag.field === 3 && tag.wire === WIRE_VARINT) {
      const v = consumeVarint(raw, pos);
      totalChunks = Number(v.value);
      pos = v.next;
    } else if (tag.field === 4 && tag.wire === WIRE_BYTES) {
      const b = consumeBytes(raw, pos);
      payload = b.data;
      pos = b.next;
    } else {
      pos = skipField(raw, pos, tag.wire);
    }
  }
  return { chunkId, chunkIndex, totalChunks, payload };
}

export function encodeMuseServiceRequest(serviceId: number, frameBytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  if (serviceId !== 0) {
    appendTag(out, 1, WIRE_VARINT);
    appendVarint(out, BigInt(serviceId));
  }
  if (frameBytes.byteLength > 0) {
    appendTag(out, 2, WIRE_BYTES);
    appendBytes(out, frameBytes);
  }
  return Uint8Array.from(out);
}

export function decodeMuseServiceResponsePayload(raw: Uint8Array): Uint8Array {
  let payload: Uint8Array = new Uint8Array(0);
  let pos = 0;
  while (pos < raw.byteLength) {
    const tag = consumeTag(raw, pos);
    pos = tag.next;
    if (tag.field === 1 && tag.wire === WIRE_BYTES) {
      const b = consumeBytes(raw, pos);
      payload = b.data;
      pos = b.next;
    } else {
      pos = skipField(raw, pos, tag.wire);
    }
  }
  return payload;
}

export function encodeMuseServiceFrameRequest(streamId: bigint, req: MuseAppRequestMsg): Uint8Array {
  const rb: number[] = [];
  if (req.verb) {
    appendTag(rb, 1, WIRE_BYTES);
    appendString(rb, req.verb);
  }
  if (req.path) {
    appendTag(rb, 2, WIRE_BYTES);
    appendString(rb, req.path);
  }
  for (const hdr of req.headers) {
    const hb: number[] = [];
    if (hdr.key) {
      appendTag(hb, 1, WIRE_BYTES);
      appendString(hb, hdr.key);
    }
    if (hdr.value) {
      appendTag(hb, 2, WIRE_BYTES);
      appendString(hb, hdr.value);
    }
    appendTag(rb, 3, WIRE_BYTES);
    appendBytes(rb, Uint8Array.from(hb));
  }
  if (req.body && req.body.byteLength > 0) {
    appendTag(rb, 4, WIRE_BYTES);
    appendBytes(rb, req.body);
  }
  if (req.endBody) {
    appendTag(rb, 5, WIRE_VARINT);
    appendVarint(rb, 1n);
  }

  const fb: number[] = [];
  if (streamId !== 0n) {
    appendTag(fb, 1, WIRE_VARINT);
    appendVarint(fb, streamId);
  }
  appendTag(fb, 2, WIRE_BYTES);
  appendBytes(fb, Uint8Array.from(rb));
  return Uint8Array.from(fb);
}

function decodeAppResponse(raw: Uint8Array): MuseAppResponseMsg {
  let status = 0;
  const headers: MuseHeaderKV[] = [];
  let body: Uint8Array = new Uint8Array(0);
  let endBody = false;
  let pos = 0;
  while (pos < raw.byteLength) {
    const tag = consumeTag(raw, pos);
    pos = tag.next;
    if (tag.field === 1 && tag.wire === WIRE_VARINT) {
      const v = consumeVarint(raw, pos);
      status = Number(BigInt.asIntN(32, v.value));
      pos = v.next;
    } else if (tag.field === 2 && tag.wire === WIRE_BYTES) {
      const b = consumeBytes(raw, pos);
      pos = b.next;
      let hp = 0;
      let key = "";
      let value = "";
      while (hp < b.data.byteLength) {
        const ht = consumeTag(b.data, hp);
        hp = ht.next;
        if (ht.field === 1 && ht.wire === WIRE_BYTES) {
          const s = consumeBytes(b.data, hp);
          key = Buffer.from(s.data).toString("utf8");
          hp = s.next;
        } else if (ht.field === 2 && ht.wire === WIRE_BYTES) {
          const s = consumeBytes(b.data, hp);
          value = Buffer.from(s.data).toString("utf8");
          hp = s.next;
        } else {
          hp = skipField(b.data, hp, ht.wire);
        }
      }
      headers.push({ key, value });
    } else if (tag.field === 3 && tag.wire === WIRE_BYTES) {
      const b = consumeBytes(raw, pos);
      body = b.data;
      pos = b.next;
    } else if (tag.field === 4 && tag.wire === WIRE_VARINT) {
      const v = consumeVarint(raw, pos);
      endBody = v.value !== 0n;
      pos = v.next;
    } else {
      pos = skipField(raw, pos, tag.wire);
    }
  }
  return { status, headers, body, endBody };
}

export function decodeMuseServiceFrame(raw: Uint8Array): MuseServiceFrameMsg {
  const out: MuseServiceFrameMsg = { streamId: 0n };
  let pos = 0;
  while (pos < raw.byteLength) {
    const tag = consumeTag(raw, pos);
    pos = tag.next;
    if (tag.field === 1 && tag.wire === WIRE_VARINT) {
      const v = consumeVarint(raw, pos);
      out.streamId = BigInt.asIntN(64, v.value);
      pos = v.next;
    } else if (tag.field === 3 && tag.wire === WIRE_BYTES) {
      const b = consumeBytes(raw, pos);
      pos = b.next;
      out.response = decodeAppResponse(b.data);
      out.bodyChunk = undefined;
      out.reset = undefined;
    } else if (tag.field === 4 && tag.wire === WIRE_BYTES) {
      const b = consumeBytes(raw, pos);
      pos = b.next;
      let cp = 0;
      let data: Uint8Array = new Uint8Array(0);
      let endBody = false;
      while (cp < b.data.byteLength) {
        const ct = consumeTag(b.data, cp);
        cp = ct.next;
        if (ct.field === 1 && ct.wire === WIRE_BYTES) {
          const cb = consumeBytes(b.data, cp);
          data = cb.data;
          cp = cb.next;
        } else if (ct.field === 2 && ct.wire === WIRE_VARINT) {
          const cv = consumeVarint(b.data, cp);
          endBody = cv.value !== 0n;
          cp = cv.next;
        } else {
          cp = skipField(b.data, cp, ct.wire);
        }
      }
      out.bodyChunk = { data, endBody };
      out.response = undefined;
      out.reset = undefined;
    } else if (tag.field === 5 && tag.wire === WIRE_BYTES) {
      const b = consumeBytes(raw, pos);
      pos = b.next;
      let rp = 0;
      let code = 0;
      let reason = "";
      while (rp < b.data.byteLength) {
        const rt = consumeTag(b.data, rp);
        rp = rt.next;
        if (rt.field === 1 && rt.wire === WIRE_VARINT) {
          const rv = consumeVarint(b.data, rp);
          code = Number(BigInt.asIntN(32, rv.value));
          rp = rv.next;
        } else if (rt.field === 2 && rt.wire === WIRE_BYTES) {
          const rb = consumeBytes(b.data, rp);
          reason = Buffer.from(rb.data).toString("utf8");
          rp = rb.next;
        } else {
          rp = skipField(b.data, rp, rt.wire);
        }
      }
      out.reset = { code, reason };
      out.response = undefined;
      out.bodyChunk = undefined;
    } else {
      pos = skipField(raw, pos, tag.wire);
    }
  }
  return out;
}
