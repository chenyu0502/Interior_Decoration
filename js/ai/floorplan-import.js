// 從平面圖圖片（PNG / JPG）自動辨識牆體、門窗與房間
// 流程：二值化 → 去除細線與文字 → 找出水平 / 垂直牆帶 → 合併共線牆段並找出缺口（門窗）
//      → 依門寬推估比例尺 → 轉成公分座標、接合轉角 → 自動偵測房間
// 限制：只辨識水平與垂直的牆；斜牆、弧形牆需手動補畫。

import { detectRooms, polygonArea, uid } from '../core/geometry.js';

const DOOR_CM = 85; // 推估比例尺時採用的標準門寬

// 缺口旁有門弧線與門片直線才視為門
const isDoor = (g) => g.swing > 0.015 && g.leaf > 0.04;

// ---------------------------------------------------------------- 影像前處理
function toGray(img) {
  const { data, width, height } = img;
  const g = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) {
    const a = data[i + 3] / 255;
    // 透明像素視為白色
    g[p] = Math.round((0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a));
  }
  return g;
}

function otsu(g) {
  const hist = new Array(256).fill(0);
  for (const v of g) hist[v]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; th = t; }
  }
  return th;
}

// 3×3 閉運算：填補斜線填充（hatch）與鋸齒
function closing(mask, w, h) {
  const dil = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) { v = 1; break; }
    }
    dil[y * w + x] = v;
  }
  const ero = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 1;
    for (let dy = -1; dy <= 1 && v; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || !dil[yy * w + xx]) { v = 0; break; }
    }
    ero[y * w + x] = v;
  }
  return ero;
}

// 每個像素所在的水平 / 垂直連續暗像素長度
function runLengths(mask, w, h) {
  const hr = new Uint16Array(mask.length), vr = new Uint16Array(mask.length);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) { x++; continue; }
      let e = x;
      while (e < w && mask[y * w + e]) e++;
      for (let k = x; k < e; k++) hr[y * w + k] = e - x;
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) { y++; continue; }
      let e = y;
      while (e < h && mask[e * w + x]) e++;
      for (let k = y; k < e; k++) vr[k * w + x] = e - y;
      y = e;
    }
  }
  return { hr, vr };
}

// ---------------------------------------------------------------- 牆帶擷取
// horizontal=true：逐列掃描水平連續段，跨列合併成「牆帶」
function extractBands(cand, w, h, horizontal, minLen) {
  const L1 = horizontal ? h : w, L2 = horizontal ? w : h;
  const at = horizontal ? (i, j) => cand[i * w + j] : (i, j) => cand[j * w + i];
  const done = [];
  let active = [];
  for (let i = 0; i < L1; i++) {
    const runs = [];
    let j = 0;
    while (j < L2) {
      if (!at(i, j)) { j++; continue; }
      let e = j;
      while (e < L2 && at(i, e)) e++;
      if (e - j >= minLen) runs.push([j, e]);
      j = e;
    }
    const next = [];
    const used = new Set();
    for (const b of active) {
      let hit = -1;
      for (let r = 0; r < runs.length; r++) {
        if (used.has(r)) continue;
        const [a, e] = runs[r];
        const ov = Math.min(e, b.last[1]) - Math.max(a, b.last[0]);
        if (ov >= 0.6 * Math.min(e - a, b.last[1] - b.last[0])) { hit = r; break; }
      }
      if (hit >= 0) {
        used.add(hit);
        b.last = runs[hit]; b.starts.push(runs[hit][0]); b.ends.push(runs[hit][1]); b.i1 = i;
        next.push(b);
      } else done.push(b);
    }
    runs.forEach((r, k) => { if (!used.has(k)) next.push({ i0: i, i1: i, last: r, starts: [r[0]], ends: [r[1]] }); });
    active = next;
  }
  done.push(...active);
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return done.map((b) => ({ horizontal, c: (b.i0 + b.i1 + 1) / 2, t: b.i1 - b.i0 + 1, a: med(b.starts), b: med(b.ends) }));
}

// ---------------------------------------------------------------- 主分析
/**
 * 分析平面圖影像，回傳以像素為單位的牆線與缺口；再以 build(scale) 轉成專案資料。
 * @param {ImageData} img
 */
export function analyzeFloorplan(img) {
  const { width: w, height: h } = img;
  const g = toGray(img);
  const th = Math.min(otsu(g), 150);
  let dark = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) dark[i] = g[i] < th ? 1 : 0;
  const raw = dark; // 閉運算前的原始暗像素，用來分辨窗戶的平行細線
  dark = closing(dark, w, h);

  // 1. 估計牆厚：牆體像素的 min(水平, 垂直) 連續長度 ≈ 牆厚
  let { hr, vr } = runLengths(dark, w, h);
  const hist = new Float64Array(200);
  for (let i = 0; i < dark.length; i++) {
    if (!dark[i]) continue;
    const t = Math.min(hr[i], vr[i]);
    if (t >= 3 && t < 200) hist[t] += t; // 以厚度加權，偏向粗線
  }
  let mode = 0;
  for (let t = 3; t < 200; t++) if (hist[t] > hist[mode]) mode = t;
  if (!mode) return { ok: false, reason: '圖片中找不到足夠粗的牆線' };
  const tMin = Math.max(3, Math.round(mode * 0.45));
  const tMax = Math.max(mode * 3, mode + 6);

  // 2. 去除細線（門弧線、尺寸線、文字、家具）
  const wall = new Uint8Array(g.length);
  for (let i = 0; i < dark.length; i++) wall[i] = dark[i] && Math.min(hr[i], vr[i]) >= tMin ? 1 : 0;
  ({ hr, vr } = runLengths(wall, w, h));
  // 門旁的短牆墩也要保留，因此最短長度只取略大於牆厚
  const minLen = Math.max(Math.round(mode * 1.2), 10);
  const hc = new Uint8Array(g.length), vc = new Uint8Array(g.length);
  for (let i = 0; i < wall.length; i++) {
    if (!wall[i]) continue;
    if (hr[i] >= minLen) hc[i] = 1;
    if (vr[i] >= minLen) vc[i] = 1;
  }

  // 3. 牆帶 → 牆段（像素座標）
  const bands = [...extractBands(hc, w, h, true, minLen), ...extractBands(vc, w, h, false, minLen)]
    .filter((b) => b.t >= tMin * 0.8 && b.t <= tMax && b.b - b.a >= minLen);
  if (bands.length < 3) return { ok: false, reason: '辨識到的牆太少，請確認圖片是清楚的平面圖（牆為深色粗線）' };

  // 3-1. 牆帶內原始像素稀疏的區段是窗戶（平行細線被閉運算填滿），從牆帶切開
  const splitBands = [];
  for (const b of bands) {
    const half = b.t / 2;
    const i0 = Math.max(0, Math.round(b.c - half)), i1 = Math.min(b.horizontal ? h : w, Math.round(b.c + half));
    const frac = [];
    for (let u = b.a; u < b.b; u++) {
      let n = 0;
      for (let i = i0; i < i1; i++) n += b.horizontal ? raw[i * w + u] : raw[u * w + i];
      frac.push(n / Math.max(1, i1 - i0));
    }
    const minRun = Math.max(Math.round(mode * 1.5), 8);
    let u = 0, start = 0;
    const pieces = [];
    while (u < frac.length) {
      if (frac[u] >= 0.72) { u++; continue; }
      let e = u;
      while (e < frac.length && frac[e] < 0.72) e++;
      if (e - u >= minRun) { if (u > start) pieces.push([start, u]); start = e; }
      u = e;
    }
    if (start < frac.length) pieces.push([start, frac.length]);
    for (const [p0, p1] of pieces) if (p1 - p0 >= Math.min(minLen, 6)) splitBands.push({ ...b, a: b.a + p0, b: b.a + p1 });
  }
  bands.length = 0;
  bands.push(...splitBands);

  // 4. 合併共線牆段，記錄中間的缺口
  const lines = [];
  for (const horizontal of [true, false]) {
    const list = bands.filter((b) => b.horizontal === horizontal).sort((p, q) => p.c - q.c || p.a - q.a);
    const groups = [];
    for (const b of list) {
      const gp = groups.find((x) => Math.abs(x.c - b.c) <= Math.max(x.t, b.t) * 0.5 + 1);
      if (gp) { gp.segs.push(b); gp.c = (gp.c * gp.n + b.c) / (gp.n + 1); gp.n++; gp.t = Math.max(gp.t, b.t); } else groups.push({ c: b.c, t: b.t, n: 1, segs: [b], horizontal });
    }
    for (const gp of groups) {
      gp.segs.sort((p, q) => p.a - q.a);
      // 合併重疊段
      const merged = [];
      for (const s of gp.segs) {
        const last = merged[merged.length - 1];
        // 小於約一個牆厚的破洞（家具貼牆、掃描雜訊）直接補起來
        if (last && s.a <= last.b + Math.max(2, mode * 1.2)) { last.b = Math.max(last.b, s.b); last.t = Math.max(last.t, s.t); } else merged.push({ ...s });
      }
      lines.push({ horizontal, c: gp.c, t: gp.t, segs: merged });
    }
  }

  // 5. 缺口分類（門 / 窗 / 門洞）
  const thin = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) thin[i] = g[i] < Math.min(th + 40, 200) && !wall[i] ? 1 : 0;
  const count = (x0, y0, x1, y1) => {
    let n = 0, a = 0;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) { a++; n += thin[y * w + x]; }
    return { n, a: a || 1 };
  };
  const loose = Math.min(th + 40, 200); // 細線常為反鋸齒的灰色，門檻放寬
  const countRaw = (x0, y0, x1, y1) => {
    let n = 0, a = 0;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) { a++; n += g[y * w + x] < loose ? 1 : 0; }
    return { n, a: a || 1 };
  };
  const gaps = [];
  for (const ln of lines) {
    for (let k = 1; k < ln.segs.length; k++) {
      const a = ln.segs[k - 1].b, b = ln.segs[k].a;
      const len = b - a;
      if (len < mode * 1.5 || len > mode * 40) continue;
      const half = ln.t / 2;
      const rect = ln.horizontal ? [a, ln.c - half, b, ln.c + half] : [ln.c - half, a, ln.c + half, b];
      const inGap = countRaw(...rect);
      // 門片擺動範圍：缺口兩側各一個正方形
      const sideA = ln.horizontal ? count(a, ln.c + half, b, ln.c + half + len) : count(ln.c - half - len, a, ln.c - half, b);
      const sideB = ln.horizontal ? count(a, ln.c - half - len, b, ln.c - half) : count(ln.c + half, a, ln.c + half + len, b);
      // 鉸鏈端：門片直線靠在缺口一端
      const swingA = sideA.n >= sideB.n;
      const strip = (u0, u1) => (ln.horizontal
        ? count(u0, swingA ? ln.c + half : ln.c - half - len, u1, swingA ? ln.c + half + len : ln.c - half)
        : count(swingA ? ln.c - half - len : ln.c + half, u0, swingA ? ln.c - half : ln.c + half + len, u1));
      const sw = Math.max(2, len * 0.12);
      const sA = strip(a, a + sw), sB = strip(b - sw, b);
      gaps.push({
        line: ln, a, b, len,
        filled: inGap.n / inGap.a,
        swing: Math.max(sideA.n / sideA.a, sideB.n / sideB.a),
        swingA,
        hingeEnd: sB.n > sA.n,
        // 門片直線（鉸鏈端的細線）密度：判斷是否真的是門
        leaf: Math.max(sA.n / sA.a, sB.n / sB.a),
      });
    }
  }
  return { ok: true, w, h, mode, lines, gaps };
}

/**
 * 依比例尺（公分 / 像素）把分析結果轉成專案資料
 */
export function buildProject(an, scale, { name = '圖片匯入的平面圖' } = {}) {
  const S = scale;
  // 外框：用於判斷外牆
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const ln of an.lines) for (const s of ln.segs) {
    if (ln.horizontal) { bx0 = Math.min(bx0, s.a); bx1 = Math.max(bx1, s.b); by0 = Math.min(by0, ln.c); by1 = Math.max(by1, ln.c); }
    else { by0 = Math.min(by0, s.a); by1 = Math.max(by1, s.b); bx0 = Math.min(bx0, ln.c); bx1 = Math.max(bx1, ln.c); }
  }
  // 原點取外牆中心線，讓座標從 0 開始
  let cx0 = Infinity, cy0 = Infinity;
  for (const ln of an.lines) { if (ln.horizontal) cy0 = Math.min(cy0, ln.c); else cx0 = Math.min(cx0, ln.c); }
  const ox = isFinite(cx0) ? cx0 : bx0, oy = isFinite(cy0) ? cy0 : by0;
  const cm = (v, o) => Math.round((v - o) * S);
  const thick = (t) => Math.max(8, Math.min(35, Math.round(t * S)));

  // 建立牆：同一條線上，缺口小於 4 m 的段落視為同一面牆（缺口作為門窗）
  const walls = [], openings = [];
  const gapByLine = new Map();
  for (const gp of an.gaps) { if (!gapByLine.has(gp.line)) gapByLine.set(gp.line, []); gapByLine.get(gp.line).push(gp); }
  for (const ln of an.lines) {
    const T = thick(ln.t);
    const exterior = ln.horizontal ? (Math.abs(ln.c - by0) < ln.t * 2 || Math.abs(ln.c - by1) < ln.t * 2) : (Math.abs(ln.c - bx0) < ln.t * 2 || Math.abs(ln.c - bx1) < ln.t * 2);
    let cur = null;
    const flush = () => { if (cur) walls.push(cur); cur = null; };
    for (let k = 0; k < ln.segs.length; k++) {
      const s = ln.segs[k];
      const gap = k > 0 ? (gapByLine.get(ln) || []).find((x) => Math.abs(x.a - ln.segs[k - 1].b) < 0.5) : null;
      const gapCm = gap ? gap.len * S : Infinity;
      if (cur && gap && gapCm <= 400) {
        // 延伸目前的牆並在缺口放門窗
        const u0 = gap.a * S, u1 = gap.b * S;
        cur._ops.push({ gap, u0, u1, exterior });
        if (ln.horizontal) cur.x2 = cm(s.b, ox); else cur.y2 = cm(s.b, oy);
      } else {
        flush();
        const c = cm(ln.c, ln.horizontal ? oy : ox);
        cur = ln.horizontal
          ? { x1: cm(s.a, ox), y1: c, x2: cm(s.b, ox), y2: c, thickness: T, _ops: [], _origin: s.a * S }
          : { x1: c, y1: cm(s.a, oy), x2: c, y2: cm(s.b, oy), thickness: T, _ops: [], _origin: s.a * S };
      }
    }
    flush();
  }

  // 接合轉角：牆端點延伸 / 修剪到垂直牆的中心線
  const tol = (w) => w.thickness * 1.2 + 8;
  for (const w of walls) {
    const horiz = w.y1 === w.y2;
    for (const end of ['1', '2']) {
      const px = w[`x${end}`], py = w[`y${end}`];
      let best = null;
      for (const o of walls) {
        if (o === w || (o.y1 === o.y2) === horiz) continue;
        if (horiz) {
          const ox2 = o.x1, lo = Math.min(o.y1, o.y2) - tol(o), hi = Math.max(o.y1, o.y2) + tol(o);
          const d = Math.abs(ox2 - px);
          if (d <= tol(w) + o.thickness / 2 && py >= lo && py <= hi && (!best || d < best.d)) best = { d, v: ox2 };
        } else {
          const oy2 = o.y1, lo = Math.min(o.x1, o.x2) - tol(o), hi = Math.max(o.x1, o.x2) + tol(o);
          const d = Math.abs(oy2 - py);
          if (d <= tol(w) + o.thickness / 2 && px >= lo && px <= hi && (!best || d < best.d)) best = { d, v: oy2 };
        }
      }
      if (best) { if (horiz) w[`x${end}`] = best.v; else w[`y${end}`] = best.v; }
    }
  }

  // 輸出牆與門窗
  const outWalls = [];
  for (const w of walls) {
    if (w.x1 > w.x2 || w.y1 > w.y2) { [w.x1, w.x2] = [w.x2, w.x1]; [w.y1, w.y2] = [w.y2, w.y1]; }
    const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    if (L < 30) continue;
    const wall = { id: uid('w'), x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, thickness: w.thickness, height: 280, matA: 'paint_white', matB: 'paint_white' };
    outWalls.push(wall);
    const horiz = w.y1 === w.y2;
    const start = horiz ? w.x1 : w.y1;
    const origin = horiz ? ox * S : oy * S;
    for (const op of w._ops) {
      const width = Math.round(op.u1 - op.u0);
      const offset = Math.round((op.u0 + op.u1) / 2 - origin - start);
      if (width < 40 || offset - width / 2 < -5 || offset + width / 2 > L + 5) continue;
      const g = op.gap;
      let kind, height, sill;
      if (g.filled > 0.06) {
        // 缺口內有細線：外牆為窗，內牆為推拉門
        if (op.exterior) { kind = width >= 180 ? 'window_wide' : 'window_std'; height = width >= 180 ? 130 : 120; sill = 90; }
        else { kind = 'door_sliding'; height = 220; sill = 0; }
      } else if (width <= 115 && isDoor(g)) { kind = op.exterior ? 'door_entry' : 'door_single'; height = 210; sill = 0; }
      else if (width <= 115) { kind = 'door_single'; height = 210; sill = 0; }
      else if (width <= 170 && isDoor(g)) { kind = 'door_double'; height = 210; sill = 0; }
      else { kind = 'door_opening'; height = 220; sill = 0; }
      // 牆方向：水平由左至右，A 面在 +y；垂直由上至下，A 面在 -x
      // 影像分析時 swingA 代表：水平 → 缺口下方（+y）、垂直 → 缺口左方（-x），與 A 面一致
      openings.push({ id: uid('o'), kind, wallId: wall.id, offset, width, height, sill, flipH: !!g.hingeEnd, flipV: !g.swingA });
    }
  }

  // 房間
  const roomPolys = detectRooms(outWalls);
  const rooms = roomPolys.map((pts) => ({ id: uid('r'), name: '房間', type: 'auto', points: pts, floor: 'wood_oak', ceiling: true }));

  const W = Math.round((bx1 - bx0) * S), H = Math.round((by1 - by0) * S);
  return {
    project: {
      version: 1, name,
      settings: { wallHeight: 280, wallThickness: 12, snap: true, grid: true, showCeiling: false, night: false, cutaway: false },
      walls: outWalls, openings, rooms, items: [], dims: [], background: null, design: { styleId: null, report: null },
    },
    size: { W, H },
    area: rooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0),
  };
}

// 比例尺推估：優先用門寬（約 85 cm），沒有門時用牆厚（約 15 cm）
export function estimateScale(an) {
  const doors = an.gaps.filter((g) => g.filled <= 0.06 && isDoor(g)).map((g) => g.len).sort((a, b) => a - b);
  if (doors.length) return { scale: DOOR_CM / doors[Math.floor(doors.length / 2)], by: 'door', n: doors.length };
  return { scale: 15 / an.mode, by: 'wall', n: 0 };
}

/** 讀取圖片檔並縮放到適合分析的大小 */
export function loadImageData(src, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => reject(new Error('無法讀取圖片'));
    img.src = src;
  });
}
