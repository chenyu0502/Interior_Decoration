// 預算與材料清單：從平面圖計算地坪、牆面、天花板面積，門窗與家具數量，依單價估算費用。
// 單價為台灣市場的大略行情（新台幣，材料與施工合計），僅供參考，使用者可以逐項修改。
// 設定存在 project.settings.budget = { tier, prices: { 項目鍵: 單價 }, extras: { 編號: true/false }, ceiling,
//   off: { 項目鍵: true }（不做的項目）, custom: [{ id, group, name, unit, qty, price }]（自訂工程） }。
// 各項目的備註與照片存在 project.budgetNotes = { 項目鍵: { text, photos: [dataURL] } }（各方案共用）。
import { store } from '../core/state.js';
import { wallFrame, pointInPolygon, polygonArea, PING } from '../core/geometry.js';
import { openingCenter } from '../core/model.js';
import { MATERIAL_MAP } from '../data/materials.js';
import { CATALOG_MAP, OPENING_MAP } from '../data/catalog.js';

export const TIERS = {
  economy: { name: '經濟', item: 0.65, mat: 0.8 },
  standard: { name: '標準', item: 1, mat: 1 },
  premium: { name: '精品', item: 1.8, mat: 1.35 },
};

const CHI = 30.3; // 1 尺 = 30.3 公分
const CAI = 30.3 * 30.3; // 1 才 = 1 尺 × 1 尺

// 地坪（每坪，含工）與損耗率
const FLOOR = {
  wood_oak: [4500, 0.05], wood_ash: [4500, 0.05], wood_walnut: [5500, 0.05], wood_smoked: [5000, 0.05], herringbone: [9000, 0.12],
  tile_white: [6000, 0.08], tile_grey: [8000, 0.08], tile_beige: [6500, 0.08], tile_bath: [5500, 0.08], tile_hex: [7500, 0.12],
  marble_white: [25000, 0.1], marble_dark: [30000, 0.1], travertine: [18000, 0.1], terrazzo: [15000, 0.05],
  microcement: [9000, 0], microcement_dark: [9000, 0], concrete: [12000, 0], carpet_grey: [3500, 0.08], tatami: [6000, 0.03],
};
// 牆面（每坪牆面積，含批土與施工）與損耗率
const WALL = {
  paint_white: [900, 0], paint_warm: [900, 0], paint_greige: [1000, 0], paint_grey: [1000, 0], paint_charcoal: [1100, 0],
  paint_sage: [1000, 0], paint_blue: [1000, 0], paint_terracotta: [1100, 0], paint_navy: [1100, 0], limewash: [3500, 0],
  wood_panel: [12000, 0.08], wood_panel_dark: [13000, 0.08], brick_white: [6500, 0.08], wallpaper_stripe: [2800, 0.1], tile_subway: [6000, 0.08],
  marble_white: [25000, 0.1], marble_dark: [30000, 0.1], travertine: [18000, 0.1], terrazzo: [15000, 0.05],
  microcement: [8500, 0], microcement_dark: [8500, 0], concrete: [6500, 0],
};
// 門（每樘）；窗（每才）
const DOOR = { door_single: 15000, door_double: 26000, door_sliding: 28000, door_entry: 55000, door_opening: 4000 };
const WINDOW = { window_std: 1200, window_wide: 1200, window_french: 1500, window_high: 1100, window_fixed: 1000 };
// 依寬度計價的系統櫃、廚具、窗簾、圍籬（每尺）
const PER_CHI = {
  wardrobe: 7000, tv_cabinet: 5000, shoe_cabinet: 5500, tall_cabinet: 6500, grid_shelf: 4500, kitchen_counter: 9000, kitchen_base: 7000,
  wall_cabinet: 4500, kitchen_island: 12000, curtain: 1100, fence_picket: 2500, fence_metal: 3500, fence_slat: 3000,
};
// 家具、燈具、家電（每件）
const EACH = {
  sofa3: 38000, sofa2: 28000, sofa_l: 58000, sofa_curve: 45000, chaise: 26000, armchair: 15000, lounge_chair: 18000, ottoman: 4500,
  coffee_table: 9000, coffee_round: 8000, side_table: 3500, tv: 35000, bookshelf: 12000, display_cabinet: 18000, rug: 6000, rug_round: 4500,
  dining_table: 22000, dining_round: 20000, dining_chair: 4500, bar_stool: 3500, sideboard: 16000,
  bed_double: 55000, bed_queen: 42000, bed_single: 22000, nightstand: 4500, dresser: 12000, chest: 12000,
  desk: 9000, office_chair: 7000, fridge: 45000, washer: 25000,
  toilet: 18000, vanity: 15000, bathtub: 35000, shower: 25000, mirror: 5000, corner_shelf: 6000, wall_shelf: 2500,
  table_lamp: 2500, floor_lamp: 4500, pendant_dome: 4500, pendant_paper: 3500, pendant_linear: 6500, chandelier: 18000, ceiling_light: 3000,
  plant: 2500, plant_small: 800, plant_branch: 1500, artwork: 3500, vase: 1200,
};
const CEILING = 5500; // 平釘天花板（矽酸鈣板含批土油漆），每坪

// 其他工程（依室內坪數計價）
export const EXTRAS = [
  { id: 'protect', name: '保護工程與完工清潔', per: 1200, on: true },
  { id: 'electric', name: '水電工程（插座、燈具迴路）', per: 6000, on: false },
  { id: 'demolish', name: '拆除與清運', per: 3000, on: false },
  { id: 'design', name: '設計與監工', per: 4000, on: false },
];

export const GROUPS = ['地坪工程', '牆面工程', '天花板工程', '門窗', '系統櫃與廚具', '家具', '燈具', '衛浴與家電', '軟裝與植栽', '其他工程'];

function groupOf(kind) {
  const def = CATALOG_MAP[kind];
  if (!def) return '家具';
  if (PER_CHI[kind] && kind !== 'curtain' && !kind.startsWith('fence')) return '系統櫃與廚具';
  if (def.cat === 'light') return '燈具';
  if (def.cat === 'bath' || ['fridge', 'washer', 'tv'].includes(kind)) return '衛浴與家電';
  if (def.cat === 'decor' || ['rug', 'rug_round'].includes(kind) || kind.startsWith('fence')) return '軟裝與植栽';
  return '家具';
}

// 每個房間各面牆的面積（依牆面朝向房間那一側的材質），扣除門窗
function wallAreas(P) {
  const H = P.settings.wallHeight;
  const out = []; // { room, mat, area(cm²) }
  for (const r of P.rooms) {
    const pts = r.points;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      for (const w of P.walls) {
        const f = wallFrame(w), tol = (w.thickness || 12) / 2 + 3;
        const da = Math.abs((ax - w.x1) * f.nx + (ay - w.y1) * f.ny), db = Math.abs((bx - w.x1) * f.nx + (by - w.y1) * f.ny);
        if (da > tol || db > tol) continue;
        const ua = (ax - w.x1) * f.ux + (ay - w.y1) * f.uy, ub = (bx - w.x1) * f.ux + (by - w.y1) * f.uy;
        const lo = Math.max(0, Math.min(ua, ub)), hi = Math.min(f.L, Math.max(ua, ub));
        if (hi - lo < 5) continue;
        // 牆的哪一側朝向房間
        const mu = (lo + hi) / 2, off = (w.thickness || 12) / 2 + 6;
        const mx = w.x1 + f.ux * mu, my = w.y1 + f.uy * mu;
        const side = pointInPolygon(mx + f.nx * off, my + f.ny * off, pts) ? 'A' : 'B';
        let area = (hi - lo) * H;
        for (const op of P.openings) {
          if (op.wallId !== w.id || op.offset < lo || op.offset > hi) continue;
          const def = OPENING_MAP[op.kind];
          area -= (op.width || def?.width || 0) * (op.height || def?.height || 0);
        }
        out.push({ room: r, mat: (side === 'A' ? w.matA : w.matB) || 'paint_white', area: Math.max(0, area) });
      }
    }
  }
  return out;
}

// 項目是否要做：天花板與其他工程沿用原本的勾選設定，其餘項目記在 off
export function lineOn(B, key) {
  if (key === 'ceiling') return B.ceiling !== false;
  if (key.startsWith('extra:')) { const id = key.slice(6); return B.extras?.[id] ?? EXTRAS.find((e) => e.id === id)?.on ?? true; }
  return !B.off?.[key];
}

const ping = (cm2) => cm2 / 10000 / PING;

// 依目前設定計算清單：回傳 { groups: [{ name, lines, subtotal }], total, area(坪), perPing }
export function computeBudget(P = store.project) {
  const B = P.settings.budget || {};
  const tier = TIERS[B.tier] || TIERS.standard;
  const priceOf = (key, base) => (Number.isFinite(B.prices?.[key]) ? B.prices[key] : Math.round((base * (key.startsWith('item:') ? tier.item : tier.mat)) / 10) * 10);
  const lines = new Map();
  const add = (key, group, name, unit, qty, base, { waste = 0, detail = '', room = detail } = {}) => {
    if (qty <= 0) return;
    const L = lines.get(key) || { key, group, name, unit, qty: 0, waste, details: new Map(), byRoom: new Map(), price: priceOf(key, base), base };
    L.qty += qty;
    if (detail) L.details.set(detail, (L.details.get(detail) || 0) + qty);
    if (room) L.byRoom.set(room, (L.byRoom.get(room) || 0) + qty);
    lines.set(key, L);
  };
  const rooms = P.rooms.filter((r) => r.points.length >= 3);
  const totalPing = rooms.reduce((s, r) => s + ping(Math.abs(polygonArea(r.points))), 0);

  for (const r of rooms) {
    const m = r.floor || 'wood_oak', [p, w] = FLOOR[m] || [6000, 0.08];
    add(`floor:${m}`, '地坪工程', MATERIAL_MAP[m]?.name || m, '坪', ping(Math.abs(polygonArea(r.points))), p, { waste: w, detail: r.name });
  }
  for (const { room, mat, area } of wallAreas(P)) {
    const [p, w] = WALL[mat] || [1000, 0];
    add(`wall:${mat}`, '牆面工程', MATERIAL_MAP[mat]?.name || mat, '坪', ping(area), p, { waste: w, detail: room.name });
  }
  {
    for (const r of rooms) add('ceiling', '天花板工程', '平釘天花板（矽酸鈣板含批土油漆）', '坪', ping(Math.abs(polygonArea(r.points))), CEILING, { detail: r.name });
  }
  const roomAtPt = (x, y) => rooms.find((r) => pointInPolygon(x, y, r.points))?.name || '';
  const opRooms = openingRooms(P, rooms);
  for (const op of P.openings) {
    const def = OPENING_MAP[op.kind];
    if (!def) continue;
    const room = opRooms.get(op.id) || '';
    if (def.cat === 'door') add(`op:${op.kind}`, '門窗', def.name, '樘', 1, DOOR[op.kind] || 15000, { room });
    else add(`op:${op.kind}`, '門窗', `氣密窗 · ${def.name}`, '才', ((op.width || def.width) * (op.height || def.height)) / CAI, WINDOW[op.kind] || 1200, { room });
  }
  for (const it of P.items) {
    const def = CATALOG_MAP[it.kind];
    if (!def) continue;
    const g = groupOf(it.kind), room = roomAtPt(it.x, it.y);
    if (PER_CHI[it.kind]) add(`item:${it.kind}`, g, def.name, '尺', it.w / CHI, PER_CHI[it.kind], { room });
    else add(`item:${it.kind}`, g, def.name, ['dining_chair', 'bar_stool', 'office_chair', 'armchair'].includes(it.kind) ? '張' : '件', 1, EACH[it.kind] || 5000, { room });
  }
  for (const e of EXTRAS) {
    add(`extra:${e.id}`, '其他工程', e.name, '坪', totalPing, e.per);
  }
  for (const c of B.custom || []) {
    const L = { key: `custom:${c.id}`, group: GROUPS.includes(c.group) ? c.group : '其他工程', name: c.name || '自訂工程', unit: c.unit || '式', qty: Number(c.qty) || 0, waste: 0, details: new Map(), byRoom: new Map(), price: Number(c.price) || 0, custom: true };
    lines.set(L.key, L);
  }

  const groups = GROUPS.map((name) => {
    const ls = [...lines.values()].filter((l) => l.group === name).map((l) => {
      const qty = l.unit === '件' || l.unit === '張' || l.unit === '樘' ? l.qty : Math.round(l.qty * (1 + l.waste) * 100) / 100;
      return { ...l, on: lineOn(B, l.key), qtyRaw: l.qty, qty, amount: Math.round(qty * l.price), details: [...l.details].map(([k, v]) => `${k} ${Math.round(v * 100) / 100}`) };
    });
    return { name, lines: ls, subtotal: ls.reduce((s, l) => s + (l.on ? l.amount : 0), 0) };
  }).filter((g) => g.lines.length);
  const total = groups.reduce((s, g) => s + g.subtotal, 0);
  return { groups, rooms: byRoom(groups, rooms), total, area: totalPing, perPing: totalPing ? Math.round(total / totalPing) : 0, tier: B.tier || 'standard' };
}

const SHARED = '全室共用';

// 依房間分組：每個項目依各房間的數量拆分金額（拆分後尾數歸到最後一個房間，總計不變）；
// 沒有對應房間的項目（其他工程、自訂工程、房間外的家具）歸到「全室共用」
function byRoom(groups, rooms) {
  const out = new Map([...rooms.map((r) => [r.name, []]), [SHARED, []]]);
  for (const g of groups) {
    for (const l of g.lines) {
      const parts = [...l.byRoom].filter(([, q]) => q > 0);
      const known = parts.reduce((s, [, q]) => s + q, 0);
      if (l.qtyRaw - known > 1e-6) parts.push([SHARED, l.qtyRaw - known]);
      let left = l.amount;
      parts.forEach(([room, q], i) => {
        const share = q / (l.qtyRaw || 1);
        const amount = i === parts.length - 1 ? left : Math.round(l.amount * share);
        left -= amount;
        const qty = l.unit === '件' || l.unit === '張' || l.unit === '樘' ? q : Math.round(l.qty * share * 100) / 100;
        if (!out.has(room)) out.set(room, []);
        out.get(room).push({ ...l, qty, amount, details: [], group: g.name });
      });
    }
  }
  return [...out].map(([name, lines]) => ({ name, lines, subtotal: lines.reduce((s, l) => s + (l.on ? l.amount : 0), 0) })).filter((g) => g.lines.length);
}

// 門窗歸屬的房間：窗取所在的房間；門取兩側中門數較少的房間（房門算在臥室、書房，而不是走道或客廳），
// 門數相同時取面積較小的房間
function openingRooms(P, rooms) {
  const sides = new Map(), doors = new Map();
  for (const op of P.openings) {
    const w = P.walls.find((x) => x.id === op.wallId);
    if (!w) continue;
    const { x, y, f } = openingCenter(op, w);
    const off = (w.thickness || 12) / 2 + 15;
    const hits = [...new Set([1, -1].map((k) => rooms.find((r) => pointInPolygon(x + f.nx * off * k, y + f.ny * off * k, r.points))).filter(Boolean))];
    sides.set(op.id, hits);
    if (OPENING_MAP[op.kind]?.cat === 'door') for (const r of hits) doors.set(r, (doors.get(r) || 0) + 1);
  }
  const out = new Map();
  for (const [id, hits] of sides) {
    if (!hits.length) continue;
    hits.sort((a, b) => (doors.get(a) || 0) - (doors.get(b) || 0) || Math.abs(polygonArea(a.points)) - Math.abs(polygonArea(b.points)));
    out.set(id, hits[0].name);
  }
  return out;
}

// CSV（加上 BOM，Windows 的 Excel 開啟不會亂碼）
export function budgetCSV(P = store.project, mode = 'group') {
  const r = computeBudget(P);
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [[mode === 'room' ? '房間' : '類別', '項目', '數量', '單位', '損耗', '單價（元）', '小計（元）', mode === 'room' ? '類別' : '說明', '備註', '照片']];
  for (const g of mode === 'room' ? r.rooms : r.groups) {
    for (const l of g.lines.filter((x) => x.on)) rows.push([g.name, l.name, l.qty, l.unit, l.waste ? `${Math.round(l.waste * 100)}%` : '', l.price, l.amount, mode === 'room' ? l.group : l.details.join('、'), P.budgetNotes?.[l.key]?.text || '', P.budgetNotes?.[l.key]?.photos?.length ? `${P.budgetNotes[l.key].photos.length} 張` : '']);
    rows.push([g.name, '小計', '', '', '', '', g.subtotal, '']);
  }
  rows.push(['', '總計', '', '', '', '', r.total, `室內約 ${r.area.toFixed(1)} 坪，每坪約 ${r.perPing} 元`]);
  return `﻿${rows.map((row) => row.map(q).join(',')).join('\r\n')}`;
}
