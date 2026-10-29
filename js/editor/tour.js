// 自動導覽影片：依門的連通關係排出走訪順序，從空拍開場、穿過門走進每個房間，
// 每個房間以「角落推軌加橫移」運鏡，最後再拉回空拍收尾；錄成影片供下載與分享。
import * as THREE from 'three';
import { store } from '../core/state.js';
import { wallFrame, pointInPolygon, polygonCentroid, polygonArea, polygonBBox, largestInnerRect, areaText } from '../core/geometry.js';
import { roomAt, projectBounds, openingCenter, nearestWall } from '../core/model.js';
import { OPENING_MAP, CATALOG_MAP } from '../data/catalog.js';
import { Mp4Muxer } from './mp4-mux.js';

const S = 0.01;
const EYE = 1.5; // 視線高度（公尺）
const ease = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// 點到線段距離
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}
function edgeDist(x, y, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    d = Math.min(d, segDist(x, y, ax, ay, bx, by));
  }
  return d;
}

// 房間內可站立的點：離牆 40 公分以上，且不在高大家具（衣櫃、冰箱、書櫃等）範圍內
function standPoints(room, P) {
  const pts = room.points;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const tall = P.items.filter((it) => (it.h ?? CATALOG_MAP[it.kind]?.h ?? 0) + (it.elev || 0) > 130 && pointInPolygon(it.x, it.y, pts));
  // 門片開啟的範圍（門中心半徑內）不站，避免鏡頭貼著打開的門
  const doorZones = doorLinks(P).map((l) => ({ c: l.c, r: l.op.width + 15 }));
  const nearDoor = (x, y) => doorZones.some((z) => Math.hypot(x - z.c[0], y - z.c[1]) < z.r);
  const blocked = (x, y) => nearDoor(x, y) || tall.some((it) => {
    const r = (-(it.rot || 0) * Math.PI) / 180;
    const dx = x - it.x, dy = y - it.y;
    const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
    return Math.abs(lx) < it.w / 2 + 25 && Math.abs(ly) < it.d / 2 + 25;
  });
  const step = Math.max(15, Math.min(40, Math.sqrt((x1 - x0) * (y1 - y0)) / 14));
  const out = [];
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      if (!pointInPolygon(x, y, pts)) continue;
      if (edgeDist(x, y, pts) < 40) continue;
      if (blocked(x, y)) continue;
      out.push([x, y]);
    }
  }
  return out;
}

// 房間的焦點：重心在房內就用重心，否則用最大內接矩形中心（L 型房間）
function roomFocus(room) {
  const c = polygonCentroid(room.points);
  if (pointInPolygon(c.x, c.y, room.points)) return [c.x, c.y];
  const r = largestInnerRect(room.points);
  return [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
}

// 門的連通關係：每扇門兩側各是哪個房間，以及兩側的站點
export function doorLinks(P = store.project) {
  const links = [];
  for (const op of P.openings) {
    const def = OPENING_MAP[op.kind];
    if (!def || def.cat !== 'door') continue;
    const w = P.walls.find((x) => x.id === op.wallId);
    if (!w) continue;
    const c = openingCenter(op, w);
    const f = wallFrame(w);
    const off = (w.thickness || 12) / 2 + 45;
    const pa = [c.x + f.nx * off, c.y + f.ny * off], pb = [c.x - f.nx * off, c.y - f.ny * off];
    const ra = roomAt(P.rooms, pa[0], pa[1]), rb = roomAt(P.rooms, pb[0], pb[1]);
    links.push({ op, def, c: [c.x, c.y], a: ra?.id || null, b: rb?.id || null, pa, pb });
  }
  return links;
}

// 沒有門、直接相連的房間（例如客餐廳與走道）：沿房間邊界找出沒有牆的一段，取中點當作通道
export function openLinks(P = store.project, rooms = P.rooms) {
  const links = [];
  const wallNear = (x, y) => {
    const n = nearestWall(P.walls, x, y, 60);
    return n && n.d < (n.wall.thickness || 12) / 2 + 4;
  };
  for (let i = 0; i < rooms.length; i++) {
    const A = rooms[i];
    for (let j = 0; j < rooms.length; j++) {
      if (i === j) continue;
      const B = rooms[j];
      let best = null;
      const pts = A.points;
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % pts.length];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 60) continue;
        const ux = (bx - ax) / L, uy = (by - ay) / L;
        let nx = -uy, ny = ux;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if (pointInPolygon(mx + nx * 10, my + ny * 10, pts)) { nx = -nx; ny = -ny; }
        // 沿邊每 10 公分取樣，找出外側屬於 B 且沒有牆的最長一段
        let run = null;
        for (let t = 5; t <= L - 5; t += 10) {
          const x = ax + ux * t, y = ay + uy * t;
          const open = pointInPolygon(x + nx * 25, y + ny * 25, B.points) && !wallNear(x, y);
          if (open) { run = run || { s: t, e: t }; run.e = t; } else run = null;
          if (run && (!best || run.e - run.s > best.len)) best = { len: run.e - run.s, s: run.s, ax, ay, ux, uy, nx, ny };
        }
      }
      if (!best || best.len < 50) continue;
      const t = (best.s + best.s + best.len) / 2;
      const c = [best.ax + best.ux * t, best.ay + best.uy * t];
      const pa = [c[0] - best.nx * 45, c[1] - best.ny * 45], pb = [c[0] + best.nx * 45, c[1] + best.ny * 45];
      if (!pointInPolygon(pa[0], pa[1], A.points) || !pointInPolygon(pb[0], pb[1], B.points)) continue;
      if (i < j || !links.some((l) => l.a === B.id && l.b === A.id)) links.push({ op: null, def: null, c, a: A.id, b: B.id, pa, pb, open: true });
    }
  }
  return links;
}

// 房間之間的通道圖：每個房間可去的鄰居 { to, from: 本側站點, at: 對側站點, door }
function tourGraph(P) {
  const rooms = P.rooms.filter((r) => r.points.length >= 3 && Math.abs(polygonArea(r.points)) > 1.2e4);
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const doors = doorLinks(P);
  const links = [...doors.filter((l) => byId.has(l.a) && byId.has(l.b) && l.a !== l.b), ...openLinks(P, rooms)];
  const adj = new Map(rooms.map((r) => [r.id, []]));
  for (const l of links) {
    if (adj.get(l.a).some((x) => x.to === l.b)) continue;
    adj.get(l.a).push({ to: l.b, from: l.pa, at: l.pb, door: l.op?.id || null });
    adj.get(l.b).push({ to: l.a, from: l.pb, at: l.pa, door: l.op?.id || null });
  }
  return { rooms, byId, adj, doors };
}

// 兩個房間之間經過最少通道的路線（可穿過任何房間）；太遠或不相通回傳 null
function routeBetween(g, fromId, toId, maxHops = 4) {
  const prev = new Map([[fromId, null]]);
  let frontier = [fromId];
  while (frontier.length && !prev.has(toId)) {
    const next = [];
    for (const id of frontier) for (const e of g.adj.get(id) || []) {
      if (prev.has(e.to)) continue;
      prev.set(e.to, { id, e });
      next.push(e.to);
    }
    frontier = next;
  }
  if (!prev.has(toId)) return null;
  const hops = [];
  for (let id = toId; prev.get(id); id = prev.get(id).id) hops.unshift(prev.get(id).e);
  return hops.length && hops.length <= maxHops ? hops.map((h) => ({ from: h.from, to: h.at, door: h.door })) : null;
}

// 走道、走廊只穿過不停留（窄走道裡停下來只會拍到門）
const isCorridor = (r) => /走道|走廊|過道|廊道/.test(r.name);

// 預設走訪順序：從玄關（大門所在房間）或客廳開始，優先穿過門走到相鄰、尚未去過的房間；
// 走到盡頭時沿原路走回，穿過已去過的房間到最近的新房間
function defaultStops(g) {
  const { rooms, byId, adj, doors } = g;
  if (!rooms.length) return [];
  const entry = doors.find((l) => l.def.entry && (byId.has(l.a) || byId.has(l.b)));
  let start = entry && byId.get(byId.has(entry.a) ? entry.a : entry.b);
  start = start || rooms.find((r) => /玄關/.test(r.name)) || rooms.find((r) => /客廳|起居/.test(r.name))
    || rooms.reduce((a, b) => (Math.abs(polygonArea(b.points)) > Math.abs(polygonArea(a.points)) ? b : a));
  // 客廳、餐廳等公共空間排前面，衛浴與儲藏室排後面
  const rank = (r) => (/客|餐|起居|廚/.test(r.name) ? 0 : /主臥/.test(r.name) ? 1 : /臥|房|書/.test(r.name) ? 2 : /浴|廁|儲|陽台|工作/.test(r.name) ? 4 : 3);
  const pass = new Set(rooms.filter(isCorridor).map((r) => r.id));
  if (pass.size === rooms.length) pass.clear();
  if (pass.has(start.id)) start = rooms.find((r) => !pass.has(r.id));
  const stops = rooms.filter((r) => !pass.has(r.id)).length;
  const seq = [start.id];
  const seen = new Set([start.id]);
  let cur = start;
  while (seen.size < stops) {
    const prev = new Map([[cur.id, null]]);
    let frontier = [cur.id], target = null;
    while (frontier.length && !target) {
      const next = [];
      for (const id of frontier) for (const e of adj.get(id)) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { id, e });
        next.push(e.to);
      }
      const fresh = next.filter((id) => !seen.has(id) && !pass.has(id)).map((id) => byId.get(id)).sort((x, y) => rank(x) - rank(y));
      if (fresh.length) target = fresh[0];
      frontier = next.filter((id) => seen.has(id) || pass.has(id));
    }
    target = target || rooms.filter((r) => !seen.has(r.id) && !pass.has(r.id)).sort((x, y) => rank(x) - rank(y))[0];
    seq.push(target.id);
    seen.add(target.id); cur = target;
  }
  return seq;
}

// 走訪步驟（可編輯）：{ room, skip, note }。依專案中儲存的順序，新增的房間依預設順序補在後面；
// 走道預設不停留。reset 為 true 時忽略儲存的設定。
export function tourSteps(P = store.project, { reset = false } = {}) {
  const g = tourGraph(P);
  const order = defaultStops(g);
  const def = [...order.map((id) => ({ room: id, skip: false, note: '' })),
    ...g.rooms.filter((r) => !order.includes(r.id)).map((r) => ({ room: r.id, skip: true, note: '' }))];
  const saved = reset ? [] : (P.settings.tour?.steps || []).filter((st) => g.byId.has(st.room));
  const have = new Set(saved.map((st) => st.room));
  return [...saved.map((st) => ({ room: st.room, skip: !!st.skip, note: String(st.note || '') })), ...def.filter((st) => !have.has(st.room))]
    .map((st) => ({ ...st, name: g.byId.get(st.room).name }));
}

// 依步驟排出實際走訪：每一站與從上一站走過來的路線（太遠或不相通時 via 為 null，以淡出淡入切換）
export function tourOrder(P = store.project, steps = tourSteps(P)) {
  const g = tourGraph(P);
  const seq = [];
  for (const st of steps) {
    if (st.skip || !g.byId.has(st.room)) continue;
    const prev = seq.at(-1);
    seq.push({ room: g.byId.get(st.room), note: st.note || '', via: prev ? routeBetween(g, prev.room.id, st.room) : null });
  }
  return seq;
}

// ---------------------------------------------------- 描述中提到的細節（特寫）
// 最長共同子字串長度
function lcs(a, b) {
  let best = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = b.length; j >= 1; j--) {
      dp[j] = a[i - 1] === b[j - 1] ? dp[j - 1] + 1 : 0;
      if (dp[j] > best) best = dp[j];
    }
  }
  return best;
}

// 房間內可特寫的對象：家具、門窗、地板、天花板
function detailCandidates(room, P) {
  const out = [];
  for (const it of P.items) {
    if (!pointInPolygon(it.x, it.y, room.points)) continue;
    const def = CATALOG_MAP[it.kind];
    const name = it.name || def?.name || '家具';
    out.push({ type: 'item', name, keys: [name, def?.name].filter(Boolean), it, size: Math.max(it.w, it.d) });
  }
  for (const op of P.openings) {
    const def = OPENING_MAP[op.kind];
    const w = P.walls.find((x) => x.id === op.wallId);
    if (!def || !w) continue;
    const c = openingCenter(op, w), f = wallFrame(w);
    const off = (w.thickness || 12) / 2 + 30;
    let n = null;
    if (pointInPolygon(c.x + f.nx * off, c.y + f.ny * off, room.points)) n = [f.nx, f.ny];
    else if (pointInPolygon(c.x - f.nx * off, c.y - f.ny * off, room.points)) n = [-f.nx, -f.ny];
    if (!n) continue;
    const win = def.cat === 'window';
    out.push({ type: 'opening', name: def.name, keys: [def.name, ...(win ? ['窗戶', '窗景', '窗'] : ['門口', '門'])], op, def, c: [c.x, c.y], n, size: op.width || def.width });
  }
  out.push({ type: 'floor', name: '地板', keys: ['地板', '地磚', '地面', '磁磚', '木地板', '拼花'] });
  out.push({ type: 'ceiling', name: '天花板', keys: ['天花板', '天花', '吊燈', '燈具', '燈光'] });
  return out;
}

// 把描述拆成短句，逐句找出對應的特寫對象；找不到的句子以字幕顯示
export function matchNote(room, note, P = store.project) {
  const phrases = String(note || '').split(/[，,、；;。\n]+/).map((x) => x.trim()).filter(Boolean);
  const cands = detailCandidates(room, P);
  const used = new Set();
  const details = [], texts = [];
  // 「A 的 B」以 B 為主體：主體有對應才特寫；主體找不到時整句改用字幕，避免拍錯東西
  const scoreOf = (text, c) => {
    let sc = 0;
    for (const k of c.keys) {
      if (text.includes(k)) sc = Math.max(sc, k.length * 2 + 1);
      else { const l = lcs(text, k); if (l >= 2) sc = Math.max(sc, l * 2); }
    }
    // 主體最後一個字是常見家具類別（桌、椅、櫃、床、燈、窗、門、鏡、畫）且名稱也有這個字
    const last = text.at(-1);
    if (!sc && '桌椅櫃床燈窗門鏡畫簾'.includes(last) && c.keys.some((k) => k.includes(last))) sc = 1;
    return sc;
  };
  for (const ph of phrases) {
    const k = ph.lastIndexOf('的');
    const head = k >= 0 && k < ph.length - 1 ? ph.slice(k + 1) : ph;
    let best = null, bestS = 0;
    for (const c of cands) {
      if (used.has(c)) continue;
      const sc = scoreOf(head, c);
      // 同分時選大的（例如兩扇窗選大的那扇）
      if (sc > bestS || (sc === bestS && sc > 0 && (c.size || 0) > (best.size || 0))) { bestS = sc; best = c; }
    }
    if (best && details.length < 3) { used.add(best); details.push({ phrase: ph, target: best }); } else texts.push(ph);
  }
  return { details, texts };
}

// 特寫運鏡：站在對象正前方（找不到可站位置時轉向側面），慢慢推近並微微繞行
function detailShot(room, d, P, pace) {
  const t = d.target;
  const inside = (x, y) => pointInPolygon(x, y, room.points) && edgeDist(x, y, room.points) >= 25;
  let center, hc, front, size;
  if (t.type === 'item') {
    const it = t.it;
    const r = ((it.rot || 0) * Math.PI) / 180;
    center = [it.x, it.y];
    hc = (it.elev || 0) + (it.h || 80) / 2;
    front = [-Math.sin(r), Math.cos(r)];
    size = Math.max(it.w, it.h || 80);
  } else if (t.type === 'opening') {
    center = t.c;
    hc = (t.op.sill ?? t.def.sill ?? 0) + (t.op.height || t.def.height) / 2;
    front = t.n;
    size = Math.max(t.size, t.op.height || t.def.height);
  } else {
    const f = roomFocus(room);
    const cand = standPoints(room, P);
    const p = cand.sort((a, b) => Math.hypot(a[0] - f[0], a[1] - f[1]) - Math.hypot(b[0] - f[0], b[1] - f[1]))[0] || f;
    const dx = f[0] - p[0], dy = f[1] - p[1];
    const L = Math.hypot(dx, dy) || 1;
    const dir = L > 30 ? [dx / L, dy / L] : [1, 0];
    const up = t.type === 'ceiling';
    const eye = up ? 1.35 : 1.45;
    const dur = (3.6 + Math.max(0, d.phrase.length - 10) * 0.08) / pace;
    const pos = (u) => { const e = ease(u); return v3(p[0] + dir[0] * 40 * e, eye, p[1] + dir[1] * 40 * e); };
    const look = (u) => {
      const q = pos(u);
      const ahead = new THREE.Vector3(dir[0], 0, dir[1]).multiplyScalar(up ? 1.2 : 1.1);
      return q.clone().add(ahead).setY(up ? P.settings.wallHeight * S : 0.05);
    };
    return { kind: 'detail', room, dur, pos, look, fovMul: 0.9, caption: d.phrase, sub: `${room.name} · ${t.name}` };
  }
  const base = Math.atan2(front[1], front[0]);
  let cam = null, dist = 0;
  // 先試正前方，再試左右偏 35°、70°，距離由遠到近
  for (const da of [0, 0.6, -0.6, 1.2, -1.2]) {
    for (const k of [1, 0.8, 0.62]) {
      const dd = Math.min(300, Math.max(110, size * 1.15 + 70)) * k;
      const a = base + da;
      const x = center[0] + Math.cos(a) * dd, y = center[1] + Math.sin(a) * dd;
      if (inside(x, y)) { cam = { a, dd }; dist = dd; break; }
    }
    if (cam) break;
  }
  if (!cam) {
    // 小空間：在房內找離對象最接近理想距離、且不在對象範圍內的位置
    const ideal = Math.min(220, Math.max(90, size * 0.9 + 50));
    const bb = polygonBBox(room.points);
    let bestD = Infinity;
    for (let x = bb.x0 + 10; x < bb.x1; x += 10) {
      for (let y = bb.y0 + 10; y < bb.y1; y += 10) {
        if (!pointInPolygon(x, y, room.points) || edgeDist(x, y, room.points) < 20) continue;
        const dd = Math.hypot(x - center[0], y - center[1]);
        if (dd < 55) continue;
        const sc = Math.abs(dd - ideal);
        if (sc < bestD) { bestD = sc; cam = { a: Math.atan2(y - center[1], x - center[0]), dd }; dist = dd; }
      }
    }
    if (!cam) return null;
  }
  const eye = Math.min(1.6, Math.max(0.95, hc * S + 0.35));
  const target = v3(center[0], hc * S, center[1]);
  // 繞行 ±6° 只在兩端都可站時才做
  const arc = inside(center[0] + Math.cos(cam.a + 0.1) * dist * 1.08, center[1] + Math.sin(cam.a + 0.1) * dist * 1.08)
    && inside(center[0] + Math.cos(cam.a - 0.1) * dist * 0.86, center[1] + Math.sin(cam.a - 0.1) * dist * 0.86) ? 0.1 : 0;
  const pos = (u) => {
    const e = ease(u);
    const a = cam.a + arc * (1 - 2 * e);
    const dd = dist * lerp(arc ? 1.08 : 1, 0.86, e);
    const p = v3(center[0] + Math.cos(a) * dd, eye, center[1] + Math.sin(a) * dd);
    if (!inside(p.x / S, p.z / S)) return v3(center[0] + Math.cos(cam.a) * dist, eye, center[1] + Math.sin(cam.a) * dist);
    return p;
  };
  const look = () => target.clone();
  const dur = (3.6 + Math.max(0, d.phrase.length - 10) * 0.08) / pace;
  return { kind: 'detail', room, dur, pos, look, fovMul: 0.85, caption: d.phrase, sub: `${room.name} · ${t.name}` };
}

// 房間內移動到下一個特寫：位置與視線一起平滑移動
function moveShot(a, b, pace) {
  const p0 = a.pos(1), p1 = b.pos(0), l0 = a.look(1), l1 = b.look(0);
  const dur = Math.max(1.4, p0.distanceTo(p1) / 0.8) / pace;
  const m0 = a.fovMul || 1, m1 = b.fovMul || 1;
  return {
    kind: 'move', dur,
    pos: (u) => p0.clone().lerp(p1, ease(u)),
    look: (u) => l0.clone().lerp(l1, ease(u)),
    fov: (u, base) => base * lerp(m0, m1, ease(u)),
  };
}

// 單一房間的運鏡：從離焦點最遠的角落（有入口時偏向入口那側）慢慢推近並橫移
function roomShot(room, P, entryPt, pace) {
  const focus = roomFocus(room);
  const cand = standPoints(room, P);
  if (!cand.length) cand.push(focus);
  const small = Math.abs(polygonArea(room.points)) < 6e4;
  let best = cand[0], bestS = -Infinity;
  // 6 m² 以下的小空間（浴室、儲藏室）：站在門口往內看，才拍得到整間
  if (small && entryPt) { best = entryPt; bestS = Infinity; }
  for (const p of bestS === Infinity ? [] : cand) {
    const d = Math.hypot(p[0] - focus[0], p[1] - focus[1]);
    const s = d - (entryPt ? 0.6 * Math.hypot(p[0] - entryPt[0], p[1] - entryPt[1]) : 0);
    if (s > bestS) { bestS = s; best = p; }
  }
  const dx = focus[0] - best[0], dy = focus[1] - best[1];
  const len = Math.hypot(dx, dy) || 1;
  // 推近：最多 120 公分、不超過到焦點距離的 35%，且終點仍需可站立
  let push = small ? Math.min(40, len * 0.3) : Math.min(120, len * 0.35);
  const ok = (x, y) => pointInPolygon(x, y, room.points) && edgeDist(x, y, room.points) >= (small ? 25 : 35);
  while (push > 0 && !ok(best[0] + (dx / len) * push, best[1] + (dy / len) * push)) push -= 15;
  push = Math.max(0, push);
  const end = [best[0] + (dx / len) * push, best[1] + (dy / len) * push];
  // 橫移：視線焦點沿垂直方向由一側掃到另一側
  const px = -dy / len, py = dx / len;
  const sweep = Math.min(120, len * 0.3);
  const area = Math.abs(polygonArea(room.points));
  const dur = Math.min(7.5, 4.2 + area / 4e5) / pace;
  const pos = (u) => { const e = ease(u); return v3(lerp(best[0], end[0], e), EYE, lerp(best[1], end[1], e)); };
  const look = (u) => {
    const e = ease(u);
    return levelLook(pos(u), v3(focus[0] + px * sweep * (e - 0.5) * 2, EYE, focus[1] + py * sweep * (e - 0.5) * 2));
  };
  return { kind: 'room', room, dur, pos, look, start: best, end, caption: room.name, sub: areaText(area) };
}

function v3(x, y, z) { return new THREE.Vector3(x * S, y, z * S); }

// 室內鏡頭維持接近水平的視線（略往下 4°），牆角與門框的垂直線才不會歪斜
function levelLook(p, target) {
  const d = target.clone().sub(p).setY(0);
  if (d.lengthSq() < 1e-8) d.set(0, 0, -1);
  d.normalize().multiplyScalar(3);
  return p.clone().add(d).setY(p.y - 0.21);
}

const dirOf = (target, p) => target.clone().sub(p).setY(0).normalize();

// 穿門轉場：沿曲線依序走過每個門口（或開放通道），視線看前方，頭尾與前後運鏡的視線平滑銜接
function walkShot(fromShot, toShot, via, pace) {
  const pts = [fromShot.pos(1)];
  for (const h of via) pts.push(v3(h.from[0], EYE, h.from[1]), v3(h.to[0], EYE, h.to[1]));
  pts.push(toShot.pos(0));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const length = curve.getLength();
  const dur = Math.max(2.2, length / 1.15) / pace;
  const look0 = fromShot.look(1), look1 = toShot.look(0);
  const pos = (u) => curve.getPointAt(ease(u));
  const look = (u) => {
    const e = ease(u);
    const p = curve.getPointAt(e);
    const ahead = curve.getPointAt(Math.min(1, e + 0.5 / Math.max(1, length))).sub(p);
    ahead.y = 0;
    if (ahead.lengthSq() < 1e-6) ahead.copy(look1).sub(p).setY(0);
    const fwd = levelLook(p, p.clone().add(ahead));
    // 開頭由前一個視線轉向前方，最後轉向下一個運鏡的視線（以時間計，長路線也一樣快）
    const k0 = Math.min(0.4, 1.1 / dur), k1 = Math.min(0.4, 1.4 / dur);
    // 以水平角度沿最短方向轉動
    const mix = (a, b, k) => {
      const da = dirOf(a, p), db = dirOf(b, p);
      const t0 = Math.atan2(da.z, da.x);
      let dt = Math.atan2(db.z, db.x) - t0;
      dt = Math.atan2(Math.sin(dt), Math.cos(dt));
      const ang = t0 + dt * k;
      return levelLook(p, p.clone().add(new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang))));
    };
    if (u < k0) return mix(look0, fwd, ease(u / k0));
    if (u > 1 - k1) return mix(fwd, look1, ease((u - 1 + k1) / k1));
    return fwd;
  };
  // 每扇門在走到前約 1.2 秒打開
  const doors = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += pts[i].distanceTo(pts[i - 1]);
    const h = via[Math.floor((i - 1) / 2)];
    if (i % 2 === 1 && h?.door) doors.push({ id: h.door, u: Math.max(0, acc / length - 1.2 / dur) });
  }
  const m0 = fromShot.fovMul || 1, m1 = toShot.fovMul || 1;
  const fov = (u, base) => base * lerp(m0, m1, ease(Math.min(1, u * 2.5)));
  return { kind: 'walk', dur, pos, look, doors, fov };
}

// 空拍：繞著整個平面轉動，開場時慢慢降低、結尾時慢慢拉高
function aerialShot(P, aspect, dir, pace) {
  const b = projectBounds(P);
  const cx = ((b.x0 + b.x1) / 2) * S, cz = ((b.y0 + b.y1) / 2) * S;
  const R = Math.max(b.x1 - b.x0, b.y1 - b.y0) * S;
  const fov = THREE.MathUtils.degToRad(50);
  const fit = (R * 0.62) / Math.tan(fov / 2) / Math.min(1, aspect * 0.9);
  const dur = 5.5 / Math.sqrt(pace);
  const a0 = dir > 0 ? 0.35 : 1.25, a1 = dir > 0 ? 1.15 : 2.05;
  const pos = (u) => {
    const e = ease(u);
    const ang = lerp(a0, a1, e);
    const k = dir > 0 ? lerp(1.12, 0.9, e) : lerp(0.92, 1.12, e);
    const el = dir > 0 ? lerp(0.95, 0.78, e) : lerp(0.8, 0.98, e);
    const d = fit * k;
    return new THREE.Vector3(cx + Math.cos(ang) * Math.cos(el) * d, Math.sin(el) * d + 0.5, cz + Math.sin(ang) * Math.cos(el) * d);
  };
  const look = () => new THREE.Vector3(cx, 0.4, cz);
  return { kind: 'aerial', dur, pos, look, fov: 50 };
}

// 規劃整支影片：回傳依序播放的運鏡清單與每段的開始時間。steps 為可編輯的走訪步驟（省略時用專案設定）
export function planTour(P = store.project, { aspect = 16 / 9, pace = 1, steps } = {}) {
  const order = tourOrder(P, steps || tourSteps(P));
  if (!order.length) return null;
  const shots = [];
  const totalArea = order.reduce((s, x) => s + Math.abs(polygonArea(x.room.points)), 0);
  shots.push({ ...aerialShot(P, aspect, 1, pace), caption: P.name || '室內設計', sub: `${order.length} 個空間 · ${areaText(totalArea)}`, title: true, fadeOut: true });
  let prev = null;
  for (const step of order) {
    const shot = roomShot(step.room, P, step.via?.at(-1).to, pace);
    // 描述：提到的家具、門窗、地板或天花板加拍特寫；找不到對象的句子顯示在房間字幕下方
    const { details, texts } = matchNote(step.room, step.note, P);
    step.shotDetails = []; step.shotTexts = [...texts];
    if (texts.length) { shot.note = texts.join('，'); shot.dur += Math.min(3, 0.8 + shot.note.length * 0.06) / pace; }
    if (prev && step.via) shots.push(walkShot(prev, shot, step.via, pace));
    else shot.fadeIn = true;
    if (prev && !step.via) prev.fadeOut = true;
    shots.push(shot);
    prev = shot;
    for (const d of details) {
      const ds = detailShot(step.room, d, P, pace);
      if (!ds) { shot.note = [shot.note, d.phrase].filter(Boolean).join('，'); step.shotTexts.push(d.phrase); continue; }
      step.shotDetails.push(d.target.name);
      shots.push(moveShot(prev, ds, pace), ds);
      prev = ds;
    }
  }
  prev.fadeOut = true;
  shots.push({ ...aerialShot(P, aspect, -1, pace), fadeIn: true, caption: P.name || '室內設計', sub: 'Interior Studio', title: true, outro: true });
  let t = 0;
  for (const s of shots) { s.t0 = t; t += s.dur; }
  return { shots, duration: t, rooms: order.map((x) => x.room), order };
}

// 依寬度換行（中文逐字、英文以空白斷開），超過行數以「…」結尾
function wrapLines(ctx, text, maxW, maxLines) {
  const tokens = String(text).match(/[A-Za-z0-9.,'-]+\s*|\s+|./gu) || [];
  const lines = [];
  let cur = '';
  for (const tk of tokens) {
    if (ctx.measureText(cur + tk).width > maxW && cur) { lines.push(cur.trimEnd()); cur = tk.trimStart(); } else cur += tk;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const out = lines.slice(0, maxLines);
    let last = out[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    out[maxLines - 1] = `${last}…`;
    return out;
  }
  return lines;
}

// 支援的錄影格式：優先 MP4（iPhone、Windows 都能直接播放），否則 WebM
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || null;
}

// 播放與錄製：接手 3D 檢視的相機與畫面，每個畫面合成字幕後錄進影片。
// 有 WebCodecs 時逐格編碼（每格固定 1/30 秒，電腦慢只會做比較久，影片仍然流暢）；
// 沒有時改用 MediaRecorder 即時錄影。
const FPS = 30;
export class TourPlayer {
  constructor(view, { width = 1280, height = 720, pace = 1, captions = true, openDoors = true, record = true, encoder = null, onProgress, onDone } = {}) {
    this.view = view;
    this.W = width; this.H = height;
    this.captions = captions;
    this.openDoors = openDoors;
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.plan = planTour(store.project, { aspect: width / height, pace });
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.time = 0;
    this.encoderConfig = record ? encoder : null;
    this.record = record && (!!encoder || !!pickMime());
    this.chunks = [];
    this.frameNo = 0;
    this.opened = new Set();
  }

  get ok() { return !!this.plan; }

  start() {
    const v = this.view;
    // 保存目前狀態，結束後還原
    this.saved = {
      mode: v.mode, fov: v.camera.fov, pos: v.camera.position.clone(), quat: v.camera.quaternion.clone(),
      target: v.controls.target.clone(), controls: v.controls.enabled, pr: v.renderer.getPixelRatio(),
      doors: new Map([...(v.doorState || new Map())].map(([k, s]) => [k, { ...s }])),
    };
    v.live.cancel?.();
    v.mode = 'tour';
    v.controls.enabled = false;
    v.selectionBox.visible = false;
    v.needsSync = true;
    v.renderer.setPixelRatio(1);
    v.renderer.setSize(this.W, this.H, false);
    v.camera.aspect = this.W / this.H;
    v.tour = this;
    if (this.encoderConfig) {
      this.mime = 'video/mp4';
      this.mux = new Mp4Muxer({ width: this.W, height: this.H, fps: FPS });
      this.enc = new VideoEncoder({
        output: (chunk, meta) => this.mux.add(chunk, meta),
        error: (e) => { this.error = e; this.stop(false); },
      });
      this.enc.configure(this.encoderConfig);
    } else if (this.record) {
      this.mime = pickMime();
      const stream = this.canvas.captureStream(FPS);
      const bits = Math.round(this.W * this.H * FPS * 0.17);
      this.rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: bits });
      this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
      this.rec.onstop = () => this._finish();
      this.rec.start(500);
    }
    this._onVis = () => {
      if (!this.rec || this.rec.state === 'inactive') return;
      if (document.hidden) this.rec.pause(); else this.rec.resume();
    };
    document.addEventListener('visibilitychange', this._onVis);
  }

  // 由 3D 檢視的動畫迴圈每個畫面呼叫
  frame(dt) {
    const v = this.view;
    if (this.stopped) return;
    if (this.enc) {
      // 逐格編碼：編碼器忙不過來時先等一下
      if (this.enc.encodeQueueSize > 3) return;
      dt = 1 / FPS;
      this.time = this.frameNo / FPS;
    } else {
      // 即時錄影：每個畫面最多推進 0.1 秒，電腦較慢時寧可放慢，也不要跳格
      dt = Math.min(dt, 0.1);
      this.time += dt;
    }
    const { shots, duration } = this.plan;
    const t = Math.min(this.time, duration);
    let i = shots.findIndex((s) => t < s.t0 + s.dur);
    if (i < 0) i = shots.length - 1;
    const s = shots[i];
    const u = Math.min(1, (t - s.t0) / s.dur);
    // 走向門口前先把門打開（前一段運鏡快結束時就開始開下一段的第一扇門）
    if (this.openDoors) {
      const want = [];
      if (s.kind === 'walk') for (const d of s.doors) if (u >= d.u) want.push(d.id);
      const nxt = shots[i + 1];
      if (nxt?.kind === 'walk' && nxt.doors[0]?.u === 0 && s.t0 + s.dur - t < 1.2) want.push(nxt.doors[0].id);
      for (const id of want) {
        if (this.opened.has(id)) continue;
        this.opened.add(id);
        const st = v.doorState?.get(id);
        if (v.doors?.has(id) && !(st && st.target)) v.toggleDoor(id);
      }
    }
    if (v.needsSync) { v.needsSync = false; v.sync(); }
    v.animateDoors(dt);
    // 直式畫面左右較窄，室內鏡頭用較廣的視角
    const baseFov = this.W < this.H ? 84 : this.W === this.H ? 74 : 68;
    const fov = typeof s.fov === 'function' ? s.fov(u, baseFov) : s.fov || baseFov * (s.fovMul || 1);
    if (Math.abs(v.camera.fov - fov) > 1e-4 || v.camera.aspect !== this.W / this.H) { v.camera.fov = fov; v.camera.aspect = this.W / this.H; v.camera.updateProjectionMatrix(); }
    const p = s.pos(u), l = s.look(u);
    v.camera.position.copy(p);
    v.camera.lookAt(l);
    v.camera.updateMatrixWorld();
    v.renderer.render(v.scene, v.camera);
    this.compose(s, u, t);
    if (this.enc) {
      const vf = new VideoFrame(this.canvas, { timestamp: Math.round((this.frameNo * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      this.enc.encode(vf, { keyFrame: this.frameNo % (FPS * 2) === 0 });
      vf.close();
      this.frameNo++;
    }
    // 2D 平面圖同步顯示目前位置
    if (s.kind !== 'aerial') {
      const d = l.clone().sub(p);
      v.app.onVisitor?.({ x: p.x / S, y: p.z / S, yaw: -Math.atan2(-d.x, -d.z) });
    } else v.app.onVisitor?.(null);
    this.onProgress?.(t / duration, s, t, duration);
    if (this.time >= duration + (this.enc ? 0 : 0.4)) this.stop(true);
  }

  compose(s, u, t) {
    const { ctx, W, H } = this;
    ctx.drawImage(this.view.canvas, 0, 0, W, H);
    // 淡入淡出（黑場）
    const FADE = 0.45;
    let fade = 0;
    const tin = t - s.t0, tout = s.t0 + s.dur - t;
    if (s.fadeIn && tin < FADE) fade = Math.max(fade, 1 - tin / FADE);
    if (s.fadeOut && tout < FADE) fade = Math.max(fade, 1 - tout / FADE);
    if (s.t0 === 0 && tin < 0.6) fade = Math.max(fade, 1 - tin / 0.6);
    const unit = Math.min(W, H) / 720;
    if (this.captions && s.caption) {
      // 字幕：開頭 0.5 秒淡入、結尾 0.5 秒淡出
      const a = Math.min(1, tin / 0.5, Math.max(0, (tout - 0.2) / 0.5));
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 14 * unit;
      const font = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
      if (s.title) {
        // 片頭、片尾：畫面中央大標題
        const g = ctx.createLinearGradient(0, H * 0.3, 0, H * 0.7);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,.28)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save(); ctx.shadowBlur = 0; ctx.fillStyle = g; ctx.fillRect(0, H * 0.3, W, H * 0.4); ctx.restore();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `700 ${Math.round(52 * unit)}px ${font}`;
        ctx.fillText(s.caption, W / 2, H / 2 - 20 * unit, W * 0.9);
        ctx.font = `400 ${Math.round(24 * unit)}px ${font}`;
        ctx.fillText(s.sub || '', W / 2, H / 2 + 34 * unit, W * 0.9);
      } else {
        // 左下角：房間名稱與坪數；特寫時為描述文字。過長的文字自動換行
        const x = 44 * unit, maxW = W - x * 2;
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        const big = s.kind === 'detail' ? 32 : 40;
        ctx.font = `700 ${Math.round(big * unit)}px ${font}`;
        const head = wrapLines(ctx, s.caption, maxW, s.kind === 'detail' ? 3 : 1);
        ctx.font = `400 ${Math.round(22 * unit)}px ${font}`;
        const tail = [s.sub || '', ...(s.note ? wrapLines(ctx, s.note, maxW, 2) : [])].filter(Boolean);
        const lh = big * 1.25 * unit, sh = 22 * 1.45 * unit;
        let y = H - 40 * unit - tail.length * sh - (head.length - 1) * lh;
        ctx.shadowBlur = 0;
        ctx.fillRect(x, y - big * unit - 16 * unit, 46 * unit, 4 * unit);
        ctx.shadowBlur = 14 * unit;
        ctx.font = `700 ${Math.round(big * unit)}px ${font}`;
        for (const line of head) { ctx.fillText(line, x, y); y += lh; }
        y += sh - lh + 6 * unit;
        ctx.font = `400 ${Math.round(22 * unit)}px ${font}`;
        for (const line of tail) { ctx.fillText(line, x, y); y += sh; }
      }
      ctx.restore();
    }
    if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${Math.min(1, fade)})`; ctx.fillRect(0, 0, W, H); }
  }

  stop(done = false) {
    if (this.stopped) return;
    this.stopped = true;
    this.completed = done;
    document.removeEventListener('visibilitychange', this._onVis);
    this.restore();
    if (this.enc) {
      const enc = this.enc;
      const end = () => { try { enc.close(); } catch { /* 已關閉 */ } this._finish(); };
      if (done && !this.error) enc.flush().then(end, (e) => { this.error = e; end(); });
      else end();
    } else if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    else this._finish();
  }

  restore() {
    const v = this.view, s = this.saved;
    v.tour = null;
    v.mode = s.mode;
    v.controls.enabled = s.controls;
    v.camera.fov = s.fov;
    v.camera.position.copy(s.pos);
    v.camera.quaternion.copy(s.quat);
    v.controls.target.copy(s.target);
    v.renderer.setPixelRatio(s.pr);
    v.resize();
    v.camera.updateProjectionMatrix();
    // 門恢復成錄影前的開關狀態
    for (const id of this.opened) {
      const before = s.doors.get(id);
      const st = v.doorState?.get(id);
      if (st) { st.p = st.target = before ? before.target : 0; v.poseDoor(id); }
    }
    v.needsSync = true;
    v.updateSelection();
    v.app.onVisitor?.(null);
    v.live.activity?.(true);
  }

  _finish() {
    let blob = null;
    if (this.mux) blob = this.completed && !this.error ? this.mux.finish() : null;
    else if (this.chunks.length) blob = new Blob(this.chunks, { type: this.mime.split(';')[0] });
    this.onDone?.({ blob, mime: this.mime, completed: this.completed && !this.error, error: this.error, duration: this.plan.duration });
  }
}
