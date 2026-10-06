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

// 以積分影像計算 (2R+1)² 視窗內的平均亮度
function localMean(g, w, h, R) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1);
      const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
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
    // 每段延續到「重疊最多」的牆帶（避免牆與相鄰柱子在同一列相連時被接到錯的牆帶）
    const next = [];
    const taken = new Set();
    for (const r of runs) {
      let best = null, bestOv = 0;
      for (const b of active) {
        if (taken.has(b)) continue;
        const ov = Math.min(r[1], b.last[1]) - Math.max(r[0], b.last[0]);
        // 以交集 / 聯集比例判斷延續（牆接到轉角厚塊時，兩者比例差很多，視為不同牆帶）
        const iou = ov / (Math.max(r[1], b.last[1]) - Math.min(r[0], b.last[0]));
        // 同時要與牆帶目前的平均範圍相符，避免牆帶一路「漂移」到旁邊的家具上
        const ma = b.sa / b.starts.length, me = b.se / b.starts.length;
        const ovm = Math.min(r[1], me) - Math.max(r[0], ma);
        const ioum = ovm / (Math.max(r[1], me) - Math.min(r[0], ma));
        if (ov > 0 && iou >= 0.35 && ioum >= 0.5 && iou > bestOv) { best = b; bestOv = iou; }
      }
      if (best) {
        taken.add(best);
        best.last = r; best.starts.push(r[0]); best.ends.push(r[1]); best.sa += r[0]; best.se += r[1]; best.i1 = i;
        next.push(best);
      } else next.push({ i0: i, i1: i, last: r, starts: [r[0]], ends: [r[1]], sa: r[0], se: r[1] });
    }
    for (const b of active) if (!taken.has(b)) done.push(b);
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
export function analyzeFloorplan(img, opts = {}) {
  const { width: w, height: h } = img;
  const g = toGray(img);
  // 1. 選擇深色門檻並估計牆厚
  //    牆是「細長」的深色線條：長度遠大於厚度。柱子、標題橫幅、磁磚等大色塊不是細長形，不列入統計。
  //    試數個門檻，取牆厚分布最集中的一個（黑牆用低門檻可排除灰色磁磚，灰牆則需較高門檻）。
  const maxT = Math.max(12, Math.round(Math.min(w, h) * 0.05));
  const otsuTh = otsu(g);
  // 局部平均亮度（照片常有光線不均：同一道黑牆在反光處較亮、陰影處較暗）
  const R = Math.max(15, Math.round(Math.min(w, h) / 24));
  const mean = localMean(g, w, h, R);
  const cands = [];
  const options = [60, 80, 100, 120, 140, 160].filter((t0) => t0 <= otsuTh + 30).map((t0) => ({ t0 }))
    .concat([0.62, 0.72, 0.82].map((k) => ({ k })));
  for (const opt of options) {
    const t0 = opt.t0 ?? 100;
    const m = new Uint8Array(g.length);
    // 自適應：比周圍平均暗一定比例，或本身就非常暗（實心色塊仍維持實心，之後會被濾除）
    if (opt.k) for (let i = 0; i < g.length; i++) m[i] = g[i] < 75 || g[i] < mean[i] * opt.k ? 1 : 0;
    else for (let i = 0; i < g.length; i++) m[i] = g[i] < t0 ? 1 : 0;
    const c = closing(m, w, h);
    const rl = runLengths(c, w, h);
    const hist = new Float64Array(maxT + 2);
    let total = 0;
    for (let i = 0; i < c.length; i++) {
      if (!c[i]) continue;
      const t = Math.min(rl.hr[i], rl.vr[i]), L = Math.max(rl.hr[i], rl.vr[i]);
      if (t >= 3 && t <= maxT && L >= 4 * t) { hist[t] += t; total += t; } // 以厚度加權，偏向外牆
    }
    if (total < w * h * 0.002) continue; // 線條太少
    let peak = 3;
    for (let t = 3; t <= maxT; t++) if (hist[t] > hist[peak]) peak = t;
    const score = (hist[peak - 1] + hist[peak] + hist[peak + 1]) / total;
    const mass = hist[peak - 1] + hist[peak] + hist[peak + 1];
    cands.push({ th: t0, k: opt.k, mode: peak, score, mass, raw: m, dark: c, rl });
  }
  // 2. 每個候選門檻都完整辨識一次，取「封閉房間總面積」最大的結果（完整的平面圖會圍出最多房間）
  //    線條量太少的門檻（只抓到文字）直接略過
  const maxMass = Math.max(0, ...cands.map((x) => x.mass));
  let pool = cands.filter((x) => x.mass >= maxMass * 0.2);
  if (opts.only) pool = cands.filter((x) => (x.k ? `k${x.k}` : String(x.th)) === opts.only); // 除錯用
  if (!pool.length) return { ok: false, reason: '圖片中找不到足夠粗的牆線' };
  let result = null;
  for (const cand of pool) {
    const r = extractFrom(cand);
    if (!r.ok) continue;
    const est = estimateScale(r);
    const built = buildProject(r, est.scale);
    // 品質：封閉房間面積（像素²）×（1 ＋ 房間數加權）＋ 牆總長 × 10（房間尚未封閉時，以牆量判斷哪個門檻較完整）
    const wallLen = r.lines.reduce((sum, ln) => sum + ln.segs.reduce((t, sg) => t + sg.b - sg.a, 0), 0);
    // 牆厚與多數候選差太多的結果（例如把家具陰影當牆）降低分數
    const modes = pool.map((x) => x.mode).sort((a, b) => a - b);
    const medMode = modes[Math.floor(modes.length / 2)];
    const consistent = Math.abs(r.mode - medMode) <= medMode * 0.3 ? 1 : 0.7;
    r.quality = ((built.area / (est.scale * est.scale)) * (1 + 0.05 * built.project.rooms.length) + wallLen * 10) * consistent;
    if (!result || r.quality > result.quality) result = r;
  }
  return result || { ok: false, reason: '辨識到的牆太少，請確認圖片是清楚的平面圖（牆為深色粗線）' };

  function extractFrom(best) {
    const th = best.th, mode = best.mode;
    // 細線（門弧、窗線）判定：全域門檻或局部對比
    const looseTh = Math.max(th + 40, Math.min(otsuTh + 20, 180));
    const isLine = best.k ? (i) => g[i] < mean[i] * 0.88 : (i) => g[i] < looseTh;
    const raw = best.raw; // 閉運算前的原始暗像素，用來分辨窗戶的平行細線
    const dark = best.dark;
    let { hr, vr } = best.rl;
    const tMin = Math.max(3, Math.round(mode * 0.45));
    const tMax = Math.max(Math.round(mode * 2.2) + 2, mode + 6); // 太厚的多為家具（深色衣櫃）或柱子

    // 2-1. 去除細線（門弧線、尺寸線、文字、家具）
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
      // 長度至少約為厚度兩倍：排除磁磚方格、柱子等方塊
      .filter((b) => b.t >= tMin * 0.8 && b.t <= tMax && b.b - b.a >= Math.max(minLen, b.t * 2));
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

    // 4-0. 窗戶延伸：牆線端點外若接著「平行細線」（窗的畫法），沿線延伸並在該段留下窗戶缺口
    let winCross = null;
    {
      // 窗戶截面：牆厚範圍內大多比周圍亮（玻璃 / 紙色），並有細線；地板或實牆都不符合
      const isWindowCross = (ln, u) => {
        const half = Math.round(ln.t / 2) + 1;
        let bright = 0, n = 0, lines = 0, runLen = 0, maxRun = 0;
        for (let d = -half; d <= half; d++) {
          const v = Math.round(ln.c + d);
          const i = ln.horizontal ? v * w + u : u * w + v;
          if (v < 0 || v >= (ln.horizontal ? h : w) || u < 0 || u >= (ln.horizontal ? w : h)) continue;
          n++;
          if (g[i] > mean[i] * 1.03) bright++;
          if (isLine(i)) { runLen++; if (runLen === 1) lines++; maxRun = Math.max(maxRun, runLen); } else runLen = 0;
        }
        return n > 0 && bright / n >= 0.35 && lines >= 1 && maxRun <= Math.max(4, ln.t * 0.4);
      };
      winCross = isWindowCross;
      const L2 = (ln) => (ln.horizontal ? w : h);
      for (const ln of lines) {
        // 從每一段牆的兩端往外探測（不只最外側），窗可能位於兩段牆之間
        const tips = [];
        for (const sg of ln.segs) {
          for (const dir of [-1, 1]) {
            const start = dir < 0 ? sg.a - 1 : sg.b;
            let u = start, ok = 0, miss = 0, end = start;
            const maxExt = mode * 16; // 窗寬上限約 2.7 m（以牆厚 17 cm 估）
            while (u >= 0 && u < L2(ln) && Math.abs(u - start) <= maxExt && miss <= Math.max(3, mode * 0.3)) {
              if (isWindowCross(ln, u)) { ok++; miss = 0; end = u; } else miss++;
              u += dir;
            }
            const len = Math.abs(end - start);
            if (ok >= mode * 1.5 && ok >= len * 0.6 && Math.abs(u - start) <= maxExt) {
              // 在窗戶尾端補一小段牆，讓中間形成缺口（之後判定為窗）
              tips.push(dir < 0 ? { ...sg, a: end - 2, b: end } : { ...sg, a: end + 1, b: end + 3 });
            }
          }
        }
        if (!tips.length) continue;
        const all = [...ln.segs, ...tips].sort((p, q) => p.a - q.a);
        const merged = [];
        for (const sg of all) {
          const lastSeg = merged[merged.length - 1];
          if (lastSeg && sg.a <= lastSeg.b) lastSeg.b = Math.max(lastSeg.b, sg.b); else merged.push({ ...sg });
        }
        ln.segs = merged;
      }
    }

    // 4-0b. 穿過實心深色區（結構柱）：牆端點沿線延伸，直到離開深色區
    for (const ln of lines) {
      const first = ln.segs[0], last = ln.segs[ln.segs.length - 1];
      const solid = (u) => {
        let n = 0, k = 0;
        for (let d = -Math.floor(ln.t / 4); d <= Math.floor(ln.t / 4); d++) {
          const v = Math.round(ln.c + d);
          if (v < 0 || v >= (ln.horizontal ? h : w) || u < 0 || u >= (ln.horizontal ? w : h)) continue;
          const i = ln.horizontal ? v * w + u : u * w + v;
          k++; if (g[i] < 90 || dark[i]) n++;
        }
        return k > 0 && n / k >= 0.8;
      };
      const L = ln.horizontal ? w : h;
      // 從端點往外：可先跨過不超過 3 個牆厚的窗框，再穿過至少 1.5 個牆厚的實心區
      const reach = (from, dir) => {
        let u = from, skip = 0;
        while (u >= 0 && u < L && skip <= mode * 3 && !solid(u)) { u += dir; skip++; }
        let n = 0;
        while (u >= 0 && u < L && n < mode * 8 && solid(u)) { u += dir; n++; }
        if (n > 2 && (skip === 0 || n >= mode * 1.5)) return u - dir;
        return null;
      };
      const ra = reach(first.a - 1, -1);
      if (ra !== null) first.a = ra;
      const rb = reach(last.b, 1);
      if (rb !== null) last.b = rb + 1;
    }

    // 4-1. 只保留最大的一組相連牆體，排除標題、索引圖、箭頭等平面圖以外的圖形
    {
      const segs = [];
      for (const ln of lines) for (const sg of ln.segs) {
        const half = ln.t / 2 + mode * 2; // 容許轉角厚塊、門窗缺口造成的分離
        segs.push({ ln, sg, r: ln.horizontal ? [sg.a - mode * 3, ln.c - half, sg.b + mode * 3, ln.c + half] : [ln.c - half, sg.a - mode * 3, ln.c + half, sg.b + mode * 3] });
      }
      const parent = segs.map((_, i) => i);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i].r, b = segs[j].r;
        if (a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]) parent[find(i)] = find(j);
      }
      // 同一條線上相隔一個門窗寬度內的段落也視為相連
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        if (segs[i].ln !== segs[j].ln) continue;
        const gap = Math.max(segs[i].sg.a, segs[j].sg.a) - Math.min(segs[i].sg.b, segs[j].sg.b);
        if (gap <= mode * 6) parent[find(i)] = find(j);
      }
      // 評分：牆總長 ×（1 − 範圍內深色比例）²。標題橫幅等實心深色區塊內的「牆」範圍幾乎全黑，分數會很低
      const comp = new Map();
      for (let i = 0; i < segs.length; i++) {
        const k = find(i), r = segs[i].r;
        const c = comp.get(k) || { len: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        c.len += segs[i].sg.b - segs[i].sg.a;
        c.x0 = Math.min(c.x0, r[0]); c.y0 = Math.min(c.y0, r[1]); c.x1 = Math.max(c.x1, r[2]); c.y1 = Math.max(c.y1, r[3]);
        comp.set(k, c);
      }
      let keep = null, keepScore = -1;
      for (const [k, c] of comp) {
        let n = 0, a = 0;
        const step = Math.max(1, Math.round(Math.sqrt(((c.x1 - c.x0) * (c.y1 - c.y0)) / 20000)));
        for (let y = Math.max(0, Math.floor(c.y0)); y < Math.min(h, c.y1); y += step) for (let x = Math.max(0, Math.floor(c.x0)); x < Math.min(w, c.x1); x += step) { a++; n += g[y * w + x] < 110 ? 1 : 0; }
        const fill = a ? n / a : 1; // 以絕對亮度計算，避免自適應門檻把實心色塊變成空心
        const score = c.len * (1 - fill) ** 2;
        if (score > keepScore) { keepScore = score; keep = k; }
      }
      const kept = new Set(segs.filter((_, i) => find(i) === keep).map((x) => x.sg));
      for (const ln of lines) ln.segs = ln.segs.filter((sg) => kept.has(sg));
      for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].segs.length) lines.splice(i, 1);
    }

    // 5. 缺口分類（門 / 窗 / 門洞）
    const thin = new Uint8Array(g.length);
    for (let i = 0; i < g.length; i++) thin[i] = isLine(i) && !wall[i] ? 1 : 0;
    const count = (x0, y0, x1, y1) => {
      let n = 0, a = 0;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) { a++; n += thin[y * w + x]; }
      return { n, a: a || 1 };
    };
    const countRaw = (x0, y0, x1, y1) => {
      let n = 0, a = 0;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) { a++; n += isLine(y * w + x) ? 1 : 0; }
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
          // 窗：缺口內多數截面為「亮底 + 細線」（照片中的木地板紋理不會符合）
          // 照片（自適應門檻）用較嚴格的判定；繪製的平面圖用缺口內細線比例即可
          window: best.k
            ? (() => { let k = 0, n = 0; for (let u = Math.ceil(a); u < b; u++) { n++; if (winCross(ln, u)) k++; } return n > 0 && k / n >= 0.35; })()
            : inGap.n / inGap.a > 0.06,
          swing: Math.max(sideA.n / sideA.a, sideB.n / sideB.a),
          swingA,
          hingeEnd: sB.n > sA.n,
          // 門片直線（鉸鏈端的細線）密度：判斷是否真的是門
          leaf: Math.max(sA.n / sA.a, sB.n / sB.a),
        });
      }
    }
    return { ok: true, w, h, mode, th, lines, gaps };
  }
}

/**
 * 依比例尺（公分 / 像素）把分析結果轉成專案資料
 */
export function buildProject(an, scale, { name = '圖片匯入的平面圖' } = {}) {
  const S = scale;
  // 外框：用於判斷外牆
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  // 外框只看夠長的牆（排除文字、標註殘留的小線段）
  for (const ln of an.lines) for (const s of ln.segs) {
    if (ln.segs.reduce((t, q) => t + q.b - q.a, 0) < ln.t * 10) continue;
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
      // 只有門寬以內、或有窗線的缺口才連成同一面牆；更大的空缺是開放空間
      if (cur && gap && (gapCm <= 180 || (gap.window && gapCm <= 400))) {
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
  const tol = (w) => w.thickness * 1.5 + 10;
  const isH = (w) => w.y1 === w.y2;
  const span = (o) => (isH(o) ? [Math.min(o.x1, o.x2), Math.max(o.x1, o.x2)] : [Math.min(o.y1, o.y2), Math.max(o.y1, o.y2)]);
  // 端點最近的垂直牆（距離在 maxD 內，且垂直牆的範圍涵蓋端點）
  const nearestPerp = (w, end, maxD) => {
    const px = w[`x${end}`], py = w[`y${end}`];
    let best = null;
    for (const o of walls) {
      if (o === w || isH(o) === isH(w)) continue;
      const pos = isH(w) ? o.x1 : o.y1, cross = isH(w) ? py : px, cur = isH(w) ? px : py;
      const [lo, hi] = span(o);
      if (cross < lo - tol(o) || cross > hi + tol(o)) continue;
      const d = Math.abs(pos - cur);
      if (d <= maxD(o) && (!best || d < best.d)) best = { d, pos, o };
    }
    return best;
  };
  const setEnd = (w, end, v) => { if (isH(w)) w[`x${end}`] = v; else w[`y${end}`] = v; };
  const snapAll = () => {
    for (const w of walls) for (const end of ['1', '2']) {
      const b = nearestPerp(w, end, (o) => tol(w) + o.thickness / 2);
      if (b) setEnd(w, end, b.pos);
    }
  };
  snapAll();
  snapAll();
  // 門緊貼牆角：牆的一端已接上其他牆、另一端停在垂直牆前 40 ~ 130 cm，延伸過去並在延伸段放門
  const attached = (w, end) => !!nearestPerp(w, end, (o) => o.thickness / 2 + 2);
  for (const w of walls) {
    for (const end of ['1', '2']) {
      const other = end === '1' ? '2' : '1';
      if (attached(w, end) || !attached(w, other)) continue;
      const cur = isH(w) ? w[`x${end}`] : w[`y${end}`];
      const outward = Math.sign(cur - (isH(w) ? w[`x${other}`] : w[`y${other}`]));
      let near = null;
      for (const o of walls) {
        if (o === w || isH(o) === isH(w)) continue;
        const pos = isH(w) ? o.x1 : o.y1, cross = isH(w) ? w[`y${end}`] : w[`x${end}`];
        const [lo, hi] = span(o);
        if (cross < lo - tol(o) * 2 || cross > hi + tol(o) * 2) continue;
        const clear = (pos - cur) * outward - o.thickness / 2;
        if (clear >= 40 && clear <= 130 && (!near || clear < near.clear)) near = { clear, pos, o };
      }
      if (!near) continue;
      const origin = isH(w) ? ox * S : oy * S;
      const a = cur, b = near.pos - outward * (near.o.thickness / 2);
      w._ops.push({ u0: Math.min(a, b) + origin, u1: Math.max(a, b) + origin, exterior: false, gap: { filled: 0, swing: 0.02, leaf: 0.05, swingA: true, hingeEnd: false } });
      setEnd(w, end, near.pos);
    }
  }
  snapAll();

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
      if (g.window) {
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
  // 門寬約為外牆厚的 4 ~ 6 倍；太窄的缺口多半是雜訊，不列入比例推估
  const doors = an.gaps.filter((g) => !g.window && isDoor(g) && g.len >= an.mode * 3.5 && g.len <= an.mode * 9).map((g) => g.len).sort((a, b) => a - b);
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
