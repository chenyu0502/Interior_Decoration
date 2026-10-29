// 最小的 MP4 封裝器：把 WebCodecs VideoEncoder 輸出的 H.264（avc 格式）畫格寫成可直接播放、
// 可拖曳進度的 MP4（moov 放在前面，Windows、iPhone、LINE 都能直接開）。只支援單一視訊軌。
const TIMESCALE = 90000;

function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}
function full(type, version, flags, ...parts) {
  return box(type, u8([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
}
function concat(parts) {
  const list = parts.flat().filter(Boolean);
  const n = list.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of list) { out.set(p, o); o += p.length; }
  return out;
}
const u8 = (arr) => Uint8Array.from(arr);
function u16(...v) { const b = new Uint8Array(v.length * 2); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint16(i * 2, x)); return b; }
function u32(...v) { const b = new Uint8Array(v.length * 4); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x >>> 0)); return b; }
function i32(...v) { const b = new Uint8Array(v.length * 4); const d = new DataView(b.buffer); v.forEach((x, i) => d.setInt32(i * 4, x)); return b; }
const str = (s) => u8([...s].map((c) => c.charCodeAt(0)));
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

export class Mp4Muxer {
  constructor({ width, height, fps = 30 }) {
    this.width = width; this.height = height; this.fps = fps;
    this.delta = Math.round(TIMESCALE / fps);
    this.samples = []; // { data, key, pts }
    this.avcC = null;
  }

  // VideoEncoder 的 output 回呼
  add(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.avcC) {
      const d = meta.decoderConfig.description;
      this.avcC = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.samples.push({ data, key: chunk.type === 'key', pts: Math.round((chunk.timestamp * TIMESCALE) / 1e6) });
  }

  finish() {
    const N = this.samples.length;
    if (!N || !this.avcC) return null;
    const dur = N * this.delta;
    const { width: W, height: H } = this;
    // 解碼順序與顯示順序不同時（有 B 畫格）才需要 ctts
    const base = this.samples[0].pts;
    const offs = this.samples.map((s, i) => s.pts - base - i * this.delta);
    const minOff = Math.min(0, ...offs);
    const needCtts = offs.some((o) => o !== 0);
    const mdatSize = 8 + this.samples.reduce((s, x) => s + x.data.length, 0);
    const ftyp = box('ftyp', str('isom'), u32(512), str('isomiso2avc1mp41'));
    const build = (chunkOffset) => {
      const avc1 = box('avc1',
        u8([0, 0, 0, 0, 0, 0]), u16(1), // reserved、data_reference_index
        u16(0, 0), u32(0, 0, 0), u16(W, H), u32(0x00480000, 0x00480000, 0), u16(1),
        new Uint8Array(32), u16(0x0018), i32(-1).slice(2),
        box('avcC', this.avcC));
      const stbl = box('stbl',
        full('stsd', 0, 0, u32(1), avc1),
        full('stts', 0, 0, u32(1, N, this.delta)),
        needCtts ? full('ctts', 0, 0, u32(N), ...offs.map((o) => u32(1, o - minOff))) : null,
        full('stss', 0, 0, u32(this.samples.filter((s) => s.key).length), ...this.samples.map((s, i) => (s.key ? u32(i + 1) : null))),
        full('stsc', 0, 0, u32(1, 1, N, 1)),
        full('stsz', 0, 0, u32(0, N), ...this.samples.map((s) => u32(s.data.length))),
        full('stco', 0, 0, u32(1, chunkOffset)));
      const minf = box('minf',
        full('vmhd', 0, 1, u16(0, 0, 0, 0)),
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
        stbl);
      const mdia = box('mdia',
        full('mdhd', 0, 0, u32(0, 0, TIMESCALE, dur), u16(0x55c4, 0)),
        full('hdlr', 0, 0, u32(0), str('vide'), u32(0, 0, 0), str('VideoHandler'), u8([0])),
        minf);
      const ms = Math.round((dur / TIMESCALE) * 1000);
      const trak = box('trak',
        full('tkhd', 0, 3, u32(0, 0, 1, 0, ms, 0, 0), u16(0, 0, 0, 0), MATRIX, u32(W << 16, H << 16)),
        mdia);
      return box('moov',
        full('mvhd', 0, 0, u32(0, 0, 1000, ms, 0x00010000), u16(0x0100, 0), u32(0, 0), MATRIX, u32(0, 0, 0, 0, 0, 0), u32(2)),
        trak);
    };
    // moov 放在 mdat 前面（快速開始播放）：先算出 moov 大小再填入畫格資料的位置
    const size = build(0).length;
    const moov = build(ftyp.length + size + 8);
    const mdatHead = concat([u32(mdatSize), str('mdat')]);
    return new Blob([ftyp, moov, mdatHead, ...this.samples.map((s) => s.data)], { type: 'video/mp4' });
  }
}

// 找出可用的 H.264 編碼設定（WebCodecs）；不支援時回傳 null，改用即時錄影
export async function pickEncoder(width, height, fps = 30) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  const bitrate = Math.round(width * height * fps * 0.16);
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42e01f']) {
    for (const hardwareAcceleration of ['no-preference', 'prefer-software']) {
      const cfg = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' }, hardwareAcceleration };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return r.config || cfg;
      } catch { /* 試下一組 */ }
    }
  }
  return null;
}
