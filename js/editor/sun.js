// 日照模擬：依地點、日期、時間計算太陽位置（NOAA 簡化公式），
// 推算陽光從窗戶照進室內的地板範圍，並統計各房間的日照時數與西曬時段。
import { pointInPolygon, wallFrame, polygonArea } from '../core/geometry.js';
import { wallOnRoom, wallSideToward } from '../core/model.js';
import { OPENING_MAP } from '../data/catalog.js';

export const CITIES = {
  taipei: { name: '台北', lat: 25.04, lon: 121.56 },
  taoyuan: { name: '桃園', lat: 24.99, lon: 121.30 },
  hsinchu: { name: '新竹', lat: 24.80, lon: 120.97 },
  taichung: { name: '台中', lat: 24.15, lon: 120.67 },
  tainan: { name: '台南', lat: 22.99, lon: 120.21 },
  kaohsiung: { name: '高雄', lat: 22.63, lon: 120.30 },
  yilan: { name: '宜蘭', lat: 24.75, lon: 121.75 },
  hualien: { name: '花蓮', lat: 23.98, lon: 121.60 },
  taitung: { name: '台東', lat: 22.76, lon: 121.14 },
};

const D2R = Math.PI / 180;

function dayOfYear(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d), t0 = Date.UTC(y, 0, 1);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return { n: Math.round((t - t0) / 86400000) + 1, days: leap ? 366 : 365 };
}

/**
 * 太陽位置
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} minutes 當地時鐘時間（從 0:00 起的分鐘）
 * @param {number} lat 緯度
 * @param {number} lon 經度
 * @param {number} tz 時區（台灣 +8）
 * @returns {{ alt: number, az: number }} 高度角、方位角（度，方位角自正北順時針）
 */
export function solarPosition(dateStr, minutes, lat, lon, tz = 8) {
  const { n, days } = dayOfYear(dateStr);
  const hour = minutes / 60;
  const g = ((2 * Math.PI) / days) * (n - 1 + (hour - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = minutes + eqtime + 4 * lon - 60 * tz;
  const ha = (tst / 4 - 180) * D2R;
  const phi = lat * D2R;
  const cosZ = Math.min(1, Math.max(-1, Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha)));
  const zen = Math.acos(cosZ);
  const alt = 90 - zen / D2R;
  let az;
  const sz = Math.sin(zen);
  if (sz < 1e-6) az = 180;
  else {
    const c = Math.min(1, Math.max(-1, (Math.sin(phi) * cosZ - Math.sin(decl)) / (Math.cos(phi) * sz)));
    const a = Math.acos(c) / D2R;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  // 接近地平線時加上大氣折射修正（約 0.5°）
  const refr = alt > -1 && alt < 15 ? 0.5 * (1 - alt / 15) : 0;
  return { alt: alt + refr, az };
}

/** 日出、日落（分鐘），找不到時回傳 null */
export function sunTimes(dateStr, lat, lon, tz = 8) {
  let rise = null, set = null, prev = solarPosition(dateStr, 0, lat, lon, tz).alt;
  for (let m = 2; m <= 1440; m += 2) {
    const a = solarPosition(dateStr, m, lat, lon, tz).alt;
    if (prev < 0 && a >= 0 && rise === null) rise = m;
    if (prev >= 0 && a < 0) set = m;
    prev = a;
  }
  return { rise, set };
}

export function fmtTime(min) {
  if (min === null || min === undefined) return '--:--';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function compassName(az) {
  const names = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
  return names[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

/**
 * 平面圖上朝向太陽的水平方向（單位向量）。north 為正北相對平面圖上方的順時針角度。
 * 平面圖 y 軸向下，順時針旋轉 θ：(x, y) → (x cosθ - y sinθ, x sinθ + y cosθ)
 */
export function planSunDir(az, north) {
  const t = (north + az) * D2R;
  return { x: Math.sin(t), y: -Math.cos(t) };
}

/** 3D 中朝向太陽的方向（平面 x → 3D x、平面 y → 3D z） */
export function sunDir3(alt, az, north) {
  const h = planSunDir(az, north), c = Math.cos(alt * D2R);
  return { x: h.x * c, y: Math.sin(alt * D2R), z: h.y * c };
}

// 外牆上的窗戶與落地窗（牆只有一側有房間），附上朝外的法線
export function exteriorWindows(P) {
  const out = [];
  for (const op of P.openings) {
    const def = OPENING_MAP[op.kind];
    if (!def || def.type === 'opening') continue;
    // 門只有玻璃門片會透光
    if (def.cat === 'door' && !(op.leafFinish === 'glass' || def.type === 'sliding')) continue;
    const w = P.walls.find((x) => x.id === op.wallId);
    if (!w) continue;
    const sides = new Map();
    for (const r of P.rooms) {
      if (!wallOnRoom(w, r)) continue;
      // 只看窗戶所在位置兩側的房間
      const f = wallFrame(w);
      const cx = w.x1 + f.ux * op.offset, cy = w.y1 + f.uy * op.offset, d = w.thickness / 2 + 6;
      if (pointInPolygon(cx + f.nx * d, cy + f.ny * d, r.points)) sides.set('A', r);
      else if (pointInPolygon(cx - f.nx * d, cy - f.ny * d, r.points)) sides.set('B', r);
      else { const s = wallSideToward(w, r); if (s && !sides.has(s)) sides.set(s, r); }
    }
    if (sides.size !== 1) continue; // 兩側都是室內（或都不是），陽光不會直接照入
    const [[side, room]] = [...sides];
    const f = wallFrame(w), k = side === 'A' ? 1 : -1;
    out.push({ op, def, wall: w, room, f, inward: { x: f.nx * k, y: f.ny * k } });
  }
  return out;
}

/**
 * 陽光從窗戶照到地板的範圍
 * @returns {Array<{ room, inner: number[][], outer: number[][] }>} 實際亮區 = inner ∩ outer ∩ 房間
 */
export function sunPatches(P, alt, az, north, wins = exteriorWindows(P)) {
  if (alt <= 0.5) return [];
  const h = planSunDir(az, north);
  // 陽光行進方向（往室內）的水平分量，每下降 1 公分水平移動 1 / tan(alt)
  const k = 1 / Math.tan(alt * D2R);
  const vx = -h.x * k, vy = -h.y * k;
  const out = [];
  for (const W of wins) {
    // 太陽要在牆的外側
    if (h.x * -W.inward.x + h.y * -W.inward.y <= 0.02) continue;
    const { op, wall: w, f, inward } = W;
    const t = w.thickness / 2;
    const a = op.offset - op.width / 2, b = op.offset + op.width / 2;
    const z0 = op.sill || 0, z1 = (op.sill || 0) + op.height;
    const face = (s) => {
      const ox = inward.x * t * s, oy = inward.y * t * s;
      const p = (u) => [w.x1 + f.ux * u + ox, w.y1 + f.uy * u + oy];
      const [p1, p2] = [p(a), p(b)];
      const proj = ([x, y], z) => [x + vx * z, y + vy * z];
      return [proj(p1, z0), proj(p2, z0), proj(p2, z1), proj(p1, z1)];
    };
    out.push({ room: W.room, op, inner: face(1), outer: face(-1) });
  }
  return out;
}

// 多邊形裁切（Sutherland–Hodgman，裁切多邊形需為凸多邊形）
function clipPoly(subject, clip) {
  let out = subject;
  const n = clip.length;
  // 判斷裁切多邊形的方向
  let s = 0;
  for (let i = 0; i < n; i++) { const [x1, y1] = clip[i], [x2, y2] = clip[(i + 1) % n]; s += x1 * y2 - x2 * y1; }
  const dir = s > 0 ? 1 : -1;
  for (let i = 0; i < n && out.length; i++) {
    const [ax, ay] = clip[i], [bx, by] = clip[(i + 1) % n];
    const inside = ([x, y]) => dir * ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) >= 0;
    const inter = ([x1, y1], [x2, y2]) => {
      const dx = x2 - x1, dy = y2 - y1;
      const den = (bx - ax) * dy - (by - ay) * dx;
      const tt = den === 0 ? 0 : ((bx - ax) * (ay - y1) - (by - ay) * (ax - x1)) / den;
      return [x1 + dx * tt, y1 + dy * tt];
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j + input.length - 1) % input.length];
      if (inside(cur)) { if (!inside(prev)) out.push(inter(prev, cur)); out.push(cur); }
      else if (inside(prev)) out.push(inter(prev, cur));
    }
  }
  return out;
}

/** 某個時刻各房間被陽光照到的地板面積（平方公分，未扣除家具） */
export function litAreas(P, alt, az, north, wins) {
  const area = new Map();
  for (const p of sunPatches(P, alt, az, north, wins)) {
    const lit = clipPoly(p.inner, p.outer);
    if (lit.length < 3) continue;
    // 只計算落在房間內的部分（以取樣近似，房間可能是凹多邊形）
    let inside = 0, total = 0;
    const xs = lit.map((q) => q[0]), ys = lit.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / 8, y = y0 + ((y1 - y0) * (j + 0.5)) / 8;
      if (!pointInPolygon(x, y, lit)) continue;
      total++;
      if (pointInPolygon(x, y, p.room.points)) inside++;
    }
    const a = Math.abs(polygonArea(lit)) * (total ? inside / total : 0);
    area.set(p.room.id, (area.get(p.room.id) || 0) + a);
  }
  return area;
}

/**
 * 一整天的日照統計（每 10 分鐘取樣）
 * @returns {Map<roomId, { minutes, first, last, westMinutes, westFrom, westTo, peak }>}
 */
export function daySunReport(P, dateStr, lat, lon, north) {
  const wins = exteriorWindows(P);
  const rep = new Map();
  for (const r of P.rooms) rep.set(r.id, { room: r, minutes: 0, first: null, last: null, westMinutes: 0, westFrom: null, westTo: null, peak: 0 });
  const step = 10;
  for (let m = 300; m <= 1170; m += step) {
    const { alt, az } = solarPosition(dateStr, m, lat, lon);
    if (alt <= 1) continue;
    const areas = litAreas(P, alt, az, north, wins);
    for (const [id, a] of areas) {
      const x = rep.get(id);
      if (!x || a < 2000) continue; // 不到 0.2 m² 視為沒有日照
      x.minutes += step;
      if (x.first === null) x.first = m;
      x.last = m;
      x.peak = Math.max(x.peak, a);
      // 西曬：下午 14:00 以後，太陽在西南到西北之間
      if (m >= 840 && az >= 200 && az <= 320) {
        x.westMinutes += step;
        if (x.westFrom === null) x.westFrom = m;
        x.westTo = m;
      }
    }
  }
  return rep;
}
