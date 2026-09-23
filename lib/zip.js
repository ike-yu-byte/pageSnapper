/**
 * zip.js — 零依赖 ZIP 打包器（store 模式，不压缩）
 *
 * 为什么手写：MV3 禁止加载远程代码，无法引入 CDN 上的 JSZip；
 * 而图片/字体本身已是压缩格式，再 deflate 收益极小，store 模式足够。
 *
 * 支持：UTF-8 文件名（general purpose bit 11）、任意二进制内容。
 * 限制：单文件与总量均需 < 4GB（超出需 Zip64，本场景不涉及）。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const utf8Encoder = new TextEncoder();

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return utf8Encoder.encode(String(data));
}

// DOS 时间格式：日期 << 16 | 时间
function toDosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

export class ZipWriter {
  constructor() {
    this.entries = [];
  }

  /**
   * @param {string} name 包内路径，用 / 分隔
   * @param {Uint8Array|ArrayBuffer|string} data
   */
  add(name, data) {
    const normalized = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) throw new Error('ZIP 条目名不能为空');
    const nameBytes = utf8Encoder.encode(normalized);
    if (nameBytes.length > 0xffff) throw new Error('ZIP 条目名过长: ' + normalized);
    this.entries.push({ name, nameBytes, data: toBytes(data) });
    return this;
  }

  addJSON(name, value) {
    return this.add(name, JSON.stringify(value, null, 2));
  }

  get count() {
    return this.entries.length;
  }

  /** 生成完整 ZIP 字节流 */
  build() {
    const stamp = toDosDateTime(new Date());
    const items = this.entries.map((e) => ({
      nameBytes: e.nameBytes,
      data: e.data,
      crc: crc32(e.data),
      localOffset: 0,
      time: stamp.time,
      date: stamp.date
    }));

    const localParts = [];
    let offset = 0;
    for (const it of items) {
      it.localOffset = offset;
      const header = new Uint8Array(30 + it.nameBytes.length);
      const dv = new DataView(header.buffer);
      dv.setUint32(0, SIG_LOCAL, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, FLAG_UTF8, true);
      dv.setUint16(8, METHOD_STORE, true);
      dv.setUint16(10, it.time, true);
      dv.setUint16(12, it.date, true);
      dv.setUint32(14, it.crc, true);
      dv.setUint32(18, it.data.length, true);
      dv.setUint32(22, it.data.length, true);
      dv.setUint16(26, it.nameBytes.length, true);
      dv.setUint16(28, 0, true);
      header.set(it.nameBytes, 30);
      localParts.push(header, it.data);
      offset += header.length + it.data.length;
    }

    const centralOffset = offset;
    const centralParts = [];
    for (const it of items) {
      const header = new Uint8Array(46 + it.nameBytes.length);
      const dv = new DataView(header.buffer);
      dv.setUint32(0, SIG_CENTRAL, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, FLAG_UTF8, true);
      dv.setUint16(10, METHOD_STORE, true);
      dv.setUint16(12, it.time, true);
      dv.setUint16(14, it.date, true);
      dv.setUint32(16, it.crc, true);
      dv.setUint32(20, it.data.length, true);
      dv.setUint32(24, it.data.length, true);
      dv.setUint16(28, it.nameBytes.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, it.localOffset, true);
      header.set(it.nameBytes, 46);
      centralParts.push(header);
    }

    const centralSize = centralParts.reduce((n, p) => n + p.length, 0);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, items.length, true);
    ev.setUint16(10, items.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);

    const parts = [...localParts, ...centralParts, eocd];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  }
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const clean = String(base64).replace(/\s+/g, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
