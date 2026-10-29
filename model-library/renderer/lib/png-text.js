// Helpers for writing text into a PNG file. Used for the view settings stored inside every thumbnail.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToDataUrl(bytes, mime) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:' + mime + ';base64,' + btoa(s);
}

/** Returns a copy of a PNG with the text stored in an iTXt chunk (UTF-8), placed straight after the IHDR header chunk. */
export function embedPngText(png, keyword, text) {
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4E || png[3] !== 0x47) return png;   // not a PNG: leave it alone

  const enc = new TextEncoder();
  const k = enc.encode(keyword), t = enc.encode(text);
  // iTXt data: keyword, 0, compression flag 0, compression method 0, empty language tag + 0, empty translated keyword + 0, text
  const body = new Uint8Array(k.length + 5 + t.length);
  body.set(k, 0);
  body.set(t, k.length + 5);
  const chunk = new Uint8Array(12 + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length);
  chunk.set([0x69, 0x54, 0x58, 0x74], 4);                    // "iTXt"
  chunk.set(body, 8);
  view.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));

  const at = 33;                                             // 8-byte signature + 25-byte IHDR chunk
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}
