// AR 擺放連結：把選取的家具（種類、尺寸、顏色、參數與彼此的相對位置）壓縮放進 ar.html 的網址，
// 手機掃 QR code 開啟後即可在自己家以實際尺寸擺放。不含平面圖與其他專案資料，網址短、QR code 好掃。
import { packJSON, unpackJSON } from '../core/share.js';

const KEEP = ['kind', 'name', 'w', 'd', 'h', 'color', 'color2', 'mirror', 'params', 'elev', 'rot'];

// items：專案中的家具；styleId：專案風格（決定預設配色）；rooms：要一起顯示地板範圍的房間
export function arPayload(items, { styleId = '', name = '', rooms = [] } = {}) {
  if (!items.length && !rooms.length) return { v: 1, n: name, s: styleId, i: [] };
  // 中心取家具與房間範圍的外框中心：整間擺放時，點下的位置就是房間中央
  const xs = [...items.map((it) => it.x), ...rooms.flatMap((r) => r.points.map((p) => p[0]))];
  const ys = [...items.map((it) => it.y), ...rooms.flatMap((r) => r.points.map((p) => p[1]))];
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return {
    v: 1, n: name, s: styleId,
    ...(rooms.length ? { r: rooms.map((r) => r.points.map(([x, y]) => [Math.round(x - cx), Math.round(y - cy)])) } : {}),
    i: items.map((it) => {
      const o = { x: Math.round(it.x - cx), y: Math.round(it.y - cy) };
      for (const k of KEEP) if (it[k] !== undefined && it[k] !== null && it[k] !== '' && it[k] !== 0 && it[k] !== false) o[k] = it[k];
      return o;
    }),
  };
}

// ar.html 的網址（和目前網頁同一個資料夾）
export function arBaseUrl() {
  return new URL('ar.html', location.href.split('#')[0].split('?')[0]).href;
}

export async function arLink(payload) {
  return `${arBaseUrl()}#d=${await packJSON(payload)}`;
}

export async function readArLink(hash = location.hash) {
  const m = /[#&]d=([^&]+)/.exec(hash);
  if (!m) return null;
  let p;
  try { p = await unpackJSON(m[1]); } catch { throw new Error('AR 連結不完整或已損毀，請重新掃描 QR code'); }
  if (!p || !Array.isArray(p.i)) throw new Error('AR 連結的資料格式不正確');
  if (!Array.isArray(p.r)) p.r = [];
  p.i = p.i.map((o, idx) => ({ id: `ar${idx}`, x: 0, y: 0, rot: 0, elev: 0, ...o }));
  return p;
}
