// 幾何工具：所有平面座標單位皆為公分 (cm)，x 向右、y 向下（與螢幕一致）。

export const EPS = 1e-6;

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

export function snap(v, step) {
  return step > 0 ? Math.round(v / step) * step : v;
}

export function deg2rad(d) { return (d * Math.PI) / 180; }
export function rad2deg(r) { return (r * 180) / Math.PI; }
export function normDeg(d) { d %= 360; return d < 0 ? d + 360 : d; }

// 點到線段的最近點與距離
export function projectToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > EPS ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = clamp(t, 0, 1);
  const x = ax + dx * t, y = ay + dy * t;
  return { x, y, t, d: Math.hypot(px - x, py - y) };
}

export function wallLength(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

// 牆的區域座標系：u 沿牆方向（由起點量起），v 為法線方向（A 側為正）
export function wallFrame(w) {
  const L = wallLength(w) || 1;
  const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
  return { L, ux, uy, nx: -uy, ny: ux, angle: Math.atan2(uy, ux) };
}

export function toWallLocal(w, px, py) {
  const f = wallFrame(w);
  const dx = px - w.x1, dy = py - w.y1;
  return { u: dx * f.ux + dy * f.uy, v: dx * f.nx + dy * f.ny, f };
}

export function fromWallLocal(w, u, v) {
  const f = wallFrame(w);
  return { x: w.x1 + f.ux * u + f.nx * v, y: w.y1 + f.uy * u + f.ny * v };
}

// 多邊形
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function polygonCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < EPS) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonBBox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

// 旋轉後物件的四角（rot 為度，順時針）
export function rectCorners(cx, cy, w, d, rotDeg) {
  const r = deg2rad(rotDeg), c = Math.cos(r), s = Math.sin(r);
  const hw = w / 2, hd = d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

export function toLocal(cx, cy, rotDeg, px, py) {
  const r = deg2rad(-rotDeg), c = Math.cos(r), s = Math.sin(r);
  const dx = px - cx, dy = py - cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function aabbOfItem(it) {
  const pts = rectCorners(it.x, it.y, it.w, it.d, it.rot || 0);
  const b = polygonBBox(pts);
  return b;
}

export function aabbOverlap(a, b, pad = 0) {
  return a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;
}

// 移除共線點
export function simplifyPolygon(pts, tol = 0.5) {
  let out = pts.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cross) / len < tol || Math.hypot(b[0] - a[0], b[1] - a[1]) < tol) {
        out.splice(i, 1); changed = true; break;
      }
    }
  }
  return out;
}

function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < EPS) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u, x: a[0] + r[0] * t, y: a[1] + r[1] * t };
}

/**
 * 由牆體中心線自動偵測封閉房間（平面圖面偵測）。
 * 回傳多邊形陣列（每個為 [[x,y],...]）。
 */
export function detectRooms(walls) {
  const segs = walls.map((w) => [[w.x1, w.y1], [w.x2, w.y2]]).filter(([a, b]) => dist(a[0], a[1], b[0], b[1]) > 1);
  // 1. 找出每條線段上的切割點
  const cuts = segs.map(() => [0, 1]);
  const TOL = 2; // 端點吸附容差 cm
  for (let i = 0; i < segs.length; i++) {
    for (let j = 0; j < segs.length; j++) {
      if (i === j) continue;
      const [a, b] = segs[i], [c, d] = segs[j];
      if (j > i) {
        const hit = segIntersect(a, b, c, d);
        if (hit) { cuts[i].push(hit.t); cuts[j].push(hit.u); }
      }
      // T 字接頭：j 的端點落在 i 上
      for (const p of [c, d]) {
        const pr = projectToSegment(p[0], p[1], a[0], a[1], b[0], b[1]);
        if (pr.d < TOL) cuts[i].push(pr.t);
      }
    }
  }
  // 2. 建立頂點與邊
  const verts = [];
  const key = (x, y) => {
    for (let k = 0; k < verts.length; k++) if (dist(verts[k][0], verts[k][1], x, y) < TOL) return k;
    verts.push([x, y]);
    return verts.length - 1;
  };
  const edgeSet = new Set();
  const adj = new Map();
  const addEdge = (u, v) => {
    if (u === v) return;
    const k = u < v ? `${u}-${v}` : `${v}-${u}`;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    if (!adj.has(u)) adj.set(u, new Set());
    if (!adj.has(v)) adj.set(v, new Set());
    adj.get(u).add(v); adj.get(v).add(u);
  };
  segs.forEach(([a, b], i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(clamp(t, 0, 1) * 1e5) / 1e5))].sort((x, y) => x - y);
    let prev = null;
    for (const t of ts) {
      const id = key(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      if (prev !== null) addEdge(prev, id);
      prev = id;
    }
  });
  // 3. 移除懸空邊
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [v, nb] of adj) {
      if (nb.size <= 1) {
        for (const u of nb) adj.get(u)?.delete(v);
        adj.delete(v);
        pruned = true;
      }
    }
  }
  // 4. 每個頂點的鄰邊依角度排序
  const sorted = new Map();
  for (const [v, nb] of adj) {
    const [vx, vy] = verts[v];
    sorted.set(v, [...nb].sort((p, q) => Math.atan2(verts[p][1] - vy, verts[p][0] - vx) - Math.atan2(verts[q][1] - vy, verts[q][0] - vx)));
  }
  // 5. 半邊遍歷找面
  const visited = new Set();
  const faces = [];
  for (const [u, nb] of sorted) {
    for (const v of nb) {
      if (visited.has(`${u}>${v}`)) continue;
      const face = [];
      let a = u, b = v, guard = 0;
      while (!visited.has(`${a}>${b}`) && guard++ < 10000) {
        visited.add(`${a}>${b}`);
        face.push(verts[a]);
        const list = sorted.get(b);
        const idx = list.indexOf(a);
        const next = list[(idx - 1 + list.length) % list.length];
        a = b; b = next;
      }
      if (face.length >= 3) faces.push(face);
    }
  }
  // 6. 依符號區分外框與內部房間
  const withArea = faces.map((f) => ({ f, a: polygonArea(f) }));
  if (!withArea.length) return [];
  // 以面積符號：外框面（每個連通區塊最大者）與內面符號相反
  const maxAbs = withArea.reduce((m, x) => (Math.abs(x.a) > Math.abs(m.a) ? x : m), withArea[0]);
  const outerSign = Math.sign(maxAbs.a);
  return withArea
    .filter((x) => Math.sign(x.a) === -outerSign && Math.abs(x.a) > 5000) // > 0.5 m²
    .map((x) => simplifyPolygon(x.f.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10])));
}

/**
 * 在多邊形內找最大的軸對齊矩形（座標壓縮法）。
 */
export function largestInnerRect(pts) {
  const bb = polygonBBox(pts);
  const xsSet = new Set(pts.map((p) => p[0]));
  const ysSet = new Set(pts.map((p) => p[1]));
  const N = 16;
  for (let i = 0; i <= N; i++) {
    xsSet.add(bb.x0 + ((bb.x1 - bb.x0) * i) / N);
    ysSet.add(bb.y0 + ((bb.y1 - bb.y0) * i) / N);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const nx = xs.length - 1, ny = ys.length - 1;
  const inside = [];
  for (let i = 0; i < nx; i++) {
    inside[i] = [];
    for (let j = 0; j < ny; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      inside[i][j] = pointInPolygon(cx, cy, pts);
    }
  }
  let best = null, bestA = 0;
  for (let i0 = 0; i0 < nx; i0++) {
    for (let j0 = 0; j0 < ny; j0++) {
      if (!inside[i0][j0]) continue;
      let jMax = ny;
      for (let i1 = i0; i1 < nx; i1++) {
        if (!inside[i1][j0]) break;
        let j1 = j0;
        while (j1 < jMax && inside[i1][j1]) j1++;
        jMax = j1;
        const a = (xs[i1 + 1] - xs[i0]) * (ys[jMax] - ys[j0]);
        if (a > bestA) { bestA = a; best = { x0: xs[i0], y0: ys[j0], x1: xs[i1 + 1], y1: ys[jMax] }; }
      }
    }
  }
  return best || bb;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
}

// 可重現的亂數
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const PING = 3.305785; // 1 坪 = 3.3058 m²
export function areaText(cm2) {
  const m2 = Math.abs(cm2) / 10000;
  return `${m2.toFixed(1)} m²（${(m2 / PING).toFixed(1)} 坪）`;
}
