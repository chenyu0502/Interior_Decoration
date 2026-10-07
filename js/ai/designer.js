// AI 自動設計引擎（規則式，於瀏覽器本機執行，不需網路）
// 流程：分析房間 → 判斷房型 → 找出可用牆面（避開門、窗、動線）→ 依風格模板配置家具 → 套用材質配色 → 產生設計說明
import { store } from '../core/state.js';
import {
  polygonArea, polygonBBox, polygonCentroid, largestInnerRect, wallFrame, toWallLocal, aabbOverlap, PING, uid, pointInPolygon,
} from '../core/geometry.js';
import { MATERIAL_MAP } from '../data/materials.js';
import { wallOnRoom, wallSideToward } from '../core/model.js';
import { CATALOG_MAP, OPENING_MAP } from '../data/catalog.js';
import { STYLE_MAP } from '../data/styles.js';

export const ROOM_TYPES = {
  auto: '自動判斷',
  living: '客廳 / 客餐廳',
  dining: '餐廳',
  master: '主臥室',
  bedroom: '臥室',
  study: '書房',
  kitchen: '廚房',
  bathroom: '浴室',
  entry: '玄關',
  hall: '走道',
  balcony: '陽台',
  closet: '更衣室',
};

const NAME_RULES = [
  [/主臥|主卧|master/i, 'master'],
  [/客餐|客廳|起居|living/i, 'living'],
  [/餐/, 'dining'],
  [/廚|kitchen/i, 'kitchen'],
  [/浴|衛|廁|bath|toilet/i, 'bathroom'],
  [/書|study|office|工作/i, 'study'],
  [/玄關|entry/i, 'entry'],
  [/走道|走廊|hall|corridor/i, 'hall'],
  [/陽台|balcony/i, 'balcony'],
  [/更衣|衣帽|closet/i, 'closet'],
  [/臥|房|bed/i, 'bedroom'],
];

// ---------------------------------------------------------------- 房間分析
export function analyzeRooms(project = store.project) {
  const rooms = project.rooms.map((r) => {
    const area = Math.abs(polygonArea(r.points));
    const bb = polygonBBox(r.points);
    return { room: r, area, m2: area / 10000, bb, type: r.type && r.type !== 'auto' ? r.type : null };
  });
  // 依名稱判斷
  for (const a of rooms) if (!a.type) for (const [re, t] of NAME_RULES) if (re.test(a.room.name || '')) { a.type = t; break; }
  // 依面積推斷其餘房間
  const unknown = rooms.filter((a) => !a.type).sort((x, y) => y.area - x.area);
  const has = (t) => rooms.some((a) => a.type === t);
  for (const a of unknown) {
    const minDim = Math.min(a.bb.x1 - a.bb.x0, a.bb.y1 - a.bb.y0);
    if (!has('living') && a.m2 >= 14) a.type = 'living';
    else if (minDim < 130) a.type = 'hall';
    else if (a.m2 < 5.5 && !rooms.filter((r) => r.type === 'bathroom').length) a.type = 'bathroom';
    else if (a.m2 < 4.5) a.type = 'bathroom';
    else if (!has('kitchen') && a.m2 < 9) a.type = 'kitchen';
    else if (!has('master') && a.m2 >= 10) a.type = 'master';
    else if (a.m2 < 8) a.type = 'study';
    else a.type = 'bedroom';
  }
  return rooms.map((a) => ({ ...a, ...roomContext(a.room, project) }));
}

// 找出房間的可用矩形、各邊上的門窗與開放邊
function roomContext(room, project) {
  const outer = largestInnerRect(room.points);
  const walls = project.walls.filter((w) => wallOnRoom(w, room));
  // 依牆厚內縮
  const inset = (side) => {
    let t = 0;
    for (const w of walls) {
      const f = wallFrame(w);
      const horiz = Math.abs(f.uy) < 0.2, vert = Math.abs(f.ux) < 0.2;
      const my = (w.y1 + w.y2) / 2, mx = (w.x1 + w.x2) / 2;
      if ((side === 'N' && horiz && Math.abs(my - outer.y0) < 20) || (side === 'S' && horiz && Math.abs(my - outer.y1) < 20)
        || (side === 'W' && vert && Math.abs(mx - outer.x0) < 20) || (side === 'E' && vert && Math.abs(mx - outer.x1) < 20)) t = Math.max(t, w.thickness / 2);
    }
    return t;
  };
  const rect = { x0: outer.x0 + inset('W'), x1: outer.x1 - inset('E'), y0: outer.y0 + inset('N'), y1: outer.y1 - inset('S') };
  const sides = { N: newSide('N', rect), S: newSide('S', rect), W: newSide('W', rect), E: newSide('E', rect) };
  // 每邊的牆覆蓋與門窗
  for (const s of Object.values(sides)) {
    s.covered = [];
    for (const w of walls) {
      const f = wallFrame(w);
      const horiz = Math.abs(f.uy) < 0.2, vert = Math.abs(f.ux) < 0.2;
      if ((s.key === 'N' || s.key === 'S') && !horiz) continue;
      if ((s.key === 'W' || s.key === 'E') && !vert) continue;
      const lineCoord = s.key === 'N' || s.key === 'S' ? (w.y1 + w.y2) / 2 : (w.x1 + w.x2) / 2;
      if (Math.abs(lineCoord - s.line) > w.thickness / 2 + 12) continue;
      const a = s.key === 'N' || s.key === 'S' ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
      const b = s.key === 'N' || s.key === 'S' ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
      s.covered.push([Math.max(a, s.u0), Math.min(b, s.u1)]);
      for (const op of project.openings.filter((o) => o.wallId === w.id)) {
        const def = OPENING_MAP[op.kind] || {};
        const cx = w.x1 + f.ux * op.offset, cy = w.y1 + f.uy * op.offset;
        const u = s.key === 'N' || s.key === 'S' ? cx : cy;
        if (u < s.u0 - op.width / 2 || u > s.u1 + op.width / 2) continue;
        const isDoor = def.cat === 'door';
        // 門往哪一側開
        let swingIn = true;
        if (isDoor && def.type !== 'sliding' && def.type !== 'opening') {
          const sideOfRoom = wallSideToward(w, room);
          swingIn = sideOfRoom ? ((op.flipV ? 'B' : 'A') === sideOfRoom) : true;
        }
        const rec = { op, def, u, a: u - op.width / 2, b: u + op.width / 2, sill: op.sill, top: op.sill + op.height, isDoor, swingIn, entry: !!def.entry };
        (isDoor ? s.doors : s.windows).push(rec);
      }
    }
    // 未被牆覆蓋的區段視為開放邊（通道）
    s.open = subtract([[s.u0, s.u1]], s.covered).filter(([a, b]) => b - a > 40);
  }
  return { rect, sides, walls };
}

function newSide(key, r) {
  const horiz = key === 'N' || key === 'S';
  return {
    key, horiz,
    line: key === 'N' ? r.y0 : key === 'S' ? r.y1 : key === 'W' ? r.x0 : r.x1,
    u0: horiz ? r.x0 : r.y0, u1: horiz ? r.x1 : r.y1,
    len: horiz ? r.x1 - r.x0 : r.y1 - r.y0,
    doors: [], windows: [], covered: [], open: [],
  };
}

function subtract(intervals, cuts) {
  let res = intervals.map((x) => x.slice());
  for (const [ca, cb] of cuts) {
    const next = [];
    for (const [a, b] of res) {
      if (cb <= a || ca >= b) { next.push([a, b]); continue; }
      if (ca > a) next.push([a, ca]);
      if (cb < b) next.push([cb, b]);
    }
    res = next;
  }
  return res;
}

const OPP = { N: 'S', S: 'N', W: 'E', E: 'W' };
const ROT = { N: 0, S: 180, W: 270, E: 90 }; // 背面靠該邊時的旋轉角
const ADJ = { N: ['W', 'E'], S: ['E', 'W'], W: ['N', 'S'], E: ['S', 'N'] };

// ---------------------------------------------------------------- 配置器
class Layout {
  constructor(ctx, style, pal) {
    this.rect = ctx.rect;
    this.sides = ctx.sides;
    this.style = style;
    this.pal = pal;
    this.obstacles = [];
    this.items = [];
    this.notes = [];
    // 門的開門範圍與通道需淨空
    for (const s of Object.values(this.sides)) {
      for (const d of s.doors) {
        const depth = d.def.type === 'sliding' || d.def.type === 'opening' || !d.swingIn ? 70 : d.op.width + 10;
        this.obstacles.push(this.zone(s, d.a - 10, d.b + 10, depth, 'door'));
      }
      for (const [a, b] of s.open) this.obstacles.push(this.zone(s, a, b, 60, 'open'));
    }
  }
  get W() { return this.rect.x1 - this.rect.x0; }
  get H() { return this.rect.y1 - this.rect.y0; }
  // 沿某邊、深度 depth 的區域
  zone(s, a, b, depth, tag) {
    const r = this.rect;
    if (s.key === 'N') return { x0: a, x1: b, y0: r.y0, y1: r.y0 + depth, tag };
    if (s.key === 'S') return { x0: a, x1: b, y0: r.y1 - depth, y1: r.y1, tag };
    if (s.key === 'W') return { x0: r.x0, x1: r.x0 + depth, y0: a, y1: b, tag };
    return { x0: r.x1 - depth, x1: r.x1, y0: a, y1: b, tag };
  }
  fits(box, ignore = []) {
    const r = this.rect;
    if (box.x0 < r.x0 - 0.5 || box.x1 > r.x1 + 0.5 || box.y0 < r.y0 - 0.5 || box.y1 > r.y1 + 0.5) return false;
    return !this.obstacles.some((o) => !ignore.includes(o.tag) && aabbOverlap(box, o, -0.5));
  }
  windowConflict(s, a, b, h) {
    return s.windows.some((w) => a < w.b && b > w.a && h > w.sill - 3);
  }
  // 物件背面靠在 s 邊，回傳位置
  placeAgainst(sideKey, kind, opts = {}) {
    const def = CATALOG_MAP[kind];
    if (!def) return null;
    const s = this.sides[sideKey];
    const w = opts.w || def.w, d = opts.d || def.d, h = opts.h || def.h;
    const gap = opts.gap || 0;
    const u0 = s.u0 + w / 2, u1 = s.u1 - w / 2;
    if (u1 < u0) return null;
    const pref = opts.u !== undefined ? opts.u : opts.align === 'start' ? u0 : opts.align === 'end' ? u1 : (s.u0 + s.u1) / 2;
    const cands = [];
    for (let k = 0; k <= (opts.noSlide ? 0 : Math.ceil((u1 - u0) / 5) + 1); k++) {
      for (const sg of k ? [1, -1] : [1]) {
        const u = pref + sg * k * 5;
        if (u >= u0 - 0.1 && u <= u1 + 0.1) cands.push(u);
      }
    }
    for (const u of cands) {
      if (!opts.allowWindow && this.windowConflict(s, u - w / 2, u + w / 2, opts.elev ? opts.elev + h : h)) continue;
      const pos = this.posOn(s, u, d, gap);
      const box = this.boxOf(pos.x, pos.y, w, d, ROT[sideKey]);
      if (opts.noCollide || this.fits(box, opts.ignore)) {
        return this.add(kind, { x: pos.x, y: pos.y, rot: ROT[sideKey], w, d, h, ...opts.extra }, opts.noCollide || opts.flat ? null : box);
      }
    }
    return null;
  }
  posOn(s, u, d, gap = 0) {
    const r = this.rect;
    if (s.key === 'N') return { x: u, y: r.y0 + gap + d / 2 };
    if (s.key === 'S') return { x: u, y: r.y1 - gap - d / 2 };
    if (s.key === 'W') return { x: r.x0 + gap + d / 2, y: u };
    return { x: r.x1 - gap - d / 2, y: u };
  }
  boxOf(x, y, w, d, rot) {
    const sw = rot % 180 === 0 ? w : d, sd = rot % 180 === 0 ? d : w;
    return { x0: x - sw / 2, x1: x + sw / 2, y0: y - sd / 2, y1: y + sd / 2 };
  }
  placeAt(kind, x, y, rot, opts = {}) {
    const def = CATALOG_MAP[kind];
    if (!def) return null;
    const w = opts.w || def.w, d = opts.d || def.d, h = opts.h || def.h;
    const box = this.boxOf(x, y, w, d, rot);
    if (!opts.noCollide && !this.fits(box, opts.ignore)) return null;
    return this.add(kind, { x, y, rot, w, d, h, ...opts.extra }, opts.noCollide ? null : box);
  }
  add(kind, props, box) {
    const it = { kind, ...props };
    this.items.push(it);
    if (box) this.obstacles.push({ ...box, tag: 'item' });
    return { ...it, box };
  }
  // 方向向量：從 s 邊往房間內
  inward(sideKey) { return { N: [0, 1], S: [0, -1], W: [1, 0], E: [-1, 0] }[sideKey]; }
  // 沿邊方向
  along(sideKey) { return sideKey === 'N' || sideKey === 'S' ? [1, 0] : [0, 1]; }
  // 一邊上最長的「實牆」區段長度
  solidLength(sideKey, tall = false) {
    const s = this.sides[sideKey];
    const cuts = [...s.doors.map((d) => [d.a - 10, d.b + 10]), ...s.open];
    if (tall) cuts.push(...s.windows.map((w) => [w.a, w.b]));
    const segs = subtract([[s.u0, s.u1]], cuts);
    return segs.reduce((m, [a, b]) => (b - a > m.len ? { len: b - a, a, b } : m), { len: 0, a: s.u0, b: s.u0 });
  }
  freeCorners() {
    const r = this.rect;
    return [[r.x0, r.y0, 'N', 'W'], [r.x1, r.y0, 'N', 'E'], [r.x1, r.y1, 'S', 'E'], [r.x0, r.y1, 'S', 'W']];
  }
  placeCorner(kind, opts = {}) {
    const def = CATALOG_MAP[kind];
    const w = def.w, d = def.d;
    for (const [cx, cy, s1, s2] of this.freeCorners()) {
      // 開放邊（例如客廳與餐廳交界）的角落不放
      if (this.sides[s1].virtual || this.sides[s2].virtual) continue;
      const x = cx + (cx === this.rect.x0 ? w / 2 + 8 : -w / 2 - 8);
      const y = cy + (cy === this.rect.y0 ? d / 2 + 8 : -d / 2 - 8);
      const r = this.placeAt(kind, x, y, opts.rot || 0, opts);
      if (r) return r;
    }
    return null;
  }
  curtains() {
    if (!this.style?.prefs?.curtains) return;
    for (const s of Object.values(this.sides)) {
      for (const w of s.windows) {
        if (w.sill > 140) continue;
        const width = w.op.width + 40;
        const pos = this.posOn(s, w.u, 14, 0);
        const h = Math.min(store.project.settings.wallHeight - 8, Math.max(w.top + 25, 200));
        this.add('curtain', { x: pos.x, y: pos.y, rot: ROT[s.key], w: width, d: 14, h }, null);
      }
    }
  }
}

// ---------------------------------------------------------------- 各房型配方
function designLiving(L, info, report, { withDining }) {
  const r = L.rect;
  const style = L.style;
  // 切出客廳與餐廳區
  let livingRect = { ...r }, diningRect = null;
  const longX = L.W >= L.H;
  if (withDining && Math.max(L.W, L.H) >= 500 && L.W * L.H >= 180000) {
    const total = longX ? L.W : L.H;
    const lw = Math.max(320, Math.min(total * 0.58, total - 240));
    // 餐廳靠近廚房那一端
    const k = info.kitchenCenter;
    const dinFirst = k ? (longX ? k[0] < (r.x0 + r.x1) / 2 : k[1] < (r.y0 + r.y1) / 2) : false;
    if (longX) {
      livingRect = dinFirst ? { ...r, x0: r.x1 - lw } : { ...r, x1: r.x0 + lw };
      diningRect = dinFirst ? { ...r, x1: r.x1 - lw } : { ...r, x0: r.x0 + lw };
    } else {
      livingRect = dinFirst ? { ...r, y0: r.y1 - lw } : { ...r, y1: r.y0 + lw };
      diningRect = dinFirst ? { ...r, y1: r.y1 - lw } : { ...r, y0: r.y0 + lw };
    }
  }
  const LZ = subLayout(L, livingRect);
  const W = LZ.W, H = LZ.H;
  // 沙發與電視牆面對：選擇兩邊距離適中的一組
  const pairs = [['N', 'S', H, W], ['W', 'E', W, H]];
  pairs.sort((a, b) => scorePair(LZ, b) - scorePair(LZ, a));
  const [s1, s2] = pairs[0];
  // 電視牆：實牆較長、窗戶較少的一邊
  const solid1 = LZ.solidLength(s1, true).len, solid2 = LZ.solidLength(s2, true).len;
  const tvSide = solid1 >= solid2 ? s1 : s2;
  const sofaSide = OPP[tvSide];
  const sofaVirtual = !!LZ.sides[sofaSide].virtual;
  const sofaFree = sofaVirtual ? LZ.sides[sofaSide].len - 40 : LZ.solidLength(sofaSide).len;
  const depthBetween = sofaSide === 'N' || sofaSide === 'S' ? H : W;
  let sofaKind = style?.prefs?.sofa || 'sofa3';
  if (sofaKind === 'sofa_l' && (sofaFree < 300 || depthBetween < 420)) sofaKind = 'sofa3';
  if (sofaKind === 'sofa_curve' && sofaFree < 260) sofaKind = 'sofa2';
  if (sofaKind === 'sofa3' && sofaFree < 260) sofaKind = 'sofa2';
  const sofaW = Math.min(CATALOG_MAP[sofaKind].w, Math.max(150, sofaFree - 30));
  const sofaU = sofaVirtual ? (LZ.sides[sofaSide].u0 + LZ.sides[sofaSide].u1) / 2 : centerU(LZ, sofaSide);
  // 開放式格局：沙發背對餐廳、離切割線 60 cm 作為走道
  const sofaOpts = sofaVirtual ? { gap: 60, ignore: ['open'] } : { gap: LZ.sides[sofaSide].windows.length ? 25 : 0 };
  let sofa = LZ.placeAgainst(sofaSide, sofaKind, { w: sofaW, u: sofaU, allowWindow: true, ...sofaOpts });
  if (!sofa) { sofaKind = 'sofa2'; sofa = LZ.placeAgainst(sofaSide, 'sofa2', { allowWindow: true, ...sofaOpts }); }
  // 電視櫃對齊沙發中心
  const tvSolid = LZ.solidLength(tvSide, true);
  const tvW = Math.max(120, Math.min(style?.id === 'modern' || style?.id === 'luxury' ? 240 : 200, tvSolid.len - 20));
  const su = sofa ? (sofaSide === 'N' || sofaSide === 'S' ? sofa.x : sofa.y) : centerU(LZ, tvSide);
  const CHAISE = { N: 1, S: -1, W: -1, E: 1 };
  const sofaCenterU = sofa && sofaKind === 'sofa_l' ? su - 40 * CHAISE[sofaSide] : su;
  const tv = LZ.placeAgainst(tvSide, 'tv_cabinet', { w: tvW, u: clampU(sofaCenterU, tvSolid.a + tvW / 2, tvSolid.b - tvW / 2) });
  if (tv) {
    const tvu = tvSide === 'N' || tvSide === 'S' ? tv.x : tv.y;
    const p = LZ.posOn(LZ.sides[tvSide], tvu, 6, 6);
    LZ.add('tv', { x: p.x, y: p.y, rot: ROT[tvSide], w: 146, d: 6, h: 84, elev: CATALOG_MAP.tv_cabinet.h + 18 }, null);
    report.accentWalls.push({ key: 'tvWall', side: tvSide, rect: livingRect });
  }
  if (sofa) report.accentWalls.push({ key: 'sofaWall', side: sofaSide, rect: livingRect });
  // 茶几與地毯
  if (sofa) {
    const [ix, iy] = LZ.inward(sofaSide);
    const sofaD = sofaKind === 'sofa_l' ? 92 : sofa.d;
    const back = sofaSide === 'N' || sofaSide === 'S' ? sofa.y - (sofa.d / 2) * iy : sofa.x - (sofa.d / 2) * ix;
    const backWall = sofaVirtual ? back - (iy || ix) * 60 : back; void backWall;
    const ctKind = style?.id === 'wabisabi' || style?.id === 'japandi' ? 'coffee_round' : 'coffee_table';
    const ct = CATALOG_MAP[ctKind];
    const dist = sofaD + 42 + ct.d / 2;
    const cx = sofaSide === 'N' || sofaSide === 'S' ? sofaCenterU : back + ix * dist;
    const cy = sofaSide === 'N' || sofaSide === 'S' ? back + iy * dist : sofaCenterU;
    const table = LZ.placeAt(ctKind, cx, cy, ROT[sofaSide]);
    const rugKind = style?.id === 'wabisabi' ? 'rug_round' : 'rug';
    const rugW = Math.min(sofaW + 30, 260), rugD = rugKind === 'rug_round' ? rugW * 0.8 : Math.min(200, (depthBetween - 120));
    if (rugD > 100) {
      const rd = rugKind === 'rug_round' ? rugD : rugD;
      const rcx = sofaSide === 'N' || sofaSide === 'S' ? sofaCenterU : back + ix * (sofaD - 25 + rd / 2);
      const rcy = sofaSide === 'N' || sofaSide === 'S' ? back + iy * (sofaD - 25 + rd / 2) : sofaCenterU;
      LZ.add(rugKind, { x: rcx, y: rcy, rot: ROT[sofaSide], w: rugKind === 'rug_round' ? rd : rugW, d: rd, h: 1 }, null);
    }
    // 吊燈
    const pend = style?.prefs?.pendant === 'chandelier' ? 'chandelier' : 'ceiling_light';
    LZ.add(pend, { x: table ? table.x : cx, y: table ? table.y : cy, rot: 0, ...ceilingProps(pend) }, null);
    // 邊几、立燈
    const [ax, ay] = LZ.along(sofaSide);
    const sofaHalf = sofaW / 2;
    const ends = [-1, 1].map((sg) => ({ x: (sofaSide === 'N' || sofaSide === 'S' ? sofa.x : back + ix * 30) + ax * sg * (sofaHalf + 30), y: (sofaSide === 'N' || sofaSide === 'S' ? back + iy * 30 : sofa.y) + ay * sg * (sofaHalf + 30) }));
    if (!LZ.placeAt('side_table', ends[0].x, ends[0].y, ROT[sofaSide])) LZ.placeAt('plant_small', ends[0].x, ends[0].y, 0);
    LZ.placeAt('floor_lamp', ends[1].x, ends[1].y, 0);
    // 單椅
    if (style?.prefs?.armchair && table) {
      for (const sg of [1, -1]) {
        const off = (CATALOG_MAP[ctKind].w / 2) + 70;
        const x = table.x + ax * sg * off, y = table.y + ay * sg * off;
        const rot = sofaSide === 'N' || sofaSide === 'S' ? (sg > 0 ? 90 : 270) : (sg > 0 ? 180 : 0);
        if (LZ.placeAt('armchair', x, y, rot)) break;
      }
    }
    // 沙發背牆掛畫
    if (style?.prefs?.artwork && !sofaVirtual && !LZ.sides[sofaSide].windows.some((w) => w.sill < 140)) {
      const p = LZ.posOn(LZ.sides[sofaSide], sofaCenterU, 3, 0);
      LZ.add('artwork', { x: p.x, y: p.y, rot: ROT[sofaSide], w: Math.min(120, sofaW * 0.5), d: 3, h: 70, elev: 135 }, null);
    }
  }
  // 收納牆：側牆擺書櫃或展示櫃
  const storageKind = style?.prefs?.storageWall;
  if (storageKind) {
    for (const s of ADJ[tvSide]) {
      const seg = LZ.solidLength(s, true);
      if (seg.len >= 110) {
        const w = Math.min(seg.len - 20, storageKind === 'display_cabinet' ? 160 : 200);
        if (LZ.placeAgainst(s, storageKind, { w, u: (seg.a + seg.b) / 2 })) break;
      }
    }
  }
  // 玄關鞋櫃：靠近大門
  for (const s of Object.values(LZ.sides)) {
    for (const d of s.doors.filter((x) => x.entry)) {
      for (const sg of [1, -1]) {
        const u = sg > 0 ? d.b + 10 + 60 : d.a - 10 - 60;
        if (LZ.placeAgainst(s.key, 'shoe_cabinet', { u, w: 120 })) { report.notes.push('大門旁配置鞋櫃，出入順手收納。'); sg && null; break; }
      }
    }
  }
  // 植栽
  const plants = style?.prefs?.plants ?? 1;
  for (let i = 0; i < plants; i++) LZ.placeCorner(style?.prefs?.plantKind || 'plant');
  LZ.curtains();
  merge(L, LZ);
  report.notes.push(`沙發靠${sideName(sofaSide)}側、電視牆設於${sideName(tvSide)}側實牆，兩者相距約 ${Math.round(depthBetween)} cm，視聽距離適中。`);
  if (diningRect) {
    const DZ = subLayout(L, diningRect, { openSides: [longX ? (livingRect.x0 === r.x0 ? 'W' : 'E') : (livingRect.y0 === r.y0 ? 'N' : 'S')] });
    designDiningZone(DZ, report);
    merge(L, DZ);
  }
}

function designDiningZone(L, report) {
  const style = L.style;
  const W = L.W, H = L.H;
  const round = style?.prefs?.dining === 'dining_round' || Math.min(W, H) < 250 && Math.max(W, H) < 280;
  const cx = (L.rect.x0 + L.rect.x1) / 2, cy = (L.rect.y0 + L.rect.y1) / 2;
  const alongX = W >= H;
  let seats = 0;
  if (round) {
    const size = Math.min(W, H) >= 300 ? 120 : 100;
    const t = L.placeAt('dining_round', cx, cy, 0, { w: size, d: size });
    if (t) {
      const n = size >= 120 ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (n === 4 ? Math.PI / 4 : 0);
        const rr = size / 2 + 12;
        // 椅子正面朝向桌心
        const rot = ((Math.atan2(Math.cos(a), -Math.sin(a)) * 180) / Math.PI + 360) % 360;
        if (L.placeAt('dining_chair', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, rot, { noCollide: true })) seats++;
      }
    }
  } else {
    const long = alongX ? W : H, short = alongX ? H : W;
    const tw = long >= 330 && short >= 270 ? 180 : 150, td = 90;
    const t = L.placeAt('dining_table', cx, cy, alongX ? 0 : 90, { w: tw, d: td });
    if (t) {
      const per = tw >= 180 ? 3 : 2;
      for (let i = 0; i < per; i++) {
        const off = -tw / 2 + (tw / per) * (i + 0.5);
        for (const sg of [-1, 1]) {
          const x = alongX ? cx + off : cx + sg * (td / 2 + 12);
          const y = alongX ? cy + sg * (td / 2 + 12) : cy + off;
          const rot = alongX ? (sg < 0 ? 0 : 180) : (sg < 0 ? 270 : 90);
          // 椅子會部分收進桌下，因此不與餐桌做碰撞判定
          if (L.placeAt('dining_chair', x, y, rot, { ignore: ['open', 'item'] })) seats++;
        }
      }
    }
  }
  const pend = style?.prefs?.pendant || 'pendant_dome';
  L.add(pend, { x: cx, y: cy, rot: alongX ? 0 : 90, ...ceilingProps(pend) }, null);
  // 餐邊櫃
  for (const s of ['N', 'S', 'W', 'E']) {
    const seg = L.solidLength(s, true);
    if (seg.len >= 140 && L.placeAgainst(s, 'sideboard', { w: Math.min(180, seg.len - 20), u: (seg.a + seg.b) / 2 })) break;
  }
  report.notes.push(`餐桌置中配置 ${seats} 個座位，四周保留至少 80 cm 走道。`);
}

function designBedroom(L, report, master) {
  const style = L.style;
  const minDim = Math.min(L.W, L.H);
  let bedKind = master ? style?.prefs?.bed || 'bed_double' : 'bed_queen';
  if (minDim < 300 || L.W * L.H < 90000) bedKind = master ? 'bed_queen' : 'bed_single';
  if (minDim < 230) bedKind = 'bed_single';
  const bed = CATALOG_MAP[bedKind];
  // 床頭靠牆：避開門與窗，前方保留走道
  const scored = ['N', 'S', 'W', 'E'].map((k) => {
    const s = L.sides[k];
    const seg = L.solidLength(k, false);
    const depth = k === 'N' || k === 'S' ? L.H : L.W;
    let sc = seg.len;
    if (seg.len < bed.w + 20) sc -= 1000;
    if (depth < bed.d + 60) sc -= 800;
    sc -= s.windows.filter((w) => w.sill < 120).length * 150;
    sc -= s.doors.length * 300;
    sc -= L.sides[OPP[k]].doors.length * 40; // 床尾正對門
    return { k, sc, seg };
  }).sort((a, b) => b.sc - a.sc);
  let placed = null, headSide = null;
  for (const c of scored) {
    const u = (c.seg.a + c.seg.b) / 2;
    placed = L.placeAgainst(c.k, bedKind, { u, allowWindow: true });
    if (placed) { headSide = c.k; break; }
  }
  if (!placed) { report.notes.push('房間尺寸較小，無法擺放標準床架，建議改用沙發床或架高地板。'); return; }
  report.accentWalls.push({ key: 'bedHead', side: headSide, rect: L.rect });
  const [ax, ay] = L.along(headSide);
  // 床頭櫃
  for (const sg of [-1, 1]) {
    const ns = CATALOG_MAP.nightstand;
    const u = (headSide === 'N' || headSide === 'S' ? placed.x : placed.y) + sg * (placed.w / 2 + ns.w / 2 + 4);
    const r = L.placeAgainst(headSide, 'nightstand', { u, allowWindow: true });
    if (r) L.add('table_lamp', { x: r.x, y: r.y, rot: r.rot, w: 30, d: 30, h: 48, elev: ns.h }, null);
    void ax; void ay;
  }
  // 床頭掛畫
  if (style?.prefs?.artwork) {
    const p = L.posOn(L.sides[headSide], headSide === 'N' || headSide === 'S' ? placed.x : placed.y, 3, 0);
    if (!L.sides[headSide].windows.some((w) => w.sill < 160)) L.add('artwork', { x: p.x, y: p.y, rot: ROT[headSide], w: Math.min(100, placed.w * 0.6), d: 3, h: 55, elev: 140 }, null);
  }
  // 衣櫃：其他牆中最長的實牆
  const others = ['N', 'S', 'W', 'E'].filter((k) => k !== headSide).map((k) => ({ k, seg: L.solidLength(k, true) })).sort((a, b) => b.seg.len - a.seg.len);
  let wardrobe = null;
  for (const o of others) {
    for (const w of [240, 210, 180, 150, 120, 90]) {
      if (o.seg.len < w + 5) continue;
      wardrobe = L.placeAgainst(o.k, 'wardrobe', { w, u: o.seg.a + w / 2 + 2 });
      if (!wardrobe) wardrobe = L.placeAgainst(o.k, 'wardrobe', { w, u: o.seg.b - w / 2 - 2 });
      if (wardrobe) break;
    }
    if (wardrobe) break;
  }
  if (wardrobe) report.notes.push(`衣櫃寬 ${wardrobe.w} cm 靠${sideName(others.find((o) => (wardrobe.rot === ROT[o.k]))?.k || 'N')}側牆，前方保留開門空間。`);
  // 地毯
  const [ix, iy] = L.inward(headSide);
  const rugW = Math.min(placed.w + 80, 260);
  const rx = placed.x + ix * (placed.d * 0.25), ry = placed.y + iy * (placed.d * 0.25);
  L.add('rug', { x: rx, y: ry, rot: ROT[headSide] + 0, w: rugW, d: 150, h: 1 }, null);
  // 書桌或化妝台：靠窗優先
  const deskKind = master ? 'dresser' : 'desk';
  const winSide = ['N', 'S', 'W', 'E'].find((k) => k !== headSide && L.sides[k].windows.some((w) => w.sill >= 75));
  const tryDesk = (k) => {
    const s = L.sides[k];
    const u = s.windows.length ? s.windows[0].u : undefined;
    const r = L.placeAgainst(k, deskKind, { u, allowWindow: true });
    if (r && deskKind === 'desk') {
      const [dx, dy] = L.inward(k);
      L.placeAt('office_chair', r.x + dx * 45, r.y + dy * 45, (ROT[k] + 180) % 360, { noCollide: true });
    }
    return r;
  };
  if (!(winSide && tryDesk(winSide))) for (const o of others) if (tryDesk(o.k)) break;
  L.add('ceiling_light', { x: (L.rect.x0 + L.rect.x1) / 2, y: (L.rect.y0 + L.rect.y1) / 2, rot: 0, ...ceilingProps('ceiling_light') }, null);
  if ((style?.prefs?.plants ?? 1) >= 2) L.placeCorner('plant_small');
  L.curtains();
  report.notes.push(`床頭靠${sideName(headSide)}側實牆（${bed.name}），避開門窗並保留床尾 60 cm 以上通道。`);
}

function designStudy(L, report) {
  const winSide = ['N', 'S', 'W', 'E'].find((k) => L.sides[k].windows.some((w) => w.sill >= 70));
  const order = [winSide, ...['N', 'S', 'W', 'E'].map((k) => ({ k, l: L.solidLength(k).len })).sort((a, b) => b.l - a.l).map((x) => x.k)].filter(Boolean);
  let desk = null, deskSide = null;
  for (const k of order) {
    const s = L.sides[k];
    desk = L.placeAgainst(k, 'desk', { w: Math.min(160, Math.max(100, L.solidLength(k).len - 40)), u: s.windows[0]?.u, allowWindow: true });
    if (desk) { deskSide = k; break; }
  }
  if (desk) {
    const [dx, dy] = L.inward(deskSide);
    L.placeAt('office_chair', desk.x + dx * 48, desk.y + dy * 48, (ROT[deskSide] + 180) % 360, { noCollide: true });
    report.notes.push(`書桌${deskSide === winSide ? '面窗' : '靠牆'}配置，${deskSide === winSide ? '白天可取得自然光' : '背光處建議加裝檯燈'}。`);
  }
  for (const k of ['N', 'S', 'W', 'E'].filter((x) => x !== deskSide)) {
    const seg = L.solidLength(k, true);
    if (seg.len >= 100 && L.placeAgainst(k, 'bookshelf', { w: Math.min(200, seg.len - 20), u: (seg.a + seg.b) / 2 })) break;
  }
  if (L.W * L.H > 90000) { L.placeCorner('lounge_chair', { rot: 45 }); L.placeCorner('floor_lamp'); }
  L.placeCorner('plant_small');
  L.add('ceiling_light', { x: (L.rect.x0 + L.rect.x1) / 2, y: (L.rect.y0 + L.rect.y1) / 2, rot: 0, ...ceilingProps('ceiling_light') }, null);
  L.curtains();
}

function designKitchen(L, report) {
  const sides = ['N', 'S', 'W', 'E'].map((k) => ({ k, seg: L.solidLength(k, false) })).sort((a, b) => b.seg.len - a.seg.len);
  const main = sides[0];
  if (!main || main.seg.len < 100) { report.notes.push('廚房實牆長度不足，建議改用一字型小廚具。'); return; }
  const fridgeW = 75;
  let runLen = Math.min(main.seg.len - (main.seg.len > 260 ? fridgeW + 5 : 0), 330);
  runLen = Math.max(90, Math.floor(runLen / 10) * 10);
  const counter = L.placeAgainst(main.k, 'kitchen_counter', { w: runLen, u: main.seg.a + runLen / 2, allowWindow: true });
  if (counter) {
    // 吊櫃（避開窗戶）
    const s = L.sides[main.k];
    const u0 = (main.k === 'N' || main.k === 'S' ? counter.x : counter.y) - runLen / 2;
    const free = subtract([[u0, u0 + runLen]], s.windows.map((w) => [w.a - 5, w.b + 5])).filter(([a, b]) => b - a >= 60);
    for (const [a, b] of free) {
      const p = L.posOn(s, (a + b) / 2, 35, 0);
      L.add('wall_cabinet', { x: p.x, y: p.y, rot: ROT[main.k], w: b - a, d: 35, h: 70, elev: 150 }, null);
    }
    // 冰箱：優先放在流理台兩端，否則找其他牆
    const cu = main.k === 'N' || main.k === 'S' ? counter.x : counter.y;
    const fridge = L.placeAgainst(main.k, 'fridge', { u: cu + runLen / 2 + fridgeW / 2 + 3, noSlide: true })
      || L.placeAgainst(main.k, 'fridge', { u: cu - runLen / 2 - fridgeW / 2 - 3, noSlide: true });
    if (!fridge) {
      for (const o of sides.slice(1)) if (o.seg.len >= 80 && (L.placeAgainst(o.k, 'fridge', { align: 'start' }) || L.placeAgainst(o.k, 'fridge', { align: 'end' }))) break;
    }
  }
  // L 型第二段
  const adj = sides.find((x) => ADJ[main.k].includes(x.k) && x.seg.len >= 140);
  if (adj) {
    const s = L.sides[adj.k];
    const nearStart = main.k === 'N' || main.k === 'W';
    const len = Math.min(adj.seg.len - 70, 180);
    if (len >= 80) L.placeAgainst(adj.k, 'kitchen_base', { w: len, u: nearStart ? s.u0 + 62 + len / 2 : s.u1 - 62 - len / 2, allowWindow: true });
  }
  // 中島
  if (Math.min(L.W, L.H) >= 330 && L.W * L.H >= 120000) {
    const cx = (L.rect.x0 + L.rect.x1) / 2, cy = (L.rect.y0 + L.rect.y1) / 2;
    const rot = main.k === 'N' || main.k === 'S' ? 0 : 90;
    if (L.placeAt('kitchen_island', cx, cy, rot)) report.notes.push('廚房空間充足，加入中島增加備餐檯面。');
  }
  L.add('ceiling_light', { x: (L.rect.x0 + L.rect.x1) / 2, y: (L.rect.y0 + L.rect.y1) / 2, rot: 0, ...ceilingProps('ceiling_light') }, null);
  report.notes.push(`廚具沿${sideName(main.k)}側配置約 ${runLen} cm，依「冰箱 → 水槽 → 爐具」工作動線排列。`);
}

function designBathroom(L, report) {
  const area = L.W * L.H;
  const doorSide = ['N', 'S', 'W', 'E'].find((k) => L.sides[k].doors.length);
  const far = doorSide ? OPP[doorSide] : 'N';
  // 淋浴或浴缸
  let wet = null;
  if (area >= 50000) {
    const k = ['N', 'S', 'W', 'E'].find((x) => L.solidLength(x).len >= 172 && x !== doorSide);
    if (k) wet = L.placeAgainst(k, 'bathtub', { align: 'end', allowWindow: true });
  }
  if (!wet) {
    for (const k of [far, ...ADJ[far]]) {
      wet = L.placeAgainst(k, 'shower', { align: 'end', allowWindow: true }) || L.placeAgainst(k, 'shower', { align: 'start', allowWindow: true });
      if (wet) break;
    }
  }
  let toilet = null;
  for (const k of [far, ...ADJ[far], doorSide].filter(Boolean)) {
    toilet = L.placeAgainst(k, 'toilet', { allowWindow: true });
    if (toilet) break;
  }
  let vanity = null;
  for (const k of [...ADJ[far], far, doorSide].filter(Boolean)) {
    for (const vw of [Math.min(100, Math.max(60, L.solidLength(k).len - 10)), 80, 60]) {
      vanity = L.placeAgainst(k, 'vanity', { allowWindow: true, w: vw });
      if (vanity) break;
    }
    if (vanity) {
      const p = L.posOn(L.sides[k], k === 'N' || k === 'S' ? vanity.x : vanity.y, 4, 0);
      L.add('mirror', { x: p.x, y: p.y, rot: ROT[k], w: Math.min(70, vanity.w - 10), d: 4, h: 80, elev: 105 }, null);
      break;
    }
  }
  L.add('ceiling_light', { x: (L.rect.x0 + L.rect.x1) / 2, y: (L.rect.y0 + L.rect.y1) / 2, rot: 0, w: 30, d: 30, ...ceilingProps('ceiling_light') }, null);
  report.notes.push(`${wet ? (wet.kind === 'bathtub' ? '浴缸' : '淋浴間') + '置於內側、' : ''}馬桶與洗手台分開配置，建議乾濕分離並加裝排風扇。`);
}

function designSmall(L, type, report) {
  if (type === 'entry' || type === 'hall') {
    const k = ['N', 'S', 'W', 'E'].map((x) => ({ x, l: L.solidLength(x, true).len })).sort((a, b) => b.l - a.l)[0];
    if (k && Math.min(L.W, L.H) >= 120 && k.l >= 90) {
      if (L.placeAgainst(k.x, type === 'entry' ? 'shoe_cabinet' : 'wall_shelf', type === 'entry' ? { w: Math.min(160, k.l - 10) } : { w: Math.min(120, k.l - 20), noCollide: true, extra: { elev: 150, h: 3 } })) report.notes.push(type === 'entry' ? '玄關配置鞋櫃，可加裝穿鞋椅與全身鏡。' : '走道牆面加入層板展示，保持 90 cm 以上通行寬度。');
    }
    return;
  }
  if (type === 'balcony') {
    L.placeAgainst(['N', 'S', 'W', 'E'].sort((a, b) => L.solidLength(b).len - L.solidLength(a).len)[0], 'washer');
    L.placeCorner('plant');
    return;
  }
  if (type === 'closet') {
    for (const k of ['N', 'S', 'W', 'E']) {
      const seg = L.solidLength(k, true);
      if (seg.len >= 90) L.placeAgainst(k, 'wardrobe', { w: Math.min(240, seg.len - 10), u: (seg.a + seg.b) / 2 });
    }
    report.notes.push('更衣室沿牆配置衣櫃，中間保留 90 cm 以上換衣空間。');
  }
}

// ---------------------------------------------------------------- 工具
function subLayout(L, rect, { openSides = [] } = {}) {
  // 以子矩形建立新配置器（沿用父層的門窗資訊，只取落在子矩形範圍者）
  const sides = {};
  for (const k of ['N', 'S', 'W', 'E']) {
    const base = L.sides[k];
    const s = newSide(k, rect);
    const onSameLine = Math.abs(s.line - base.line) < 1;
    if (onSameLine) {
      s.doors = base.doors.filter((d) => d.b > s.u0 && d.a < s.u1);
      s.windows = base.windows.filter((d) => d.b > s.u0 && d.a < s.u1);
      s.open = base.open.map(([a, b]) => [Math.max(a, s.u0), Math.min(b, s.u1)]).filter(([a, b]) => b - a > 40);
    } else {
      s.open = openSides.includes(k) ? [[s.u0, s.u1]] : [];
      // 切割線為開放邊：不放靠牆物件
      s.virtual = true;
    }
    sides[k] = s;
  }
  const Z = new Layout({ rect, sides }, L.style, L.pal);
  // 承接父層障礙物（如已配置的物件）
  Z.obstacles.push(...L.obstacles.filter((o) => o.tag === 'item'));
  for (const s of Object.values(sides)) if (s.virtual) s.open = [[s.u0, s.u1]];
  return Z;
}

function merge(L, Z) {
  L.items.push(...Z.items);
  L.obstacles.push(...Z.obstacles.filter((o) => o.tag === 'item'));
}

function scorePair(L, [a, b, dist, len]) {
  let s = 0;
  if (L.sides[a].virtual || L.sides[b].virtual) s -= 120;
  if (dist >= 300 && dist <= 520) s += 100; else s -= Math.abs(dist - 400) * 0.4;
  s += Math.min(len, 500) * 0.3;
  s += Math.max(L.solidLength(a, true).len, L.solidLength(b, true).len) * 0.4;
  return s;
}
function centerU(L, k) { const seg = L.solidLength(k); return (seg.a + seg.b) / 2; }
function clampU(u, a, b) { return a > b ? (a + b) / 2 : Math.max(a, Math.min(b, u)); }
function sideName(k) { return { N: '北', S: '南', W: '西', E: '東' }[k]; }
function ceilingProps(kind) {
  const d = CATALOG_MAP[kind];
  const H = store.project.settings.wallHeight;
  const elev = kind === 'ceiling_light' ? H - d.h : Math.min(d.elev, H - d.h - 40);
  return { w: d.w, d: d.d, h: d.h, elev };
}

// ---------------------------------------------------------------- 主流程
/**
 * @param {string} styleId
 * @param {{ mode: 'replace'|'keep'|'materials', roomIds?: string[] }} options
 */
export function autoDesign(styleId, options = {}) {
  const style = STYLE_MAP[styleId];
  const P = store.project;
  const mode = options.mode || 'replace';
  const analyses = analyzeRooms(P).filter((a) => !options.roomIds || options.roomIds.includes(a.room.id));
  const kitchen = analyses.find((a) => a.type === 'kitchen');
  const hasDiningRoom = analyses.some((a) => a.type === 'dining');
  const report = { styleId, createdAt: new Date().toISOString(), rooms: [], general: style.tips.general.slice(), accentWalls: [] };

  store.checkpoint();
  P.design.styleId = styleId;
  for (const a of analyses) {
    const roomReport = { id: a.room.id, name: a.room.name, type: a.type, m2: a.m2, ping: a.m2 / PING, notes: [], accentWalls: [] };
    // 房型寫回（使用者可再修改）
    if (!a.room.type || a.room.type === 'auto') a.room.type = a.type;
    // 材質
    const fl = style.materials.floor;
    a.room.floor = fl[a.type] || (a.type === 'master' ? fl.bedroom : null) || fl.default;
    {
      if (mode === 'replace') {
        // 移除房間內原有家具（戶外柵欄屬於建築元素，保留）
        P.items = P.items.filter((it) => CATALOG_MAP[it.kind]?.cat === 'outdoor' || !pointInPolygon(it.x, it.y, a.room.points));
      }
      const L = new Layout(a, style, null);
      for (const it of P.items) if (pointInPolygon(it.x, it.y, a.room.points)) {
        const def = CATALOG_MAP[it.kind];
        if (mode !== 'keep' && def?.cat !== 'outdoor') continue;
        if (!def?.flat && !def?.ceiling) L.obstacles.push({ ...L.boxOf(it.x, it.y, it.w, it.d, Math.round((it.rot || 0) / 90) * 90 % 360), tag: 'item' });
      }
      const ctx = { kitchenCenter: kitchen ? polygonCentroid(kitchen.room.points) : null };
      try {
        if (a.type === 'living') designLiving(L, ctx, roomReport, { withDining: !hasDiningRoom });
        else if (a.type === 'dining') designDiningZone(L, roomReport);
        else if (a.type === 'master' || a.type === 'bedroom') designBedroom(L, roomReport, a.type === 'master');
        else if (a.type === 'study') designStudy(L, roomReport);
        else if (a.type === 'kitchen') designKitchen(L, roomReport);
        else if (a.type === 'bathroom') designBathroom(L, roomReport);
        else designSmall(L, a.type, roomReport);
      } catch (e) {
        console.error('配置失敗', a.room.name, e);
        roomReport.notes.push('此房間形狀較特殊，部分家具未能自動配置，請手動調整。');
      }
      if (mode !== 'materials') for (const it of L.items) {
        const def = CATALOG_MAP[it.kind];
        const elev = it.elev !== undefined ? it.elev : def.elev || 0;
        P.items.push({ id: uid('f'), kind: it.kind, name: def.name, x: Math.round(it.x), y: Math.round(it.y), rot: ((it.rot % 360) + 360) % 360, w: Math.round(it.w), d: Math.round(it.d), h: Math.round(it.h), elev, color: null, color2: null, auto: true });
      }
    }
    roomReport.accentWalls = roomReport.accentWalls || [];
    // 牆面材質（面向房間的那一面）
    const wallMat = style.materials.wall[a.type] || style.materials.wall.default;
    for (const w of a.walls) {
      const side = wallSideToward(w, a.room);
      if (!side) continue;
      w[side === 'A' ? 'matA' : 'matB'] = wallMat;
    }
    // 主題牆（電視牆、沙發背牆、床頭牆）
    for (const acc of roomReport.accentWalls) {
      const matId = style.materials.accent[acc.key];
      if (!matId) continue;
      const w = findWallOnSide(a, acc.side, acc.rect);
      if (!w) continue;
      const side = wallSideToward(w, a.room);
      if (side) { w[side === 'A' ? 'matA' : 'matB'] = matId; roomReport.notes.push(`${{ tvWall: '電視牆', sofaWall: '沙發背牆', bedHead: '床頭主牆' }[acc.key]}採用「${matLabel(matId)}」作為視覺焦點。`); }
    }
    delete roomReport.accentWalls;
    const tips = style.tips[a.type] || (a.type === 'master' ? style.tips.bedroom : []) || [];
    roomReport.tips = [...tips, ...(a.type === 'master' ? style.tips.bedroom || [] : [])];
    roomReport.floor = a.room.floor;
    roomReport.wall = wallMat;
    report.rooms.push(roomReport);
  }
  // 整體評估
  const total = analyses.reduce((s, a) => s + a.m2, 0);
  report.totalM2 = total;
  report.totalPing = total / PING;
  report.fit = fitComment(style, total / PING, analyses);
  P.design.report = report;
  store.select(null);
  store.changed('design');
  return report;
}

function findWallOnSide(a, sideKey, rect) {
  const line = sideKey === 'N' ? rect.y0 : sideKey === 'S' ? rect.y1 : sideKey === 'W' ? rect.x0 : rect.x1;
  const horiz = sideKey === 'N' || sideKey === 'S';
  let best = null, bestLen = 0;
  for (const w of a.walls) {
    const f = wallFrame(w);
    if (horiz ? Math.abs(f.uy) > 0.2 : Math.abs(f.ux) > 0.2) continue;
    const c = horiz ? (w.y1 + w.y2) / 2 : (w.x1 + w.x2) / 2;
    if (Math.abs(c - line) > w.thickness / 2 + 12) continue;
    const lo = horiz ? Math.max(Math.min(w.x1, w.x2), rect.x0) : Math.max(Math.min(w.y1, w.y2), rect.y0);
    const hi = horiz ? Math.min(Math.max(w.x1, w.x2), rect.x1) : Math.min(Math.max(w.y1, w.y2), rect.y1);
    if (hi - lo > bestLen) { bestLen = hi - lo; best = w; }
  }
  void toWallLocal;
  return best;
}

function matLabel(id) { return MATERIAL_MAP[id]?.name || id; }

function fitComment(style, ping, analyses) {
  const bedrooms = analyses.filter((a) => a.type === 'master' || a.type === 'bedroom').length;
  const lines = [`本案室內約 ${ping.toFixed(1)} 坪（${analyses.length} 個空間、${bedrooms} 間臥室）。`];
  lines.push(`風格適用性：${style.suits}`);
  if (style.id === 'luxury' && ping < 20) lines.push('提醒：輕奢風較適合中大型坪數，小坪數建議僅在客廳主牆、燈具等「局部」使用金屬與石紋，避免壓迫。');
  if (style.id === 'japandi' && ping > 40) lines.push('大坪數使用日系無印風時，可增加木格柵、和室等元素分隔空間層次，避免顯得空曠。');
  if (style.id === 'nordic' && analyses.some((a) => a.sides && Object.values(a.sides).every((s) => !s.windows.length) && (a.type === 'living'))) lines.push('客廳採光較弱，北歐風建議加強白色基底與多層次照明。');
  if (style.id === 'wabisabi') lines.push('侘寂風重在「減法」，建議實際入住後再逐步添加軟裝，保留大量留白。');
  if (style.id === 'modern') lines.push('現代風重視收納機能，可沿電視牆、玄關與走道規劃整面系統櫃。');
  return lines;
}
