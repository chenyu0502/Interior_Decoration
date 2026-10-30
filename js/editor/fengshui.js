// 風水檢查：依台灣常見的居家風水說法，從平面圖的牆、門窗、房間與家具位置找出可能的問題，
// 並提供化解建議。屬於傳統習俗參考，判斷方式以平面圖的幾何關係為準。
import { store } from '../core/state.js';
import { wallFrame, pointInPolygon, polygonArea, polygonBBox } from '../core/geometry.js';
import { openingCenter, roomAt, nearestWall } from '../core/model.js';
import { OPENING_MAP, CATALOG_MAP } from '../data/catalog.js';
import { analyzeRooms } from '../ai/designer.js';

const BEDS = new Set(['bed_double', 'bed_queen', 'bed_single']);
const SOFAS = new Set(['sofa3', 'sofa2', 'sofa_curve', 'sofa_l']);
const MIRRORS = new Set(['mirror', 'dresser']);
const SCORE = { warn: 10, tip: 4 };

const rad = (d) => ((d || 0) * Math.PI) / 180;
// 家具正面方向（平面座標，y 向下）
const frontOf = (it) => [-Math.sin(rad(it.rot)), Math.cos(rad(it.rot))];
const sideOf = (it) => [Math.cos(rad(it.rot)), Math.sin(rad(it.rot))];
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k];

// 門窗在平面上的線段與資訊
export function openingInfo(P) {
  const out = [];
  for (const op of P.openings) {
    const def = OPENING_MAP[op.kind];
    const w = P.walls.find((x) => x.id === op.wallId);
    if (!def || !w) continue;
    const c = openingCenter(op, w), f = wallFrame(w);
    const half = (op.width || def.width) / 2;
    const off = (w.thickness || 12) / 2 + 30;
    const sideA = roomAt(P.rooms, c.x + f.nx * off, c.y + f.ny * off);
    const sideB = roomAt(P.rooms, c.x - f.nx * off, c.y - f.ny * off);
    out.push({
      op, def, wall: w, c: [c.x, c.y], n: [f.nx, f.ny], u: [f.ux, f.uy], half,
      a: [c.x - f.ux * half, c.y - f.uy * half], b: [c.x + f.ux * half, c.y + f.uy * half],
      door: def.cat === 'door', window: def.cat === 'window', entry: !!def.entry,
      rooms: [sideA, sideB], exterior: !sideA || !sideB,
    });
  }
  return out;
}

// 線段交點：p + d·t 與 a→b，回傳 t（0 到 maxT）或 null
function hitSegment(p, d, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const den = d[0] * ey - d[1] * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
  const s = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den;
  return t > 1 && s >= 0 && s <= 1 ? t : null;
}

// 從 p 沿 d 方向看出去：依序穿過門洞與窗戶，遇到實牆停止。回傳經過的門窗與停止距離
function sight(P, ops, p, d, maxT = 3000) {
  const hits = [];
  for (const w of P.walls) {
    const t = hitSegment(p, d, [w.x1, w.y1], [w.x2, w.y2]);
    if (t === null || t > maxT) continue;
    const q = add(p, d, t);
    const o = ops.find((x) => x.wall.id === w.id && Math.hypot(q[0] - x.c[0], q[1] - x.c[1]) <= x.half + 1);
    hits.push({ t, q, o });
  }
  hits.sort((x, y) => x.t - y.t);
  const passed = [];
  for (const h of hits) {
    if (!h.o) return { passed, stop: h.t, end: h.q };
    passed.push(h);
  }
  return { passed, stop: maxT, end: add(p, d, maxT) };
}

// 點是否落在家具的矩形範圍內
function inItem(it, q, pad = 0) {
  const r = -rad(it.rot), dx = q[0] - it.x, dy = q[1] - it.y;
  const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(lx) <= it.w / 2 + pad && Math.abs(ly) <= it.d / 2 + pad;
}

// 家具背面是否靠牆；回傳靠的牆或 null
function backWall(P, it) {
  const f = frontOf(it);
  const back = add([it.x, it.y], f, -it.d / 2);
  const nw = nearestWall(P.walls, back[0], back[1], 60);
  if (!nw || nw.d > (nw.wall.thickness || 12) / 2 + 18) return null;
  // 牆的方向要與家具背面平行
  const wf = wallFrame(nw.wall);
  return Math.abs(wf.ux * f[0] + wf.uy * f[1]) < 0.3 ? nw : null;
}

export function checkFengshui(P = store.project) {
  const ops = openingInfo(P);
  const types = new Map(analyzeRooms(P).map((a) => [a.room.id, a.type]));
  const typeOf = (r) => (r ? types.get(r.id) || r.type : null);
  const isBath = (r) => !!r && (typeOf(r) === 'bathroom' || /浴|廁|衛/.test(r.name));
  const isKitchen = (r) => !!r && (typeOf(r) === 'kitchen' || /廚/.test(r.name));
  const roomName = (r) => (r ? r.name : '室外');
  const found = [];
  const push = (f) => found.push({ id: `${f.rule}:${found.length}`, ...f });

  // ---- 大門：穿堂煞、開門見廁、開門見灶、大門對鏡
  for (const e of ops.filter((o) => o.entry)) {
    const inside = e.rooms[0] ? 1 : -1;
    const d = [e.n[0] * inside, e.n[1] * inside];
    const starts = [-0.6, 0, 0.6].map((k) => add(add(e.c, e.u, e.half * k), d, 2));
    let through = null, toBath = null, toKitchen = null;
    for (const s of starts) {
      const v = sight(P, ops, s, d);
      const ext = v.passed.find((h) => h.o !== e && h.o.exterior && (h.o.window || h.o.door) && (h.o.op.sill ?? h.o.def.sill ?? 0) < 120);
      if (ext && !through) through = { s, h: ext };
      const firstDoor = v.passed.find((h) => h.o !== e && h.o.door);
      if (firstDoor && !toBath && firstDoor.o.rooms.some(isBath)) toBath = { s, h: firstDoor };
      if (firstDoor && !toKitchen && firstDoor.o.rooms.some(isKitchen)) toKitchen = { s, h: firstDoor };
    }
    if (through) {
      push({
        rule: 'through', level: 'warn', title: '穿堂煞：大門直通落地窗或後門',
        detail: `從大門直線看出去會穿過室內直達${through.h.o.def.name}，傳統說法認為氣直進直出、聚不住財氣，也缺少隱私。`,
        fix: '在大門內側設玄關櫃或屏風，或在窗前加窗簾、擺放大型盆栽遮擋直線視線。',
        lines: [[through.s, through.h.q]], ops: [e.op.id, through.h.o.op.id],
      });
    }
    if (toBath) {
      push({
        rule: 'entry-bath', level: 'warn', title: '開門見廁：大門正對廁所門',
        detail: '一進門就看到廁所門，傳統說法認為穢氣直衝大門，也不美觀。',
        fix: '廁所門保持關閉並掛門簾，或在兩門之間設屏風、玄關櫃。',
        lines: [[toBath.s, toBath.h.q]], ops: [e.op.id, toBath.h.o.op.id],
      });
    }
    if (toKitchen) {
      push({
        rule: 'entry-kitchen', level: 'tip', title: '開門見灶：大門正對廚房',
        detail: '一進門就看到廚房，傳統說法認為容易漏財，油煙也容易飄到玄關。',
        fix: '廚房加裝拉門或門簾，或以玄關櫃、屏風遮擋。',
        lines: [[toKitchen.s, toKitchen.h.q]], ops: [e.op.id, toKitchen.h.o.op.id],
      });
    }
    for (const it of P.items.filter((x) => MIRRORS.has(x.kind) && x.kind === 'mirror')) {
      const v = sight(P, ops, [it.x, it.y], frontOf(it));
      if (v.passed.some((h) => h.o === e)) {
        push({
          rule: 'mirror-entry', level: 'tip', title: '鏡子正對大門',
          detail: `${it.name || '鏡子'}正對大門，傳統說法認為會把進門的好運反射出去。`,
          fix: '把鏡子移到大門側邊的牆上，或改用鞋櫃門內側的鏡子。',
          lines: [[[it.x, it.y], e.c]], items: [it.id], ops: [e.op.id],
        });
      }
    }
  }

  // ---- 門對門
  const doors = ops.filter((o) => o.door && o.def.type !== 'opening');
  for (let i = 0; i < doors.length; i++) {
    for (let j = i + 1; j < doors.length; j++) {
      const A = doors[i], B = doors[j];
      if (Math.abs(A.n[0] * B.n[0] + A.n[1] * B.n[1]) < 0.95) continue; // 兩扇門要互相平行
      const dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1];
      const along = Math.abs(dx * A.n[0] + dy * A.n[1]);
      const lateral = Math.abs(dx * A.u[0] + dy * A.u[1]);
      if (along < 40 || along > 320 || lateral > Math.min(A.half, B.half)) continue;
      const v = sight(P, ops, add(A.c, A.n, Math.sign(dx * A.n[0] + dy * A.n[1])), [A.n[0] * Math.sign(dx * A.n[0] + dy * A.n[1]), A.n[1] * Math.sign(dx * A.n[0] + dy * A.n[1])], along + 5);
      if (!v.passed.some((h) => h.o === B)) continue;
      const bath = [A, B].some((o) => o.rooms.some(isBath));
      const entry = A.entry || B.entry;
      if (entry && bath) continue; // 已在「開門見廁」提醒
      const names = [A, B].map((o) => roomName(o.rooms.find((r) => r && !isHallLike(r, typeOf)) || o.rooms[0] || o.rooms[1]));
      push({
        rule: 'door-door', level: bath ? 'warn' : 'tip',
        title: bath ? '房門正對廁所門' : entry ? '大門正對房門' : '門對門',
        detail: `${names[0]}與${names[1]}的門正對，傳統說法稱為「門沖」，容易口角不合${bath ? '，廁所的濕氣與穢氣也會直衝房內' : ''}。`,
        fix: bath ? '廁所門保持關閉並掛門簾，房門可加門簾。' : '其中一扇門掛門簾，或平常保持關閉。',
        lines: [[A.c, B.c]], ops: [A.op.id, B.op.id],
      });
    }
  }

  // ---- 床位
  for (const it of P.items.filter((x) => BEDS.has(x.kind))) {
    const room = roomAt(P.rooms, it.x, it.y);
    const f = frontOf(it), sd = sideOf(it);
    const head = add([it.x, it.y], f, -it.d / 2);
    const bw = backWall(P, it);
    const label = `${roomName(room)}的床`;
    if (!bw) {
      push({
        rule: 'bed-nowall', level: 'warn', title: '床頭無靠',
        detail: `${label}床頭沒有靠牆，傳統說法認為缺乏靠山，睡眠也較沒有安全感。`,
        fix: '把床頭移到實牆邊；空間不允許時，床頭後方加床頭櫃或高背床頭板。',
        items: [it.id], lines: [[[it.x, it.y], head]],
      });
    } else {
      // 床頭靠窗
      const wid = bw.wall.id;
      const win = ops.find((o) => o.window && o.wall.id === wid && Math.abs((o.c[0] - head[0]) * sd[0] + (o.c[1] - head[1]) * sd[1]) < it.w / 2 + o.half - 10);
      if (win) {
        push({
          rule: 'bed-window', level: 'warn', title: '床頭靠窗',
          detail: `${label}床頭正好在${win.def.name}下方，傳統說法認為床頭無靠；實際上也容易受風、光線與噪音影響睡眠。`,
          fix: '把床頭移到沒有窗的牆；無法移動時，加厚遮光窗簾並用高床頭板。',
          items: [it.id], ops: [win.op.id],
        });
      }
      // 床頭靠廁所牆
      const beyond = add(head, f, -((bw.wall.thickness || 12) + 40));
      const other = roomAt(P.rooms, beyond[0], beyond[1]);
      if (other && other !== room && isBath(other)) {
        push({
          rule: 'bed-bath', level: 'tip', title: '床頭靠廁所牆',
          detail: `${label}床頭的牆後面是${other.name}，傳統說法認為不利健康；實際上也可能聽到排水聲。`,
          fix: '床頭換到其他牆；或在床頭牆加做隔音板、櫃體。',
          items: [it.id], lines: [[head, beyond]],
        });
      }
    }
    // 床尾對門
    for (const k of [-0.3, 0, 0.3]) {
      const s = add(add([it.x, it.y], sd, it.w * k), f, it.d / 2);
      const v = sight(P, ops, s, f, 800);
      const dh = v.passed[0];
      if (dh && dh.o.door && dh.o.rooms.includes(room)) {
        push({
          rule: 'bed-door', level: 'warn', title: '床尾正對房門',
          detail: `${label}床尾正對${dh.o.def.name}，傳統說法稱為「門沖床」，也較沒有隱私。`,
          fix: '床的方向轉 90 度避開門口，或在床尾與門之間加屏風、衣櫃。',
          items: [it.id], ops: [dh.o.op.id], lines: [[s, dh.q]],
        });
        break;
      }
    }
    // 鏡子照床（化妝台、鏡子）
    for (const m of P.items.filter((x) => MIRRORS.has(x.kind) && roomAt(P.rooms, x.x, x.y) === room)) {
      const mf = frontOf(m);
      const s = add([m.x, m.y], mf, m.d / 2);
      const v = sight(P, ops, s, mf, 700);
      let hitAt = null;
      for (let t = 10; t < v.stop; t += 10) { const q = add(s, mf, t); if (inItem(it, q, -5)) { hitAt = q; break; } }
      if (hitAt) {
        push({
          rule: 'mirror-bed', level: 'warn', title: '鏡子正對床',
          detail: `${m.name || '鏡子'}的鏡面正對${label}，傳統說法認為容易心神不寧、睡不安穩。`,
          fix: '化妝台轉向或移到側邊；或使用可收起、加蓋的鏡子。',
          items: [m.id, it.id], lines: [[s, hitAt]],
        });
      }
    }
  }

  // ---- 沙發
  for (const it of P.items.filter((x) => SOFAS.has(x.kind))) {
    const f = frontOf(it);
    if (!backWall(P, it)) {
      const v = sight(P, ops, [it.x, it.y], [-f[0], -f[1]], 1500);
      const toEntry = v.passed.find((h) => h.o.entry || (h.o.door && h.o.exterior));
      push({
        rule: 'sofa-nowall', level: toEntry ? 'warn' : 'tip', title: toEntry ? '沙發背對大門' : '沙發背後無靠',
        detail: toEntry ? `${it.name || '沙發'}背後正對大門，坐著時看不到進出的人，傳統說法認為缺乏靠山。` : `${it.name || '沙發'}背後沒有靠牆，傳統說法認為缺乏靠山。`,
        fix: '沙發背面靠實牆；無法靠牆時，在沙發後方擺矮櫃、邊桌或大型盆栽當作靠山。',
        items: [it.id], ...(toEntry ? { lines: [[[it.x, it.y], toEntry.q]], ops: [toEntry.o.op.id] } : {}),
      });
    }
  }

  // ---- 書桌：坐著時背對房門
  for (const it of P.items.filter((x) => x.kind === 'desk')) {
    const room = roomAt(P.rooms, it.x, it.y);
    const f = frontOf(it);
    const seat = add([it.x, it.y], f, it.d / 2 + 45);
    const v = sight(P, ops, seat, f, 800);
    const dh = v.passed[0];
    if (dh && dh.o.door && dh.o.rooms.includes(room)) {
      push({
        rule: 'desk-door', level: 'tip', title: '書桌背對房門',
        detail: `${roomName(room)}的書桌坐著時背對房門，傳統說法認為容易被打擾、難以專心。`,
        fix: '書桌轉向，讓座位面向或側對房門；無法調整時，在桌面放一面小鏡子看得到門口。',
        items: [it.id], ops: [dh.o.op.id], lines: [[seat, dh.q]],
      });
    }
  }

  // ---- 廁所居中、房間缺角
  const all = P.rooms.filter((r) => r.points.length >= 3);
  if (all.length >= 3) {
    let A = 0, cx = 0, cy = 0;
    for (const r of all) {
      const bb = polygonBBox(r.points), a = Math.abs(polygonArea(r.points));
      A += a; cx += ((bb.x0 + bb.x1) / 2) * a; cy += ((bb.y0 + bb.y1) / 2) * a;
    }
    cx /= A; cy /= A;
    const mid = all.find((r) => isBath(r) && pointInPolygon(cx, cy, r.points));
    if (mid) {
      push({
        rule: 'bath-center', level: 'warn', title: '廁所位於房子中心',
        detail: `${mid.name}在整間房子的中心位置，傳統說法稱為「中宮污穢」；實際上也容易通風不良、濕氣重。`,
        fix: '加強抽風與除濕，保持乾淨並常關門；可在門口放植栽。',
        rooms: [mid.id], lines: [[[cx - 40, cy], [cx + 40, cy]], [[cx, cy - 40], [cx, cy + 40]]],
      });
    }
  }
  for (const r of all) {
    if (r.points.length <= 4 || isHallLike(r, typeOf)) continue;
    const bb = polygonBBox(r.points);
    const ratio = Math.abs(polygonArea(r.points)) / ((bb.x1 - bb.x0) * (bb.y1 - bb.y0));
    if (ratio < 0.85) {
      push({
        rule: 'room-corner', level: 'tip', title: `${r.name}格局不方正（缺角）`,
        detail: `${r.name}的形狀約缺了 ${Math.round((1 - ratio) * 100)}%，傳統說法認為缺角的方位會影響運勢；實際上也較難擺放家具。`,
        fix: '用櫃體、收納或層架把缺角補成方正的使用空間。',
        rooms: [r.id],
      });
    }
  }

  const score = Math.max(0, 100 - found.reduce((s, f) => s + SCORE[f.level], 0));
  return { findings: found, score, checked: CHECKS };
}

function isHallLike(r, typeOf) {
  return ['hall', 'entry', 'balcony'].includes(typeOf(r)) || /走道|走廊|玄關|陽台/.test(r.name);
}

// 檢查項目（顯示在面板上，讓使用者知道檢查了哪些）
export const CHECKS = ['穿堂煞', '開門見廁', '開門見灶', '鏡子對大門', '門對門', '床頭無靠', '床頭靠窗', '床頭靠廁所', '床尾對門', '鏡子照床', '沙發背後無靠', '書桌背門', '廁所居中', '房間缺角'];
