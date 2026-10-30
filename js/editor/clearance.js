// 動線與尺寸健檢：依常見的人體工學尺寸，檢查走道寬度、家具前方的使用空間、門片開啟範圍、
// 沙發與茶几、電視的距離，以及家具重疊、超出房間、高櫃擋窗等問題。
// 動線以 5 公分的格子計算：每格到最近障礙物（牆、家具、室外）的距離 ×2 即為可通行的寬度，
// 再找出從起點到目標「最窄處最寬」的路線，最窄處就是這條動線的瓶頸。
import { store } from '../core/state.js';
import { wallFrame, pointInPolygon, polygonBBox } from '../core/geometry.js';
import { openingCenter, roomAt } from '../core/model.js';
import { OPENING_MAP, CATALOG_MAP } from '../data/catalog.js';
import { analyzeRooms } from '../ai/designer.js';

const CELL = 5;
const SCORE = { warn: 10, tip: 4 };
const rad = (d) => ((d || 0) * Math.PI) / 180;
const frontOf = (it) => [-Math.sin(rad(it.rot)), Math.cos(rad(it.rot))];
const sideOf = (it) => [Math.cos(rad(it.rot)), Math.sin(rad(it.rot))];
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k];
const nameOf = (it) => it.name || CATALOG_MAP[it.kind]?.name || '家具';

// 不算地面障礙的家具：地毯、吊掛或放在其他家具上的物品（離地 40 公分以上）、吊燈、窗簾
const FLAT = new Set(['rug', 'rug_round']);
const isObstacle = (it) => {
  const def = CATALOG_MAP[it.kind];
  if (!def || FLAT.has(it.kind) || def.ceiling || it.kind === 'curtain') return false;
  return (it.elev || 0) < 40;
};

// 家具前方需要的使用空間（公分）：ok 以上為理想，warn 以下為需注意
const FRONT = {
  wardrobe: { ok: 70, warn: 55, what: '衣櫃門前', why: '開門、拿取衣物需要的空間' },
  dresser: { ok: 70, warn: 55, what: '化妝台前', why: '坐下使用與拉椅子的空間' },
  chest: { ok: 70, warn: 55, what: '斗櫃前', why: '拉出抽屜並站著拿取的空間' },
  sideboard: { ok: 70, warn: 55, what: '餐邊櫃前', why: '開門拿取物品的空間' },
  shoe_cabinet: { ok: 70, warn: 50, what: '鞋櫃前', why: '開門、彎腰穿鞋的空間' },
  tall_cabinet: { ok: 70, warn: 55, what: '高櫃前', why: '開門拿取物品的空間' },
  bookshelf: { ok: 70, warn: 50, what: '書櫃前', why: '站著找書、拿取的空間' },
  kitchen_base: { ok: 90, warn: 75, what: '流理台前', why: '備料、開下櫃與洗碗機的工作走道' },
  fridge: { ok: 90, warn: 70, what: '冰箱前', why: '冰箱門完全打開並站著拿取的空間' },
  washer: { ok: 70, warn: 55, what: '洗衣機前', why: '開門放取衣物的空間' },
  toilet: { ok: 60, warn: 45, what: '馬桶前', why: '坐下、起身需要的空間' },
  vanity: { ok: 70, warn: 55, what: '洗手台前', why: '彎腰洗臉需要的空間' },
  desk: { ok: 90, warn: 70, what: '書桌前（含椅子）', why: '拉出椅子坐下、起身需要的空間', ignore: ['office_chair'] },
};
const BEDS = new Set(['bed_double', 'bed_queen', 'bed_single']);
const SOFAS = new Set(['sofa3', 'sofa2', 'sofa_curve', 'sofa_l', 'armchair']);
const TABLES = new Set(['dining_table', 'dining_round']);

// 平面上的障礙：牆（含厚度，門洞可通過）、家具、室外
export function makeWorld(P) {
  const ops = [];
  for (const op of P.openings) {
    const def = OPENING_MAP[op.kind];
    const w = P.walls.find((x) => x.id === op.wallId);
    if (!def || !w) continue;
    const c = openingCenter(op, w), f = wallFrame(w);
    ops.push({ op, def, w, c: [c.x, c.y], u: [f.ux, f.uy], n: [f.nx, f.ny], half: (op.width || def.width) / 2, door: def.cat === 'door' });
  }
  const obstacles = P.items.filter(isObstacle);
  const inDoor = (x, y) => ops.some((o) => {
    if (!o.door) return false;
    const dx = x - o.c[0], dy = y - o.c[1];
    return Math.abs(dx * o.u[0] + dy * o.u[1]) <= o.half - 3 && Math.abs(dx * o.n[0] + dy * o.n[1]) <= (o.w.thickness || 12) / 2 + 2;
  });
  const inWall = (x, y) => P.walls.some((w) => {
    const f = wallFrame(w), dx = x - w.x1, dy = y - w.y1;
    const u = dx * f.ux + dy * f.uy, v = dx * f.nx + dy * f.ny;
    return u >= -(w.thickness || 12) / 2 && u <= f.L + (w.thickness || 12) / 2 && Math.abs(v) <= (w.thickness || 12) / 2;
  }) && !inDoor(x, y);
  const inItem = (it, x, y, pad = 0) => {
    const r = -rad(it.rot), dx = x - it.x, dy = y - it.y;
    const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
    return Math.abs(lx) <= it.w / 2 + pad && Math.abs(ly) <= it.d / 2 + pad;
  };
  const indoor = (x, y) => P.rooms.some((r) => pointInPolygon(x, y, r.points)) || inDoor(x, y);
  return { ops, obstacles, inDoor, inWall, inItem, indoor };
}

// 從 p 沿 d 方向量淨空距離（遇到牆、室外或其他家具停止），最多 max 公分
export function freeAhead(W, p, d, max, skip) {
  for (let t = 2; t <= max; t += 2) {
    const x = p[0] + d[0] * t, y = p[1] + d[1] * t;
    if (!W.indoor(x, y) || W.inWall(x, y)) return t;
    if (W.obstacles.some((o) => !skip(o) && W.inItem(o, x, y))) return t;
  }
  return max;
}

// 家具某一側的淨空：從該邊（離中心 depth 公分）沿邊取 3 點往外量測，取最小值
function sideClearance(W, it, dir, along, half, depth, max, skip) {
  let best = Infinity, at = null;
  for (const k of [-0.7, 0, 0.7]) {
    const edge = add(add([it.x, it.y], dir, depth), along, half * k);
    const t = freeAhead(W, edge, dir, max, skip);
    if (t < best) { best = t; at = edge; }
  }
  return { free: best, at };
}

// 旋轉矩形四角與重疊判斷（分離軸）
function corners(it, shrink = 0) {
  const a = rad(it.rot), c = Math.cos(a), s = Math.sin(a);
  const hw = Math.max(0, it.w / 2 - shrink), hd = Math.max(0, it.d / 2 - shrink);
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => [it.x + x * c - y * s, it.y + x * s + y * c]);
}
function overlaps(a, b, tol = 3) {
  const A = corners(a, tol), B = corners(b, tol);
  for (const poly of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % 4];
      const nx = -(y2 - y1), ny = x2 - x1;
      const pa = A.map(([x, y]) => x * nx + y * ny), pb = B.map(([x, y]) => x * nx + y * ny);
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------- 動線格子
function buildGrid(P, W) {
  const all = P.rooms.flatMap((r) => r.points);
  if (!all.length) return null;
  const bb = polygonBBox(all);
  const x0 = bb.x0 - 30, y0 = bb.y0 - 30;
  const nx = Math.ceil((bb.x1 - x0 + 30) / CELL), ny = Math.ceil((bb.y1 - y0 + 30) / CELL);
  const blocked = new Uint8Array(nx * ny), door = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * CELL, y = y0 + (j + 0.5) * CELL;
      const k = j * nx + i;
      if (W.inDoor(x, y)) { door[k] = 1; continue; }
      if (!W.indoor(x, y) || W.inWall(x, y) || W.obstacles.some((o) => W.inItem(o, x, y))) blocked[k] = 1;
    }
  }
  // 距離轉換（3-4 倒角距離）：每格到最近障礙的距離（公分）
  const INF = 1e9, d = new Float32Array(nx * ny);
  for (let k = 0; k < d.length; k++) d[k] = blocked[k] ? 0 : INF;
  const pass = (order) => {
    for (const j of order.ys) for (const i of order.xs) {
      const k = j * nx + i;
      if (!d[k]) continue;
      for (const [di, dj, c] of order.nb) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const v = d[b * nx + a] + c;
        if (v < d[k]) d[k] = v;
      }
    }
  };
  const xs = [...Array(nx).keys()], ys = [...Array(ny).keys()];
  pass({ xs, ys, nb: [[-1, 0, 10], [0, -1, 10], [-1, -1, 14], [1, -1, 14]] });
  pass({ xs: [...xs].reverse(), ys: [...ys].reverse(), nb: [[1, 0, 10], [0, 1, 10], [1, 1, 14], [-1, 1, 14]] });
  // 可通行寬度 ≈ 到障礙距離 ×2；門框本身的寬度不計（另外由門的尺寸決定）
  const width = new Float32Array(nx * ny);
  for (let k = 0; k < d.length; k++) width[k] = blocked[k] ? 0 : door[k] ? 999 : Math.max(0, d[k] * 2 - CELL);
  return { x0, y0, nx, ny, width, blocked };
}
const cellOf = (G, p) => [Math.floor((p[0] - G.x0) / CELL), Math.floor((p[1] - G.y0) / CELL)];
const centerOf = (G, i, j) => [G.x0 + (i + 0.5) * CELL, G.y0 + (j + 0.5) * CELL];

// 找最近的可通行格子
function nearestFree(G, p, R = 12) {
  const [ci, cj] = cellOf(G, p);
  let best = null, bd = Infinity;
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= G.nx || j >= G.ny || G.blocked[j * G.nx + i]) continue;
    const dd = di * di + dj * dj;
    if (dd < bd) { bd = dd; best = [i, j]; }
  }
  return best;
}

// 最窄處最寬的路線（widest path），回傳瓶頸寬度、位置與路徑
function widestPath(G, from, to) {
  const s = nearestFree(G, from), t = nearestFree(G, to);
  if (!s || !t) return null;
  const N = G.nx * G.ny, best = new Float32Array(N).fill(-1), prev = new Int32Array(N).fill(-1);
  const si = s[1] * G.nx + s[0], ti = t[1] * G.nx + t[0];
  // 起點與終點附近 50 公分內（走到家具旁的最後一段）不算瓶頸
  const R = 50 / CELL;
  const wOf = (k) => {
    const i = k % G.nx, j = (k - i) / G.nx;
    return Math.hypot(i - s[0], j - s[1]) <= R || Math.hypot(i - t[0], j - t[1]) <= R ? 999 : G.width[k];
  };
  best[si] = 999;
  // 最大堆積：每次取出目前瓶頸最寬的格子
  const heap = [[best[si], si]];
  const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] >= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const down = (i) => { for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] > heap[m][0]) m = l; if (r < heap.length && heap[r][0] > heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
  const done = new Uint8Array(N);
  while (heap.length) {
    const [w0, k] = heap[0];
    const last = heap.pop();
    if (heap.length) { heap[0] = last; down(0); }
    if (done[k] || w0 < best[k]) continue;
    done[k] = 1;
    if (k === ti) break;
    const i = k % G.nx, j = (k - i) / G.nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, c = j + dj;
      if (a < 0 || c < 0 || a >= G.nx || c >= G.ny) continue;
      const n = c * G.nx + a;
      if (G.blocked[n] || done[n]) continue;
      const w = Math.min(best[k], wOf(n));
      if (w > best[n]) { best[n] = w; prev[n] = k; heap.push([w, n]); up(heap.length - 1); }
    }
  }
  if (best[ti] < 0) return { width: 0, path: [], at: to, blocked: true };
  const path = [];
  let at = null, minW = Infinity;
  for (let k = ti; k >= 0; k = prev[k]) {
    const i = k % G.nx, j = (k - i) / G.nx;
    path.push(centerOf(G, i, j));
    if (wOf(k) < minW) { minW = wOf(k); at = centerOf(G, i, j); }
    if (k === si) break;
  }
  path.reverse();
  return { width: Math.min(best[ti], 999), path, at };
}

export function checkClearance(P = store.project) {
  const W = makeWorld(P);
  const types = new Map(analyzeRooms(P).map((a) => [a.room.id, a.type]));
  const typeOf = (r) => (r ? types.get(r.id) || r.type : null);
  const found = [];
  const push = (f) => found.push({ id: `${f.rule}:${found.length}`, ...f });
  const roomOf = (it) => roomAt(P.rooms, it.x, it.y);

  // ---- 家具重疊、超出房間
  const obs = W.obstacles;
  for (let i = 0; i < obs.length; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      const a = obs[i], b = obs[j];
      // 椅子本來就會塞進桌下、靠在一起
      const chair = (k) => ['office_chair', 'dining_chair', 'bar_stool'].includes(k);
      if (chair(a.kind) || chair(b.kind)) {
        const other = chair(a.kind) ? b : a;
        if (chair(other.kind) || ['desk', 'dining_table', 'dining_round', 'kitchen_base', 'kitchen_counter', 'dresser'].includes(other.kind)) continue;
      }
      if (overlaps(a, b)) {
        push({ rule: 'overlap', level: 'warn', title: `${nameOf(a)}與${nameOf(b)}重疊`, detail: '兩件家具的範圍互相重疊，實際上放不下。', fix: '移開其中一件，或縮小尺寸。', items: [a.id, b.id] });
      }
    }
  }
  for (const it of obs) {
    if (it.kind.startsWith('fence')) continue;
    const out = corners(it, 4).filter(([x, y]) => !P.rooms.some((r) => pointInPolygon(x, y, r.points)));
    if (out.length >= 2) push({ rule: 'outside', level: 'warn', title: `${nameOf(it)}超出房間`, detail: '家具有一部分在牆外或房間外。', fix: '移回房間內，或調整尺寸、方向。', items: [it.id] });
  }

  // ---- 門片開啟範圍被擋
  for (const o of W.ops) {
    if (!o.door || !['door', 'double'].includes(o.def.type)) continue;
    const sv = o.op.flipV ? -1 : 1, sh = o.op.flipH ? -1 : 1, t = (o.w.thickness || 12) / 2;
    const leaves = o.def.type === 'door' ? [{ hx: -o.half * sh, L: o.half * 2, dir: sh }] : [{ hx: -o.half, L: o.half, dir: 1 }, { hx: o.half, L: o.half, dir: -1 }];
    let hit = null;
    for (const lf of leaves) {
      for (let r = 10; r <= lf.L - 4 && !hit; r += 8) {
        for (let a = 0.05; a <= Math.PI / 2 && !hit; a += 0.12) {
          const lx = lf.hx + lf.dir * r * Math.sin(a), ly = (t + r * Math.cos(a)) * sv;
          const x = o.c[0] + o.u[0] * lx + o.n[0] * ly, y = o.c[1] + o.u[1] * lx + o.n[1] * ly;
          const it = obs.find((ob) => W.inItem(ob, x, y));
          if (it) hit = { it, p: [x, y] };
        }
      }
    }
    if (hit) {
      push({
        rule: 'door-swing', level: 'warn', title: `${o.def.name}開門會撞到${nameOf(hit.it)}`,
        detail: `門片開啟的範圍內有${nameOf(hit.it)}，門無法完全打開。`,
        fix: '把家具移出門片開啟的範圍，或在屬性面板切換開門方向，也可以改用推拉門。',
        items: [hit.it.id], ops: [o.op.id], marks: [{ p: hit.p }],
      });
    }
  }

  // ---- 家具前方的使用空間
  for (const it of obs) {
    const spec = FRONT[it.kind];
    if (!spec) continue;
    const f = frontOf(it), s = sideOf(it);
    const skip = (o) => o === it || (spec.ignore || []).includes(o.kind);
    const { free, at } = sideClearance(W, it, f, s, it.w / 2, it.d / 2, spec.ok + 40, skip);
    if (free >= spec.ok) continue;
    push({
      rule: 'front', level: free < spec.warn ? 'warn' : 'tip', title: `${spec.what}空間不足（${Math.round(free)} 公分）`,
      detail: `${roomOf(it)?.name || ''}${nameOf(it)}前方只有 ${Math.round(free)} 公分，建議至少 ${spec.ok} 公分（${spec.why}）。`,
      fix: `把${nameOf(it)}或前方的家具移開，讓前方淨空達到 ${spec.ok} 公分。`,
      items: [it.id], lines: [[at, add(at, f, free)]], marks: [{ p: add(at, f, free / 2), label: `${Math.round(free)}` }],
    });
  }

  // ---- 床：兩側與床尾
  for (const it of obs.filter((x) => BEDS.has(x.kind))) {
    const f = frontOf(it), s = sideOf(it);
    const skip = (o) => o === it || o.kind === 'nightstand';
    const sides = [s, [-s[0], -s[1]]].map((d) => {
      // 床側淨空量在床身中段到床尾之間（床頭櫃所在的床頭區不算）
      let best = Infinity, at = null;
      for (const k of [0, 0.35]) {
        const edge = add(add([it.x, it.y], f, it.d * k), d, it.w / 2);
        const t = freeAhead(W, edge, d, 120, skip);
        if (t < best) { best = t; at = edge; }
      }
      return { free: best, at, d };
    });
    const single = it.kind === 'bed_single';
    const wide = sides.filter((x) => x.free >= 50).length;
    const tight = sides.filter((x) => x.free > 8 && x.free < 50);
    if (!single && wide < 2 && tight.length) {
      for (const sd of tight) {
        push({
          rule: 'bed-side', level: sd.free < 35 ? 'warn' : 'tip', title: `床側走道太窄（${Math.round(sd.free)} 公分）`,
          detail: `${roomOf(it)?.name || ''}雙人床一側只有 ${Math.round(sd.free)} 公分，建議至少 50 公分，上下床、整理床鋪比較方便。`,
          fix: '把床往另一側移，或縮小床頭櫃、改用壁掛床頭板。',
          items: [it.id], lines: [[sd.at, add(sd.at, sd.d, sd.free)]], marks: [{ p: add(sd.at, sd.d, sd.free / 2), label: `${Math.round(sd.free)}` }],
        });
      }
    } else if (!single && wide < 1) {
      push({ rule: 'bed-side', level: 'warn', title: '雙人床兩側都靠牆', detail: '雙人床兩側都沒有走道，靠內側的人上下床不便。', fix: '讓床至少一側（最好兩側）留 50 公分以上的走道。', items: [it.id] });
    } else if (single && wide < 1) {
      const sd = sides.reduce((a, b) => (a.free > b.free ? a : b));
      push({
        rule: 'bed-side', level: sd.free < 35 ? 'warn' : 'tip', title: `單人床旁走道太窄（${Math.round(sd.free)} 公分）`,
        detail: `單人床可上下的一側只有 ${Math.round(sd.free)} 公分，建議至少 50 公分。`, fix: '調整床或旁邊家具的位置。',
        items: [it.id], lines: [[sd.at, add(sd.at, sd.d, sd.free)]],
      });
    }
    const foot = sideClearance(W, it, f, s, it.w / 2, it.d / 2, 100, skip);
    if (foot.free < 60) {
      push({
        rule: 'bed-foot', level: foot.free < 45 ? 'warn' : 'tip', title: `床尾走道太窄（${Math.round(foot.free)} 公分）`,
        detail: `床尾到牆或家具只有 ${Math.round(foot.free)} 公分，建議至少 60 公分，才方便走動與整理床單。`,
        fix: '床往床頭牆靠，或移開床尾的家具。',
        items: [it.id], lines: [[foot.at, add(foot.at, f, foot.free)]], marks: [{ p: add(foot.at, f, foot.free / 2), label: `${Math.round(foot.free)}` }],
      });
    }
  }

  // ---- 餐桌四周（拉椅子坐下需要 75 公分）
  for (const it of obs.filter((x) => TABLES.has(x.kind))) {
    const f = frontOf(it), s = sideOf(it);
    const dirs = it.kind === 'dining_round' ? [f, [-f[0], -f[1]], s, [-s[0], -s[1]]] : [f, [-f[0], -f[1]]];
    for (const d of dirs) {
      const along = Math.abs(d[0] * f[0] + d[1] * f[1]) > 0.5 ? s : f;
      const half = along === s ? it.w / 2 : it.d / 2, depth = along === s ? it.d / 2 : it.w / 2;
      const { free, at } = sideClearance(W, it, d, along, half, depth, 120, (o) => o === it || ['bar_stool', 'dining_chair'].includes(o.kind));
      if (free >= 75) continue;
      push({
        rule: 'dining', level: free < 60 ? 'warn' : 'tip', title: `餐桌旁空間不足（${Math.round(free)} 公分）`,
        detail: `餐桌一側到牆或家具只有 ${Math.round(free)} 公分，建議至少 75 公分才能拉開椅子坐下；要讓人從後方通過則需 90 公分以上。`,
        fix: '餐桌往空間中央移，或改用較窄的餐桌、靠牆側改放長凳。',
        items: [it.id], lines: [[at, add(at, d, free)]], marks: [{ p: add(at, d, free / 2), label: `${Math.round(free)}` }],
      });
    }
  }

  // ---- 沙發與茶几、電視的距離
  for (const so of obs.filter((x) => SOFAS.has(x.kind) && x.kind !== 'armchair')) {
    const f = frontOf(so), edge = add([so.x, so.y], f, so.d / 2);
    const tables = obs.filter((x) => ['coffee_table', 'coffee_round'].includes(x.kind));
    let gap = null, tbl = null;
    for (const tb of tables) {
      for (let t = 0; t <= 150; t += 2) {
        if (W.inItem(tb, ...add(edge, f, t))) { if (gap === null || t < gap) { gap = t; tbl = tb; } break; }
      }
    }
    if (tbl && (gap < 30 || gap > 60)) {
      push({
        rule: 'sofa-table', level: gap < 20 ? 'warn' : 'tip', title: `沙發與茶几距離${gap < 30 ? '太近' : '太遠'}（${gap} 公分）`,
        detail: `${nameOf(so)}到${nameOf(tbl)}相距 ${gap} 公分，建議 35 到 50 公分：太近腳放不下、進出不便，太遠則拿不到桌上的東西。`,
        fix: `把${nameOf(tbl)}${gap < 30 ? '往外移' : '往沙發移近'}，讓間距在 35 到 50 公分之間。`,
        items: [so.id, tbl.id], lines: [[edge, add(edge, f, gap)]], marks: [{ p: add(edge, f, gap / 2), label: `${gap}` }],
      });
    }
    const tv = P.items.find((x) => x.kind === 'tv' && roomOf(x) === roomOf(so)) || P.items.find((x) => x.kind === 'tv_cabinet' && roomOf(x) === roomOf(so));
    if (tv) {
      const dx = tv.x - so.x, dy = tv.y - so.y;
      const dist = Math.hypot(dx, dy);
      const facing = (dx * f[0] + dy * f[1]) / (dist || 1) > 0.7;
      if (facing && (dist < 180 || dist > 400)) {
        push({
          rule: 'tv', level: 'tip', title: `電視觀看距離${dist < 180 ? '太近' : '太遠'}（約 ${Math.round(dist / 10) / 10} 公尺）`,
          detail: `沙發到電視約 ${Math.round(dist)} 公分。65 吋電視建議觀看距離約 2 到 3.5 公尺，太近容易眼睛疲勞，太遠看不清楚細節。`,
          fix: dist < 180 ? '沙發往後移，或改用較小的電視。' : '沙發往電視移近，或改用較大的電視。',
          items: [so.id, tv.id], lines: [[[so.x, so.y], [tv.x, tv.y]]],
        });
      }
    }
  }

  // ---- 高櫃擋窗
  for (const it of obs.filter((x) => (x.h || 0) >= 150 && !['curtain', 'shower', 'bathtub'].includes(x.kind) && !x.kind.startsWith('plant'))) {
    const back = add([it.x, it.y], frontOf(it), -it.d / 2 - 15);
    const win = W.ops.find((o) => !o.door && Math.hypot(back[0] - o.c[0], back[1] - o.c[1]) < o.half + it.w / 2 && Math.abs((back[0] - o.c[0]) * o.n[0] + (back[1] - o.c[1]) * o.n[1]) < 30
      && Math.abs((it.x - o.c[0]) * o.u[0] + (it.y - o.c[1]) * o.u[1]) < o.half + it.w / 2 - 10);
    if (win && (win.op.sill ?? win.def.sill ?? 0) < (it.elev || 0) + it.h) {
      push({ rule: 'block-window', level: 'tip', title: `${nameOf(it)}擋住窗戶`, detail: `${nameOf(it)}高 ${it.h} 公分，放在${win.def.name}前方，會擋住採光與通風，也無法開窗。`, fix: '移到沒有窗戶的牆，或改用低於窗台的矮櫃。', items: [it.id], ops: [win.op.id] });
    }
  }

  // ---- 動線：大門到各房間、房門到床邊與主要家具
  const G = buildGrid(P, W);
  const routes = [];
  if (G) {
    const entry = W.ops.find((o) => o.def.entry);
    const inside = (o, room) => {
      for (const sgn of [1, -1]) { const q = add(o.c, o.n, sgn * ((o.w.thickness || 12) / 2 + 30)); if (room ? pointInPolygon(q[0], q[1], room.points) : W.indoor(q[0], q[1])) return q; }
      return null;
    };
    const start = entry && inside(entry);
    const doorOf = (room) => W.ops.filter((o) => o.door && !o.def.entry && inside(o, room));
    if (start) {
      for (const r of P.rooms) {
        if (r.points.length < 3 || pointInPolygon(start[0], start[1], r.points)) continue;
        const d = doorOf(r).map((o) => inside(o, r)).filter(Boolean)[0];
        if (!d) continue;
        const res = widestPath(G, start, d);
        if (!res) continue;
        routes.push({ name: `大門到${r.name}`, res, main: true, room: r });
      }
    }
    for (const it of obs) {
      const room = roomOf(it);
      if (!room) continue;
      let target = null;
      if (BEDS.has(it.kind)) {
        const s = sideOf(it);
        const sides = [s, [-s[0], -s[1]]].map((d) => add([it.x, it.y], d, it.w / 2 + 30));
        target = sides.find((p) => G && nearestFree(G, p, 4));
      } else if (FRONT[it.kind] && !['kitchen_base'].includes(it.kind)) {
        target = add([it.x, it.y], frontOf(it), it.d / 2 + 30);
      } else if (SOFAS.has(it.kind) && it.kind !== 'armchair') {
        target = add([it.x, it.y], frontOf(it), it.d / 2 + 20);
      }
      if (!target) continue;
      const from = doorOf(room).map((o) => inside(o, room)).filter(Boolean)[0] || (pointInPolygon(start?.[0], start?.[1], room.points) ? start : null);
      if (!from) continue;
      const res = widestPath(G, from, target);
      if (res) routes.push({ name: `${room.name}門口到${nameOf(it)}`, res, main: false, item: it });
    }
    for (const rt of routes) {
      const w = rt.res.width;
      const ok = rt.main ? 80 : 60, warn = rt.main ? 65 : 45;
      if (w >= ok) continue;
      const blocked = rt.res.blocked || w < 25;
      push({
        rule: 'route', level: w < warn ? 'warn' : 'tip',
        title: blocked ? `${rt.name}被擋住` : `${rt.name}的通道太窄（${Math.round(w)} 公分）`,
        detail: blocked ? `從${rt.name.replace('到', '走到')}的路線被家具擋住，過不去。` : `這條${rt.main ? '主要' : ''}動線最窄處只有約 ${Math.round(w)} 公分，建議${rt.main ? '主要動線至少 80 公分，90 公分以上兩人可交會' : '至少 60 公分（一人正面通過）'}。`,
        fix: '移開最窄處兩旁的家具，或改用較小、較窄的家具。',
        items: rt.item ? [rt.item.id] : [], path: rt.res.path, marks: rt.res.at ? [{ p: rt.res.at, label: blocked ? '擋住' : `${Math.round(w)}` }] : [],
      });
    }
  }

  const score = Math.max(0, 100 - found.reduce((s, f) => s + SCORE[f.level], 0));
  return { findings: found, score, checked: CHECKS, routes: routes.length };
}

export const CHECKS = ['大門到各房間的主要動線（80 公分）', '房門到床邊、衣櫃、書桌等的通道（60 公分）', '門片開啟範圍', '衣櫃、櫥櫃、冰箱、流理台、馬桶、洗手台前的使用空間', '床側與床尾走道', '餐桌四周', '沙發與茶几距離', '電視觀看距離', '高櫃擋窗', '家具重疊與超出房間'];
