// 由專案資料衍生的幾何：牆角接合、門窗位置、房間與牆面關係
import { wallFrame, projectToSegment, pointInPolygon, dist } from './geometry.js';

const JOIN_TOL = 3;

// 每面牆兩端是否與其他牆相接（相接時延伸半個牆厚，讓轉角封閉）
export function wallJoins(walls) {
  const res = new Map();
  for (const w of walls) {
    let extS = 0, extE = 0;
    for (const o of walls) {
      if (o === w) continue;
      for (const [px, py, which] of [[w.x1, w.y1, 's'], [w.x2, w.y2, 'e']]) {
        const touchEnd = dist(px, py, o.x1, o.y1) < JOIN_TOL || dist(px, py, o.x2, o.y2) < JOIN_TOL;
        const onSeg = projectToSegment(px, py, o.x1, o.y1, o.x2, o.y2).d < JOIN_TOL;
        if (!touchEnd && !onSeg) continue;
        // 共線延伸的牆不需要延長
        const f1 = wallFrame(w), f2 = wallFrame(o);
        const parallel = Math.abs(f1.ux * f2.uy - f1.uy * f2.ux) < 0.05;
        if (parallel) continue;
        const e = o.thickness / 2;
        if (which === 's') extS = Math.max(extS, e); else extE = Math.max(extE, e);
      }
    }
    res.set(w.id, { extS, extE });
  }
  return res;
}

export function wallPolygon(w, join = { extS: 0, extE: 0 }) {
  const f = wallFrame(w);
  const t = w.thickness / 2;
  const sx = w.x1 - f.ux * join.extS, sy = w.y1 - f.uy * join.extS;
  const ex = w.x2 + f.ux * join.extE, ey = w.y2 + f.uy * join.extE;
  return [
    [sx + f.nx * t, sy + f.ny * t],
    [ex + f.nx * t, ey + f.ny * t],
    [ex - f.nx * t, ey - f.ny * t],
    [sx - f.nx * t, sy - f.ny * t],
  ];
}

export function openingCenter(op, w) {
  const f = wallFrame(w);
  return { x: w.x1 + f.ux * op.offset, y: w.y1 + f.uy * op.offset, f };
}

// 找到離某點最近的牆（回傳牆、沿牆位置 u 與距離）
export function nearestWall(walls, x, y, maxDist = Infinity) {
  let best = null;
  for (const w of walls) {
    const pr = projectToSegment(x, y, w.x1, w.y1, w.x2, w.y2);
    if (pr.d < maxDist && (!best || pr.d < best.d)) {
      best = { wall: w, u: pr.t * Math.hypot(w.x2 - w.x1, w.y2 - w.y1), d: pr.d, x: pr.x, y: pr.y };
    }
  }
  return best;
}

// 牆的哪一側面向房間：'A'（法線正向）/'B'/null
export function wallSideToward(w, room) {
  const f = wallFrame(w);
  const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
  const off = w.thickness / 2 + 4;
  const sides = [];
  // 取牆上數個點測試，避免房間只覆蓋部分牆段
  // 牆可能橫跨多個房間，沿整面牆取樣
  for (let k = 1; k < 40; k++) {
    const t = k / 40;
    const px = w.x1 + (w.x2 - w.x1) * t, py = w.y1 + (w.y2 - w.y1) * t;
    if (pointInPolygon(px + f.nx * off, py + f.ny * off, room.points)) sides.push('A');
    else if (pointInPolygon(px - f.nx * off, py - f.ny * off, room.points)) sides.push('B');
  }
  void mx; void my;
  if (!sides.length) return null;
  const a = sides.filter((s) => s === 'A').length;
  return a >= sides.length - a ? 'A' : 'B';
}

// 牆是否在房間邊界上：牆中心線與房間某條邊共線，且兩者投影重疊超過 10 cm
export function wallOnRoom(w, room) {
  const pts = room.points;
  const f = wallFrame(w);
  const tol = w.thickness / 2 + 3;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    // 房間邊的兩端點到牆中心線的距離
    const da = Math.abs((ax - w.x1) * f.nx + (ay - w.y1) * f.ny);
    const db = Math.abs((bx - w.x1) * f.nx + (by - w.y1) * f.ny);
    if (da > tol || db > tol) continue;
    const ua = (ax - w.x1) * f.ux + (ay - w.y1) * f.uy;
    const ub = (bx - w.x1) * f.ux + (by - w.y1) * f.uy;
    const lo = Math.max(0, Math.min(ua, ub)), hi = Math.min(f.L, Math.max(ua, ub));
    if (hi - lo > 10) return true;
  }
  return false;
}

export function roomAt(rooms, x, y) {
  // 取最小面積的包含房間
  let best = null, bestA = Infinity;
  for (const r of rooms) {
    if (!pointInPolygon(x, y, r.points)) continue;
    let a = 0;
    for (let i = 0; i < r.points.length; i++) {
      const [x1, y1] = r.points[i], [x2, y2] = r.points[(i + 1) % r.points.length];
      a += x1 * y2 - x2 * y1;
    }
    a = Math.abs(a);
    if (a < bestA) { bestA = a; best = r; }
  }
  return best;
}

export function projectBounds(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const w of p.walls) { add(w.x1, w.y1); add(w.x2, w.y2); }
  for (const r of p.rooms) for (const [x, y] of r.points) add(x, y);
  for (const it of p.items) add(it.x, it.y);
  if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 1000, y1: 800, empty: true };
  return { x0, y0, x1, y1 };
}
