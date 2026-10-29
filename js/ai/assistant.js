// 一句話改設計：使用者用自然語言描述想要的修改，Claude 透過工具直接調整專案（移動 / 新增 / 刪除家具、換材質、套用風格…）。
// 每次指令的所有修改合併成一個復原點，可一鍵復原。API Key 只存在使用者瀏覽器，直接連線 Anthropic。
import Anthropic from '../../vendor/anthropic-sdk.min.js';
import { store } from '../core/state.js';
import { pointInPolygon, polygonArea, polygonBBox, largestInnerRect, wallFrame, wallLength, PING } from '../core/geometry.js';
import { wallOnRoom, wallSideToward } from '../core/model.js';
import { CATALOG, CATALOG_MAP, OPENING_MAP, CATEGORIES } from '../data/catalog.js';
import { MATERIALS, MATERIAL_MAP } from '../data/materials.js';
import { STYLES, STYLE_MAP } from '../data/styles.js';
import { autoDesign, analyzeRooms, ROOM_TYPES } from './designer.js';
import { MODEL, getApiKey } from './claude.js';

const MAX_ROUNDS = 14; // 單一指令最多幾輪工具呼叫
const MAX_HISTORY = 40; // 對話超過這個訊息數就重新開始，避免越來越慢

// ---------------------------------------------------------------- 幾何工具
const r1 = (v) => Math.round(v);
const rad = (d) => (d * Math.PI) / 180;

// 物件四個角（平面座標，公分）。rot 為順時針角度；物件正面朝本地 +y
function corners(it, shrink = 0) {
  const a = rad(it.rot || 0), c = Math.cos(a), s = Math.sin(a);
  const hw = Math.max(0, it.w / 2 - shrink), hd = Math.max(0, it.d / 2 - shrink);
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => [it.x + x * c - y * s, it.y + x * s + y * c]);
}

// 兩個旋轉矩形是否重疊（分離軸），容許 tol 公分的接觸
function overlaps(a, b, tol = 1) {
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

function roomOf(x, y, P = store.project) { return P.rooms.find((r) => pointInPolygon(x, y, r.points)) || null; }

// 房間的牆：內側面的起訖點、朝房間內的法線
function roomWalls(room, P = store.project) {
  const out = [];
  for (const w of P.walls) {
    if (!wallOnRoom(w, room)) continue;
    const side = wallSideToward(w, room);
    if (!side) continue;
    const f = wallFrame(w), k = side === 'A' ? 1 : -1;
    const nx = f.nx * k, ny = f.ny * k, off = w.thickness / 2;
    const L = wallLength(w);
    // 這面牆屬於此房間的範圍（外牆常橫跨好幾個房間）：沿牆取樣，往房內偏移後仍在房間內的部分
    let u0 = Infinity, u1 = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const u = (L * i) / 100;
      if (pointInPolygon(w.x1 + f.ux * u + nx * (off + 4), w.y1 + f.uy * u + ny * (off + 4), room.points)) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); }
    }
    if (!(u1 > u0)) continue;
    out.push({
      wall: w, side, nx, ny, u0, u1, f,
      x1: w.x1 + f.ux * u0 + nx * off, y1: w.y1 + f.uy * u0 + ny * off, x2: w.x1 + f.ux * u1 + nx * off, y2: w.y1 + f.uy * u1 + ny * off,
      length: L,
      // 面向房間內的方向：正面朝此方向的家具就是背靠這面牆
      facing: Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? '+x（右）' : '-x（左）') : (ny > 0 ? '+y（下）' : '-y（上）'),
    });
  }
  return out;
}

// 會佔走道的家具（地毯、吊燈、掛牆物件、窗簾不算）
const blocking = (it) => { const d = CATALOG_MAP[it.kind]; return d && !d.flat && !d.ceiling && it.kind !== 'curtain' && (it.elev || 0) < 100; };

// 檢查物件位置：是否在房間內、是否和其他家具重疊、是否擋住門
function checkPlacement(it, P = store.project) {
  const warn = [];
  const room = roomOf(it.x, it.y, P);
  if (!room) warn.push('物件中心不在任何房間內');
  else if (!corners(it, 2).every(([x, y]) => pointInPolygon(x, y, room.points))) warn.push(`物件超出「${room.name}」的範圍（可能穿牆）`);
  if (blocking(it)) {
    const hits = P.items.filter((o) => o !== it && blocking(o) && overlaps(it, o)).map((o) => `${o.name}（${o.id}）`);
    if (hits.length) warn.push(`和其他家具重疊：${hits.join('、')}`);
    for (const op of P.openings) {
      const def = OPENING_MAP[op.kind];
      if (def?.cat !== 'door') continue;
      const w = P.walls.find((x) => x.id === op.wallId);
      if (!w) continue;
      const f = wallFrame(w);
      const cx = w.x1 + f.ux * op.offset, cy = w.y1 + f.uy * op.offset;
      // 門前方（兩側）各留門寬的淨空
      for (const s of [1, -1]) {
        const zone = { x: cx + f.nx * s * (op.width / 2 + w.thickness / 2), y: cy + f.ny * s * (op.width / 2 + w.thickness / 2), w: op.width, d: op.width, rot: (f.angle * 180) / Math.PI };
        if (overlaps(it, zone, 2)) { warn.push(`擋住「${def.name}」（${op.id}）的開門範圍`); break; }
      }
    }
  }
  return warn;
}

// ---------------------------------------------------------------- 給 Claude 的專案摘要
export function describeProject(P = store.project) {
  const types = new Map(analyzeRooms(P).map((a) => [a.room.id, a.type]));
  const rooms = P.rooms.map((r) => {
    const bb = polygonBBox(r.points);
    return {
      id: r.id, name: r.name, type: ROOM_TYPES[types.get(r.id)] || types.get(r.id),
      area: `${(Math.abs(polygonArea(r.points)) / 10000).toFixed(1)} m²（${(Math.abs(polygonArea(r.points)) / 10000 / PING).toFixed(1)} 坪）`,
      bbox: [r1(bb.x0), r1(bb.y0), r1(bb.x1), r1(bb.y1)],
      floor: r.floor,
    };
  });
  const items = P.items.map((it) => ({
    id: it.id, kind: it.kind, name: it.name, room: roomOf(it.x, it.y, P)?.name || '（房間外）',
    x: r1(it.x), y: r1(it.y), rot: r1(it.rot || 0), w: it.w, d: it.d, h: it.h, ...(it.elev ? { elev: it.elev } : {}),
  }));
  return { style: P.design.styleId || null, wallHeight: P.settings.wallHeight, night: !!P.settings.night, rooms, items };
}

function roomDetail(room, P = store.project) {
  const walls = roomWalls(room, P);
  const inner = largestInnerRect(room.points);
  return {
    id: room.id, name: room.name, floor: room.floor, polygon: room.points.map(([x, y]) => [r1(x), r1(y)]),
    usable_rect: inner ? { x0: r1(inner.x0), y0: r1(inner.y0), x1: r1(inner.x1), y1: r1(inner.y1) } : null,
    walls: walls.map((w) => ({
      wall_id: w.wall.id,
      // along 從牆起點算起；房間只佔 room_span 這一段
      room_span: [r1(w.u0), r1(w.u1)],
      inner_face: { from: [r1(w.x1), r1(w.y1)], to: [r1(w.x2), r1(w.y2)] },
      into_room: w.facing,
      material: w.wall[w.side === 'A' ? 'matA' : 'matB'],
      openings: P.openings.filter((o) => o.wallId === w.wall.id && o.offset >= w.u0 - 5 && o.offset <= w.u1 + 5).map((o) => ({
        opening_id: o.id, name: OPENING_MAP[o.kind]?.name || o.kind, along: r1(o.offset), width: o.width, sill: o.sill, height: o.height,
      })),
    })),
    items: P.items.filter((it) => pointInPolygon(it.x, it.y, room.points)).map((it) => ({
      id: it.id, name: it.name, kind: it.kind, x: r1(it.x), y: r1(it.y), rot: r1(it.rot || 0), w: it.w, d: it.d, h: it.h,
      footprint: corners(it).map(([x, y]) => [r1(x), r1(y)]),
    })),
  };
}

const SYSTEM = `你是 Interior Studio 網頁室內設計工具裡的設計助理。使用者會用一句話（繁體中文）描述想要的修改，你用提供的工具直接修改設計，畫面會即時更新。

座標與慣例：
- 平面圖單位為公分，x 向右、y 向下。家具的 (x, y) 是中心點，w 是寬（沿本地 x）、d 是深、h 是高。
- rot 是順時針角度。rot = 0 時家具正面朝 +y（下），背面朝 -y；rot = 90 正面朝 -x；rot = 180 正面朝 -y；rot = 270 正面朝 +x。
- 要讓家具背靠某面牆（沙發、床頭、櫃子、電視櫃），優先用 place_against_wall，它會自動算好位置與方向；要靠窗或對齊門窗時，用 align_opening_id。
- 需要牆、門窗、家具位置的細節時，先呼叫 get_room。
- 每次放置都會回報警告（超出房間、重疊、擋門）。有警告就調整，直到沒有警告或已盡量合理。

做法：
- 直接動手，不要先問使用者確認。需求含糊時，依常見的台灣居家設計習慣做出合理選擇，完成後說明你的選擇。
- 只改使用者要求的部分，不要動其他家具。
- 修改材質時，地板用 floor 類材質，牆面用 wall 類材質（both 類兩者皆可）。
- 完成後用一到三句繁體中文（台灣用語）說明做了什麼，不使用 emoji、不用 Markdown 標題。做不到的部分要直接說明原因。

可用的家具：
${CATALOG.map((d) => `${d.id}（${d.name}，${CATEGORIES[d.cat] || d.cat}，${d.w}×${d.d}×${d.h}${d.elev ? `，離地 ${d.elev}` : ''}）`).join('；')}

可用的材質：
${MATERIALS.map((m) => `${m.id}（${m.name}，${m.cat}）`).join('；')}

可用的風格：
${STYLES.map((s) => `${s.id}（${s.name}）`).join('；')}`;

// ---------------------------------------------------------------- 工具定義
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const tool = (name, description, properties, required) => ({
  name, description, eager_input_streaming: true,
  input_schema: { type: 'object', properties, required, additionalProperties: false },
});

export const TOOLS = [
  tool('get_room', '取得房間的詳細資料：多邊形、可用矩形、每面牆的內側面座標與朝向、牆上的門窗位置（along 為從牆起點算起的中心距離）、房內家具與佔地。', {
    room_id: str('房間 id'),
  }, ['room_id']),
  tool('move_item', '把家具移到指定的中心座標與角度。只想轉向時 x、y 可省略。', {
    item_id: str('家具 id'), x: num('中心 x（公分）'), y: num('中心 y（公分）'), rot: num('順時針角度'),
  }, ['item_id']),
  tool('place_against_wall', '讓家具背靠房間的某面牆，正面朝向房間內。可指定既有家具 item_id，或用 kind 新增一件。位置用 align_opening_id（對齊門窗中心）或 along（沿牆內側面、從牆起點算起的中心距離）；兩者都沒給時放在牆的中間。', {
    room_id: str('房間 id'), wall_id: str('牆 id（由 get_room 取得）'),
    item_id: str('既有家具 id（與 kind 擇一）'), kind: str('新增的家具種類 id（與 item_id 擇一）'),
    align_opening_id: str('對齊這個門窗的中心'), along: num('沿牆中心位置（公分）'),
    gap: num('與牆的距離（公分），預設 2'),
  }, ['room_id', 'wall_id']),
  tool('add_item', '新增家具到指定中心座標。', {
    kind: str('家具種類 id'), x: num('中心 x'), y: num('中心 y'), rot: num('順時針角度，預設 0'),
    w: num('寬（公分），預設目錄尺寸'), d: num('深'), h: num('高'),
  }, ['kind', 'x', 'y']),
  tool('remove_items', '刪除家具。', {
    item_ids: { type: 'array', items: { type: 'string' }, description: '要刪除的家具 id' },
  }, ['item_ids']),
  tool('update_item', '調整家具的尺寸、離地高度、顏色或左右翻轉。', {
    item_id: str('家具 id'), w: num('寬'), d: num('深'), h: num('高'), elev: num('離地高度'),
    color: str('主色（#rrggbb），空字串恢復風格預設'), color2: str('第二色（#rrggbb）'), mirror: { type: 'boolean', description: '左右翻轉' },
  }, ['item_id']),
  tool('set_floor', '更換房間地板材質。room_id 用 "all" 代表全部房間。', {
    room_id: str('房間 id 或 all'), material_id: str('材質 id（floor 或 both 類）'),
  }, ['room_id', 'material_id']),
  tool('set_walls', '更換房間牆面材質（只改朝向該房間的那一面）。可只改一面牆。', {
    room_id: str('房間 id 或 all'), material_id: str('材質 id（wall 或 both 類）'), wall_id: str('只改這面牆（選填）'),
  }, ['room_id', 'material_id']),
  tool('apply_style', '套用風格模板，自動配置家具、材質與配色。mode：replace 重新配置家具、keep 保留現有家具只補缺少的、materials 只換材質與配色。', {
    style_id: str('風格 id'), mode: { type: 'string', enum: ['replace', 'keep', 'materials'] },
    room_ids: { type: 'array', items: { type: 'string' }, description: '只套用到這些房間（選填，預設全部）' },
  }, ['style_id', 'mode']),
  tool('update_room', '修改房間名稱或類型。', {
    room_id: str('房間 id'), name: str('新名稱'), type: { type: 'string', enum: Object.keys(ROOM_TYPES) },
  }, ['room_id']),
  tool('set_lighting', '切換日間 / 夜間燈光與天花板顯示。', {
    night: { type: 'boolean', description: 'true 為夜間（開燈）' }, ceiling: { type: 'boolean', description: '是否顯示天花板' },
  }, []),
];

// ---------------------------------------------------------------- 工具執行
class ToolError extends Error {}
const need = (cond, msg) => { if (!cond) throw new ToolError(msg); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const getItem = (id) => { const it = store.project.items.find((i) => i.id === id); need(it, `找不到家具 ${id}`); return it; };
const getRoom = (id) => { const r = store.project.rooms.find((x) => x.id === id); need(r, `找不到房間 ${id}`); return r; };
const roomsOf = (id) => (id === 'all' ? store.project.rooms : [getRoom(id)]);
const placed = (it, action) => ({ ok: true, action, item: { id: it.id, name: it.name, x: r1(it.x), y: r1(it.y), rot: r1(it.rot || 0), w: it.w, d: it.d }, warnings: checkPlacement(it) });

function newItem(kind, x, y, extra = {}) {
  need(CATALOG_MAP[kind], `沒有這種家具：${kind}`);
  const it = store.addItem(kind, x, y, extra);
  need(it, `無法新增 ${kind}`);
  return it;
}

const EXEC = {
  get_room: ({ room_id }) => roomDetail(getRoom(room_id)),

  move_item: ({ item_id, x, y, rot }) => {
    const it = getItem(item_id);
    if (isNum(x)) it.x = r1(x);
    if (isNum(y)) it.y = r1(y);
    if (isNum(rot)) it.rot = ((r1(rot) % 360) + 360) % 360;
    return placed(it, `移動「${it.name}」`);
  },

  place_against_wall: ({ room_id, wall_id, item_id, kind, align_opening_id, along, gap }) => {
    const room = getRoom(room_id);
    const w = roomWalls(room).find((x) => x.wall.id === wall_id);
    need(w, `牆 ${wall_id} 不在「${room.name}」的邊界上，請用 get_room 查詢`);
    need(item_id || kind, '需要 item_id 或 kind');
    const def = CATALOG_MAP[item_id ? getItem(item_id).kind : kind];
    need(def, `沒有這種家具：${kind}`);
    let pos;
    if (align_opening_id) {
      const op = store.project.openings.find((o) => o.id === align_opening_id && o.wallId === wall_id);
      need(op, `門窗 ${align_opening_id} 不在這面牆上`);
      need(op.offset >= w.u0 - 5 && op.offset <= w.u1 + 5, `門窗 ${align_opening_id} 不在「${room.name}」這一段牆上`);
      pos = op.offset;
    } else pos = isNum(along) ? along : (w.u0 + w.u1) / 2;
    const it = item_id ? getItem(item_id) : newItem(kind, 0, 0);
    // 沿牆位置限制在房間這一段牆內，家具不超出兩端
    const half = it.w / 2;
    pos = Math.min(Math.max(pos, w.u0 + half), Math.max(w.u0 + half, w.u1 - half));
    const f = w.f, off0 = w.wall.thickness / 2;
    let g = isNum(gap) ? gap : (def.elev && def.d <= 12 ? 0 : 2);
    const put = () => {
      const off = off0 + it.d / 2 + g;
      it.x = r1(w.wall.x1 + f.ux * pos + w.nx * off);
      it.y = r1(w.wall.y1 + f.uy * pos + w.ny * off);
    };
    // 正面朝向法線：front(rot) = (-sin, cos)
    it.rot = ((r1((Math.atan2(-w.nx, w.ny) * 180) / Math.PI) % 360) + 360) % 360;
    put();
    // 牆前有窗簾時，往房內讓出窗簾的厚度
    if (!isNum(gap) && it.kind !== 'curtain') {
      const cur = store.project.items.filter((o) => o.kind === 'curtain' && o !== it && overlaps(it, o, 0));
      if (cur.length) { g += Math.max(...cur.map((o) => o.d)) + 2; put(); }
    }
    return placed(it, item_id ? `移動「${it.name}」靠牆` : `新增「${it.name}」靠牆`);
  },

  add_item: ({ kind, x, y, rot, w, d, h }) => {
    need(isNum(x) && isNum(y), '需要 x、y');
    const it = newItem(kind, r1(x), r1(y), { rot: isNum(rot) ? r1(rot) : 0, w: isNum(w) ? r1(w) : undefined, d: isNum(d) ? r1(d) : undefined, h: isNum(h) ? r1(h) : undefined });
    return placed(it, `新增「${it.name}」`);
  },

  remove_items: ({ item_ids }) => {
    need(Array.isArray(item_ids) && item_ids.length, '需要 item_ids');
    const names = item_ids.map((id) => getItem(id).name);
    for (const id of item_ids) store.remove('item', id);
    return { ok: true, action: `刪除${names.map((n) => `「${n}」`).join('')}` };
  },

  update_item: ({ item_id, w, d, h, elev, color, color2, mirror }) => {
    const it = getItem(item_id);
    for (const [k, v] of [['w', w], ['d', d], ['h', h], ['elev', elev]]) if (isNum(v)) { need(v >= 0 && v < 2000, `${k} 數值不合理`); it[k] = r1(v); }
    const hex = (v) => v === '' || /^#[0-9a-fA-F]{6}$/.test(v);
    if (color !== undefined) { need(hex(color), 'color 需為 #rrggbb'); it.color = color || null; }
    if (color2 !== undefined) { need(hex(color2), 'color2 需為 #rrggbb'); it.color2 = color2 || null; }
    if (typeof mirror === 'boolean') it.mirror = mirror;
    return placed(it, `調整「${it.name}」`);
  },

  set_floor: ({ room_id, material_id }) => {
    const m = MATERIAL_MAP[material_id];
    need(m && m.cat !== 'wall', `${material_id} 不是地板材質`);
    const rooms = roomsOf(room_id);
    for (const r of rooms) r.floor = material_id;
    return { ok: true, action: `${room_id === 'all' ? '全部房間' : `「${rooms[0].name}」`}地板換成「${m.name}」` };
  },

  set_walls: ({ room_id, material_id, wall_id }) => {
    const m = MATERIAL_MAP[material_id];
    need(m && m.cat !== 'floor', `${material_id} 不是牆面材質`);
    const rooms = roomsOf(room_id);
    let n = 0;
    for (const r of rooms) for (const w of roomWalls(r)) {
      if (wall_id && w.wall.id !== wall_id) continue;
      w.wall[w.side === 'A' ? 'matA' : 'matB'] = material_id; n++;
    }
    need(n, '沒有符合的牆');
    return { ok: true, action: `${room_id === 'all' ? '全部房間' : `「${rooms[0].name}」`}${wall_id ? '的一面牆' : '牆面'}換成「${m.name}」` };
  },

  apply_style: ({ style_id, mode, room_ids }) => {
    need(STYLE_MAP[style_id], `沒有這個風格：${style_id}`);
    need(['replace', 'keep', 'materials'].includes(mode), 'mode 不正確');
    const report = autoDesign(style_id, { mode, roomIds: room_ids?.length ? room_ids : undefined });
    return { ok: true, action: `套用「${STYLE_MAP[style_id].name}」風格`, rooms: report.rooms.map((r) => ({ name: r.name, notes: r.notes.slice(0, 3) })), project: describeProject() };
  },

  update_room: ({ room_id, name, type }) => {
    const r = getRoom(room_id);
    if (name) r.name = String(name).slice(0, 20);
    if (type) { need(ROOM_TYPES[type], '房間類型不正確'); r.type = type; }
    return { ok: true, action: `更新房間「${r.name}」` };
  },

  set_lighting: ({ night, ceiling }) => {
    const s = store.project.settings;
    if (typeof night === 'boolean') s.night = night;
    if (typeof ceiling === 'boolean') s.showCeiling = ceiling;
    return { ok: true, action: `切換為${s.night ? '夜間' : '日間'}燈光` };
  },
};

export function runTool(name, input) {
  const fn = EXEC[name];
  if (!fn) return { error: `未知的工具 ${name}`, isError: true };
  try {
    return { result: fn(input || {}) };
  } catch (e) {
    if (e instanceof ToolError) return { error: e.message, isError: true };
    console.error(e);
    return { error: `執行失敗：${e.message}`, isError: true };
  }
}

// ---------------------------------------------------------------- 對話
export class DesignAssistant {
  constructor({ onChange } = {}) {
    this.messages = [];
    this.onChange = onChange;
    this.busy = false;
  }

  reset() { this.messages = []; }

  /**
   * 執行一句指令
   * @param {string} text
   * @param {{ onText?: (t:string)=>void, onAction?: (a:{name:string, label:string, ok:boolean, warnings?:string[]})=>void, signal?: AbortSignal }} cb
   */
  async run(text, { onText, onAction, signal } = {}) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('尚未設定 Anthropic API Key');
    this.busy = true;
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    if (this.messages.length > MAX_HISTORY) this.messages = [];
    // 每次指令附上目前的設計狀態（使用者可能在兩次指令之間手動修改過）
    this.messages.push({
      role: 'user',
      content: `目前的設計（JSON）：\n${JSON.stringify(describeProject())}\n\n使用者的指令：${text}`,
    });
    let changed = false;
    this.said = false;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          // 遇到安全分類拒絕時由伺服器自動改用替代模型
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
          tools: TOOLS,
          messages: this.messages,
        }, { signal });
        let first = true;
        stream.on('text', (t) => {
          // 不同輪的說明分段顯示
          if (first && this.said) onText?.('\n');
          first = false; this.said = true;
          onText?.(t);
        });
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'refusal') throw new Error('Claude 無法處理這個指令，請換個說法再試一次。');
        if (msg.stop_reason === 'max_tokens') throw new Error('回應太長被截斷，請把指令拆成幾句。');
        // 完整保留回應內容（含思考區塊）再送回
        this.messages.push({ role: 'assistant', content: msg.content });
        const uses = msg.content.filter((b) => b.type === 'tool_use');
        if (msg.stop_reason !== 'tool_use' || !uses.length) break;
        const results = [];
        for (const u of uses) {
          const input = u.input && typeof u.input === 'object' ? u.input : null;
          let out;
          if (!input) out = { error: '工具參數不完整，請重新呼叫', isError: true };
          else {
            // 第一次修改前建立復原點：整句指令只佔一個復原步驟
            if (u.name !== 'get_room' && !changed) { store.checkpoint(); changed = true; }
            out = runTool(u.name, input);
          }
          if (u.name !== 'get_room') {
            const label = out.isError ? out.error : out.result.action;
            onAction?.({ name: u.name, label, ok: !out.isError, warnings: out.result?.warnings });
          }
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out.isError ? { error: out.error } : out.result), ...(out.isError ? { is_error: true } : {}) });
        }
        if (changed) store.changed('design');
        this.messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      // 中斷或失敗：移除這次不完整的對話，避免下次送出不成對的工具呼叫
      this.messages = [];
      throw e;
    } finally {
      this.busy = false;
      if (changed) this.onChange?.();
    }
    return { changed };
  }
}
