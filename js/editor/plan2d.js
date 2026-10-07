// 2D 平面圖編輯器
import { store } from '../core/state.js';
import {
  dist, snap, clamp, deg2rad, rad2deg, normDeg, toLocal, rectCorners, projectToSegment,
  polygonCentroid, polygonArea, pointInPolygon, wallFrame, toWallLocal, wallLength, detectRooms, areaText,
} from '../core/geometry.js';
import { wallJoins, wallPolygon, openingCenter, nearestWall, projectBounds, roomAt } from '../core/model.js';
import { CATALOG_MAP, OPENING_MAP } from '../data/catalog.js';
import { materialCanvas, getMaterial } from '../data/materials.js';
import { paletteFor } from '../data/styles.js';

const HANDLE = 7; // 螢幕像素

export class Plan2D {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.view = { scale: 0.6, ox: 80, oy: 80 };
    this.tool = 'select';
    this.placeKind = null;
    this.drag = null;
    this.draft = null; // 畫牆/多邊形中的暫存
    this.mouse = { x: 0, y: 0, wx: 0, wy: 0, inside: false };
    this.visitor = null;
    this.bgImage = null;
    this.patterns = new Map();
    this.dirty = true;
    this.spaceDown = false;
    this._bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    store.on('change', () => this.invalidate());
    store.on('select', () => this.invalidate());
    const loop = () => { if (this.dirty) { this.dirty = false; this.render(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  invalidate() { this.dirty = true; }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.dpr = dpr;
    this.invalidate();
  }

  // ---- 座標轉換
  toWorld(sx, sy) { return { x: (sx - this.view.ox) / this.view.scale, y: (sy - this.view.oy) / this.view.scale }; }
  toScreen(x, y) { return { x: x * this.view.scale + this.view.ox, y: y * this.view.scale + this.view.oy }; }
  px(n) { return n / this.view.scale; } // 螢幕像素 → 公分

  fit() {
    const b = projectBounds(store.project);
    const r = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(200, b.x1 - b.x0), h = Math.max(200, b.y1 - b.y0);
    const s = Math.min((r.width - 80) / w, (r.height - 80) / h);
    this.view.scale = clamp(s, 0.05, 6);
    this.view.ox = r.width / 2 - ((b.x0 + b.x1) / 2) * this.view.scale;
    this.view.oy = r.height / 2 - ((b.y0 + b.y1) / 2) * this.view.scale;
    this.invalidate();
  }

  zoomBy(f, sx, sy) {
    const r = this.canvas.getBoundingClientRect();
    if (sx === undefined) { sx = r.width / 2; sy = r.height / 2; }
    const w = this.toWorld(sx, sy);
    this.view.scale = clamp(this.view.scale * f, 0.03, 8);
    this.view.ox = sx - w.x * this.view.scale;
    this.view.oy = sy - w.y * this.view.scale;
    this.invalidate();
  }

  setTool(t, kind = null) {
    this.tool = t;
    this.placeKind = kind;
    this.draft = null;
    this.canvas.style.cursor = t === 'select' ? 'default' : t === 'pan' ? 'grab' : 'crosshair';
    this.app.onToolChanged?.(t);
    this.invalidate();
  }

  // ---- 吸附
  snapPoint(x, y, { from = null, free = false } = {}) {
    const s = store.project.settings;
    const tol = this.px(12);
    // 牆端點
    let best = null;
    for (const w of store.project.walls) {
      for (const [px, py] of [[w.x1, w.y1], [w.x2, w.y2]]) {
        const d = dist(x, y, px, py);
        if (d < tol && (!best || d < best.d)) best = { x: px, y: py, d };
      }
    }
    if (best) return { x: best.x, y: best.y, snapped: 'end' };
    if (from && !free) {
      const ang = rad2deg(Math.atan2(y - from.y, x - from.x));
      const a15 = Math.round(ang / 15) * 15;
      if (Math.abs(ang - a15) < 6) {
        const L = dist(from.x, from.y, x, y);
        const Ls = s.snap ? snap(L, 5) : L;
        return { x: from.x + Math.cos(deg2rad(a15)) * Ls, y: from.y + Math.sin(deg2rad(a15)) * Ls, snapped: 'angle' };
      }
    }
    // 牆線上
    for (const w of store.project.walls) {
      const pr = projectToSegment(x, y, w.x1, w.y1, w.x2, w.y2);
      if (pr.d < tol * 0.7) return { x: pr.x, y: pr.y, snapped: 'wall' };
    }
    if (s.snap && !free) return { x: snap(x, 5), y: snap(y, 5), snapped: 'grid' };
    return { x, y };
  }

  // ---- 事件
  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointerleave', () => { this.mouse.inside = false; this.invalidate(); });
    c.addEventListener('dblclick', (e) => this._dbl(e));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this._finishDraft(); });
    // 從目錄拖放
    c.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const w = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      const kind = e.dataTransfer.getData('application/x-catalog');
      const matId = e.dataTransfer.getData('application/x-material');
      if (kind) this.app.placeCatalog(kind, w.x, w.y);
      if (matId) this.app.applyMaterialAt(matId, w.x, w.y);
    });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
    // 觸控雙指縮放
    this.touches = new Map();
  }

  _evt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = this.toWorld(sx, sy);
    return { sx, sy, x: w.x, y: w.y };
  }

  _down(e) {
    const p = this._evt(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, p);
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.drag = { type: 'pinch', d0: dist(a.sx, a.sy, b.sx, b.sy), s0: this.view.scale, cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2, ox: this.view.ox, oy: this.view.oy };
        return;
      }
    }
    if (e.button === 1 || e.button === 2 && this.tool === 'select' || this.tool === 'pan' || this.spaceDown) {
      this.drag = { type: 'pan', sx: p.sx, sy: p.sy, ox: this.view.ox, oy: this.view.oy };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    const t = this.tool;
    if (t === 'select') return this._downSelect(p, e);
    if (t === 'wall') {
      const sp = this.snapPoint(p.x, p.y, { from: this.draft?.points.at(-1), free: e.shiftKey });
      if (!this.draft) { this.draft = { type: 'wall', points: [sp] }; return; }
      const last = this.draft.points.at(-1);
      if (dist(last.x, last.y, sp.x, sp.y) < 2) return;
      store.commit((pr) => { store.addWall(last.x, last.y, sp.x, sp.y); void pr; }, 'wall');
      // 點回起點即封閉
      if (dist(sp.x, sp.y, this.draft.points[0].x, this.draft.points[0].y) < 2) { this.draft = null; return; }
      this.draft.points.push(sp);
      return;
    }
    if (t === 'room') {
      const sp = this.snapPoint(p.x, p.y);
      this.drag = { type: 'roomRect', x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y, sx: p.sx, sy: p.sy };
      return;
    }
    if (t === 'polygon') {
      const sp = this.snapPoint(p.x, p.y, { from: this.draft?.points.at(-1), free: e.shiftKey });
      if (!this.draft) { this.draft = { type: 'polygon', points: [sp] }; return; }
      const first = this.draft.points[0];
      if (this.draft.points.length >= 3 && dist(first.x, first.y, sp.x, sp.y) < this.px(10)) { this._finishDraft(); return; }
      this.draft.points.push(sp);
      return;
    }
    if (t === 'dim') {
      const sp = this.snapPoint(p.x, p.y, { free: e.shiftKey });
      this.drag = { type: 'dim', x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y };
      return;
    }
    if (t === 'calibrate') {
      if (!this.draft) { this.draft = { type: 'calibrate', points: [{ x: p.x, y: p.y }] }; return; }
      const a = this.draft.points[0];
      const px = dist(a.x, a.y, p.x, p.y);
      this.draft = null;
      this.setTool('select');
      this.app.finishCalibration(px);
      return;
    }
    if (t === 'place' && this.placeKind) {
      this.app.placeCatalog(this.placeKind, p.x, p.y);
      if (!e.shiftKey) this.setTool('select');
    }
  }

  _downSelect(p, e) {
    const sel = store.selection;
    const obj = store.selected();
    // 先檢查目前選取物件的控制點
    if (sel && obj) {
      const h = this._hitHandle(sel, obj, p);
      if (h) { this.drag = { ...h, started: false, sx: p.sx, sy: p.sy }; return; }
    }
    // 背景圖拖曳
    const hit = this.hitTest(p.x, p.y);
    if (hit) {
      store.select(hit);
      const o = store.find(hit.type, hit.id);
      this.drag = { type: 'move', target: hit, started: false, sx: p.sx, sy: p.sy, wx: p.x, wy: p.y, orig: JSON.parse(JSON.stringify(o)), alt: e.altKey };
      if (hit.type === 'wall') this.drag.linked = this._linkedEnds(o);
    } else {
      store.select(null);
      this.drag = { type: 'pan', sx: p.sx, sy: p.sy, ox: this.view.ox, oy: this.view.oy };
    }
  }

  _linkedEnds(w) {
    // 與此牆端點重疊的其他牆端點
    const res = [];
    for (const o of store.project.walls) {
      if (o.id === w.id) continue;
      for (const [k, kx, ky] of [['1', 'x1', 'y1'], ['2', 'x2', 'y2']]) {
        for (const [mine, mx, my] of [['1', w.x1, w.y1], ['2', w.x2, w.y2]]) {
          if (dist(o[kx], o[ky], mx, my) < 2) res.push({ id: o.id, end: k, mine, ox: o[kx], oy: o[ky] });
        }
      }
    }
    return res;
  }

  _hitHandle(sel, obj, p) {
    const tol = this.px(HANDLE + 3);
    if (sel.type === 'item') {
      const it = obj;
      const L = toLocal(it.x, it.y, it.rot, p.x, p.y);
      const rotY = -it.d / 2 - this.px(26);
      if (dist(L.x, L.y, 0, rotY) < tol) return { type: 'rotate', id: it.id, orig: { ...it } };
      if (dist(L.x, L.y, it.w / 2, it.d / 2) < tol) return { type: 'resize', id: it.id, orig: { ...it } };
    }
    if (sel.type === 'wall') {
      const w = obj;
      for (const [end, x, y] of [['1', w.x1, w.y1], ['2', w.x2, w.y2]]) {
        if (dist(p.x, p.y, x, y) < tol) return { type: 'wallEnd', id: w.id, end, linked: this._linkedEnds(w).filter((l) => l.mine === end) };
      }
    }
    if (sel.type === 'room') {
      const pts = obj.points;
      for (let i = 0; i < pts.length; i++) if (dist(p.x, p.y, pts[i][0], pts[i][1]) < tol) return { type: 'roomPt', id: obj.id, index: i };
    }
    if (sel.type === 'dim') {
      for (const [end, x, y] of [['1', obj.x1, obj.y1], ['2', obj.x2, obj.y2]]) if (dist(p.x, p.y, x, y) < tol) return { type: 'dimEnd', id: obj.id, end };
    }
    return null;
  }

  _move(e) {
    const p = this._evt(e);
    this.mouse = { ...p, wx: p.x, wy: p.y, inside: true, shift: e.shiftKey };
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, p);
      if (this.drag?.type === 'pinch' && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = dist(a.sx, a.sy, b.sx, b.sy);
        const s = clamp(this.drag.s0 * (d / this.drag.d0), 0.03, 8);
        const cx = (a.sx + b.sx) / 2, cy = (a.sy + b.sy) / 2;
        const wx = (this.drag.cx - this.drag.ox) / this.drag.s0, wy = (this.drag.cy - this.drag.oy) / this.drag.s0;
        this.view.scale = s; this.view.ox = cx - wx * s; this.view.oy = cy - wy * s;
        this.invalidate();
        return;
      }
    }
    const d = this.drag;
    this.app.onPlanHover?.(p.x, p.y);
    if (!d) {
      if (this.tool === 'select') {
        const sel = store.selection, obj = store.selected();
        const h = sel && obj ? this._hitHandle(sel, obj, p) : null;
        const hit = h ? null : this.hitTest(p.x, p.y);
        this.canvas.style.cursor = h ? (h.type === 'rotate' ? 'alias' : 'nwse-resize') : hit ? 'move' : 'default';
        this.hover = hit;
      }
      this.invalidate();
      return;
    }
    if (d.type === 'pan') {
      this.view.ox = d.ox + (p.sx - d.sx);
      this.view.oy = d.oy + (p.sy - d.sy);
      this.invalidate();
      return;
    }
    if (d.type === 'roomRect' || d.type === 'dim') {
      const sp = this.snapPoint(p.x, p.y, { free: e.shiftKey });
      d.x1 = sp.x; d.y1 = sp.y;
      this.invalidate();
      return;
    }
    // 需超過拖曳門檻才開始，避免單擊誤移
    if (!d.started) {
      if (dist(p.sx, p.sy, d.sx, d.sy) < 3) return;
      d.started = true;
      store.checkpoint();
    }
    const P = store.project;
    if (d.type === 'move') {
      const o = store.find(d.target.type, d.target.id);
      if (!o) return;
      let dx = p.x - d.wx, dy = p.y - d.wy;
      if (d.target.type === 'item') {
        let nx = d.orig.x + dx, ny = d.orig.y + dy;
        if (P.settings.snap) { nx = snap(nx, 1); ny = snap(ny, 1); }
        o.x = nx; o.y = ny; o.rot = d.orig.rot;
        if (!e.altKey) this._magnet(o);
      } else if (d.target.type === 'opening') {
        const near = nearestWall(P.walls, p.x, p.y, 80);
        if (near) {
          o.wallId = near.wall.id;
          const L = wallLength(near.wall);
          o.offset = clamp(P.settings.snap ? snap(near.u, 1) : near.u, o.width / 2, L - o.width / 2);
        }
      } else if (d.target.type === 'wall') {
        if (P.settings.snap) { dx = snap(dx, 5); dy = snap(dy, 5); }
        o.x1 = d.orig.x1 + dx; o.y1 = d.orig.y1 + dy; o.x2 = d.orig.x2 + dx; o.y2 = d.orig.y2 + dy;
        for (const l of d.linked) {
          const w = store.wall(l.id); if (!w) continue;
          w[`x${l.end}`] = l.ox + dx; w[`y${l.end}`] = l.oy + dy;
        }
      } else if (d.target.type === 'room') {
        if (P.settings.snap) { dx = snap(dx, 5); dy = snap(dy, 5); }
        o.points = d.orig.points.map(([x, y]) => [x + dx, y + dy]);
      } else if (d.target.type === 'dim') {
        o.x1 = d.orig.x1 + dx; o.y1 = d.orig.y1 + dy; o.x2 = d.orig.x2 + dx; o.y2 = d.orig.y2 + dy;
      }
      store.update(null, 'move');
      return;
    }
    if (d.type === 'rotate') {
      const it = store.find('item', d.id);
      let a = rad2deg(Math.atan2(p.y - it.y, p.x - it.x)) + 90;
      if (!e.shiftKey) a = Math.round(a / 15) * 15;
      it.rot = normDeg(a);
      store.update(null, 'move');
      return;
    }
    if (d.type === 'resize') {
      const it = store.find('item', d.id);
      const L = toLocal(it.x, it.y, it.rot, p.x, p.y);
      it.w = Math.max(5, Math.round(Math.abs(L.x) * 2));
      it.d = Math.max(1, Math.round(Math.abs(L.y) * 2));
      store.update(null, 'resize');
      return;
    }
    if (d.type === 'wallEnd') {
      const w = store.wall(d.id);
      const other = d.end === '1' ? { x: w.x2, y: w.y2 } : { x: w.x1, y: w.y1 };
      // 排除自己端點的吸附
      const sp = this.snapPointExcluding(p.x, p.y, w, other, e.shiftKey);
      w[`x${d.end}`] = sp.x; w[`y${d.end}`] = sp.y;
      for (const l of d.linked) { const o = store.wall(l.id); if (o) { o[`x${l.end}`] = sp.x; o[`y${l.end}`] = sp.y; } }
      store.update(null, 'move');
      return;
    }
    if (d.type === 'roomPt') {
      const r = store.find('room', d.id);
      const sp = this.snapPoint(p.x, p.y, { free: e.shiftKey });
      r.points[d.index] = [sp.x, sp.y];
      store.update(null, 'move');
      return;
    }
    if (d.type === 'dimEnd') {
      const o = store.find('dim', d.id);
      const sp = this.snapPoint(p.x, p.y, { free: e.shiftKey });
      o[`x${d.end}`] = sp.x; o[`y${d.end}`] = sp.y;
      store.update(null, 'move');
    }
  }

  snapPointExcluding(x, y, wall, from, free) {
    const saved = store.project.walls;
    store.project.walls = saved.filter((w) => w !== wall);
    const sp = this.snapPoint(x, y, { from, free });
    store.project.walls = saved;
    return sp;
  }

  // 家具靠牆磁吸：接近牆面時自動貼齊並轉向
  _magnet(it) {
    const def = CATALOG_MAP[it.kind];
    if (!def || def.flat || def.ceiling) return;
    const tol = 18;
    let best = null;
    for (const w of store.project.walls) {
      const { u, v, f } = toWallLocal(w, it.x, it.y);
      if (u < -10 || u > f.L + 10) continue;
      const side = v >= 0 ? 1 : -1;
      // 目標朝向：背面靠牆，正面朝法線方向
      const fx = f.nx * side, fy = f.ny * side;
      const target = normDeg(rad2deg(Math.atan2(-fx, fy)));
      let diff = Math.abs(normDeg(it.rot) - target); diff = Math.min(diff, 360 - diff);
      if (diff > 25) continue;
      const gap = Math.abs(v) - w.thickness / 2 - it.d / 2;
      if (Math.abs(gap) < tol && (!best || Math.abs(gap) < Math.abs(best.gap))) best = { w, f, side, gap, target, v };
    }
    if (best) {
      it.rot = best.target;
      const shift = -best.gap * best.side;
      it.x += best.f.nx * shift; it.y += best.f.ny * shift;
      if (def.corner) this._magnetSide(it, best.w, tol);
    }
  }

  // 角落家具：背面貼齊後，直角側（未翻轉為左側，翻轉為右側）再貼齊垂直的牆
  _magnetSide(it, backWall, tol) {
    const r = deg2rad(it.rot || 0);
    const s = it.mirror ? 1 : -1;
    const ex = Math.cos(r) * s, ey = Math.sin(r) * s; // 物件中心指向直角側的方向
    let best = null;
    for (const w of store.project.walls) {
      if (w === backWall) continue;
      const { u, v, f } = toWallLocal(w, it.x, it.y);
      if (u < -10 || u > f.L + 10) continue;
      const sg = v >= 0 ? 1 : -1;
      // 牆在物件的 -sg·n 方向，需與直角側方向一致
      if ((-sg * f.nx) * ex + (-sg * f.ny) * ey < 0.95) continue;
      const gap = Math.abs(v) - w.thickness / 2 - it.w / 2;
      if (Math.abs(gap) < tol && (!best || Math.abs(gap) < Math.abs(best.gap))) best = { gap };
    }
    if (best) { it.x += ex * best.gap; it.y += ey * best.gap; }
  }

  _up(e) {
    const p = this._evt(e);
    this.touches.delete(e.pointerId);
    const d = this.drag;
    this.drag = null;
    if (this.tool === 'pan' || this.tool === 'select') this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'default';
    if (!d) return;
    if (d.type === 'roomRect') {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (x1 - x0 < 40 || y1 - y0 < 40) {
        // 單擊：在封閉牆體內自動偵測房間
        this.app.detectRoomAt(p.x, p.y);
        return;
      }
      store.commit(() => {
        const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        for (let i = 0; i < 4; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4];
          const exists = store.project.walls.some((w) => (dist(w.x1, w.y1, ax, ay) < 2 && dist(w.x2, w.y2, bx, by) < 2) || (dist(w.x1, w.y1, bx, by) < 2 && dist(w.x2, w.y2, ax, ay) < 2));
          if (!exists) store.addWall(ax, ay, bx, by);
        }
        const r = store.addRoom(pts, { name: `房間 ${store.project.rooms.length + 1}` });
        store.select({ type: 'room', id: r.id });
      }, 'room');
      return;
    }
    if (d.type === 'dim') {
      if (dist(d.x0, d.y0, d.x1, d.y1) < 5) return;
      store.commit(() => { store.project.dims.push({ id: `d_${Date.now().toString(36)}`, x1: d.x0, y1: d.y0, x2: d.x1, y2: d.y1 }); }, 'dim');
      return;
    }
    if (d.started) store.changed('commit');
  }

  _dbl(e) {
    const p = this._evt(e);
    if (this.draft) { this._finishDraft(); return; }
    if (this.tool === 'select') {
      const hit = this.hitTest(p.x, p.y);
      if (!hit || hit.type === 'room') this.app.detectRoomAt(p.x, p.y);
    }
  }

  _finishDraft() {
    const d = this.draft;
    this.draft = null;
    if (d?.type === 'polygon' && d.points.length >= 3) {
      store.commit(() => {
        const r = store.addRoom(d.points.map((q) => [q.x, q.y]), { name: `房間 ${store.project.rooms.length + 1}` });
        store.select({ type: 'room', id: r.id });
      }, 'room');
    }
    this.invalidate();
  }

  cancel() {
    if (this.draft) { this.draft = null; this.invalidate(); return true; }
    if (this.tool !== 'select') { this.setTool('select'); return true; }
    return false;
  }

  // ---- 點選判定
  hitTest(x, y) {
    const P = store.project;
    const tol = this.px(4);
    // 家具：先非平面、高的在上
    const items = [...P.items].sort((a, b) => (CATALOG_MAP[a.kind]?.flat ? 0 : 1) - (CATALOG_MAP[b.kind]?.flat ? 0 : 1) || (a.elev + a.h) - (b.elev + b.h));
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const L = toLocal(it.x, it.y, it.rot, x, y);
      if (Math.abs(L.x) <= it.w / 2 + tol && Math.abs(L.y) <= Math.max(it.d, 6) / 2 + tol) return { type: 'item', id: it.id };
    }
    for (const op of P.openings) {
      const w = store.wall(op.wallId); if (!w) continue;
      const { u, v } = toWallLocal(w, x, y);
      if (Math.abs(u - op.offset) <= op.width / 2 && Math.abs(v) <= w.thickness / 2 + tol + 4) return { type: 'opening', id: op.id };
    }
    for (const w of P.walls) {
      const pr = projectToSegment(x, y, w.x1, w.y1, w.x2, w.y2);
      if (pr.d <= w.thickness / 2 + tol) return { type: 'wall', id: w.id };
    }
    for (const dm of P.dims) {
      if (projectToSegment(x, y, dm.x1, dm.y1, dm.x2, dm.y2).d <= tol * 2) return { type: 'dim', id: dm.id };
    }
    const r = roomAt(P.rooms, x, y);
    if (r) return { type: 'room', id: r.id };
    return null;
  }

  // ---- 繪製
  floorPattern(matId) {
    if (this.patterns.has(matId)) return this.patterns.get(matId);
    const c = materialCanvas(matId);
    const pat = this.ctx.createPattern(c, 'repeat');
    const m = getMaterial(matId);
    const k = (m.size * 100) / c.width;
    pat.setTransform(new DOMMatrix().scale(k, k));
    this.patterns.set(matId, pat);
    return pat;
  }

  render() {
    const ctx = this.ctx;
    const P = store.project;
    const { scale, ox, oy } = this.view;
    const W = this.canvas.width, H = this.canvas.height;
    const pal = paletteFor(P.design.styleId);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--plan-bg').trim() || '#f7f7f5';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(this.dpr * scale, 0, 0, this.dpr * scale, this.dpr * ox, this.dpr * oy);
    const lw = this.px(1);

    // 背景圖
    const bg = P.background;
    if (bg && bg.visible !== false && bg.src) {
      if (!this.bgImage || this.bgImage.src !== bg.src) { this.bgImage = new Image(); this.bgImage.onload = () => this.invalidate(); this.bgImage.src = bg.src; }
      if (this.bgImage.complete && this.bgImage.naturalWidth) {
        ctx.globalAlpha = bg.opacity ?? 0.5;
        ctx.drawImage(this.bgImage, bg.x || 0, bg.y || 0, this.bgImage.naturalWidth * bg.scale, this.bgImage.naturalHeight * bg.scale);
        ctx.globalAlpha = 1;
      }
    }

    // 格線
    if (P.settings.grid) {
      const tl = this.toWorld(0, 0), br = this.toWorld(W / this.dpr, H / this.dpr);
      const step = scale > 1.2 ? 10 : scale > 0.25 ? 50 : 100;
      ctx.lineWidth = lw;
      for (let x = Math.floor(tl.x / step) * step; x < br.x; x += step) {
        ctx.strokeStyle = x % 100 === 0 ? 'rgba(0,0,0,0.09)' : 'rgba(0,0,0,0.04)';
        ctx.beginPath(); ctx.moveTo(x, tl.y); ctx.lineTo(x, br.y); ctx.stroke();
      }
      for (let y = Math.floor(tl.y / step) * step; y < br.y; y += step) {
        ctx.strokeStyle = y % 100 === 0 ? 'rgba(0,0,0,0.09)' : 'rgba(0,0,0,0.04)';
        ctx.beginPath(); ctx.moveTo(tl.x, y); ctx.lineTo(br.x, y); ctx.stroke();
      }
    }

    // 房間地板
    const sel = store.selection;
    for (const r of P.rooms) {
      ctx.beginPath();
      r.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = this.floorPattern(r.floor || 'wood_oak');
      ctx.fill();
      ctx.globalAlpha = 1;
      if (sel?.type === 'room' && sel.id === r.id) {
        ctx.fillStyle = 'rgba(37,99,235,0.08)'; ctx.fill();
        ctx.lineWidth = lw * 2; ctx.strokeStyle = '#2563eb'; ctx.setLineDash([this.px(6), this.px(4)]); ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // 牆
    const joins = wallJoins(P.walls);
    for (const w of P.walls) {
      const poly = wallPolygon(w, joins.get(w.id));
      ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.fillStyle = '#3d3f43'; ctx.fill();
    }
    for (const w of P.walls) {
      const isSel = sel?.type === 'wall' && sel.id === w.id;
      const isHover = this.hover?.type === 'wall' && this.hover.id === w.id;
      if (isSel || isHover) {
        const poly = wallPolygon(w, joins.get(w.id));
        ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        ctx.fillStyle = isSel ? '#2563eb' : '#5b6170'; ctx.fill();
      }
    }

    // 門窗
    for (const op of P.openings) this.drawOpening(ctx, op, lw, sel);

    // 家具（地毯先畫，吊燈最後）
    const order = (it) => { const d = CATALOG_MAP[it.kind]; return d?.flat ? 0 : d?.ceiling ? 3 : it.elev > 100 ? 2 : 1; };
    const items = [...P.items].sort((a, b) => order(a) - order(b));
    for (const it of items) {
      const def = CATALOG_MAP[it.kind];
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.rotate(deg2rad(it.rot || 0));
      if (def?.ceiling) ctx.globalAlpha = 0.75;
      const p2 = { ...pal };
      if (def?.roles) { if (it.color && def.roles[0]) p2[def.roles[0]] = it.color; if (it.color2 && def.roles[1]) p2[def.roles[1]] = it.color2; }
      // 左右翻轉只套用在家具符號上，控制點維持原位（與點選判定一致）
      ctx.save();
      if (it.mirror) ctx.scale(-1, 1);
      try { def ? def.plan(ctx, it.w, it.d, lw, p2) : (ctx.strokeRect(-it.w / 2, -it.d / 2, it.w, it.d)); } catch { /* ignore */ }
      ctx.restore();
      ctx.globalAlpha = 1;
      const isSel = sel?.type === 'item' && sel.id === it.id;
      const isHover = this.hover?.type === 'item' && this.hover.id === it.id;
      if (isSel || isHover) {
        ctx.lineWidth = lw * (isSel ? 2 : 1.5);
        ctx.strokeStyle = isSel ? '#2563eb' : 'rgba(37,99,235,0.6)';
        ctx.strokeRect(-it.w / 2, -it.d / 2, it.w, it.d);
      }
      if (isSel) {
        // 旋轉與縮放控制點
        const ry = -it.d / 2 - this.px(26);
        ctx.beginPath(); ctx.moveTo(0, -it.d / 2); ctx.lineTo(0, ry); ctx.stroke();
        this._handle(ctx, 0, ry, true);
        this._handle(ctx, it.w / 2, it.d / 2);
        // 正面方向箭頭
        ctx.fillStyle = '#2563eb';
        ctx.beginPath(); ctx.moveTo(0, it.d / 2 + this.px(10)); ctx.lineTo(-this.px(5), it.d / 2 + this.px(3)); ctx.lineTo(this.px(5), it.d / 2 + this.px(3)); ctx.fill();
      }
      ctx.restore();
    }

    // 尺寸標註
    for (const dm of P.dims) this.drawDim(ctx, dm.x1, dm.y1, dm.x2, dm.y2, sel?.type === 'dim' && sel.id === dm.id);

    // 選取牆時顯示長度與端點
    if (sel?.type === 'wall') {
      const w = store.wall(sel.id);
      if (w) {
        const f = wallFrame(w);
        const off = w.thickness / 2 + this.px(18);
        this.drawDim(ctx, w.x1 + f.nx * off, w.y1 + f.ny * off, w.x2 + f.nx * off, w.y2 + f.ny * off, false, true);
        this._handle(ctx, w.x1, w.y1); this._handle(ctx, w.x2, w.y2);
      }
    }
    if (sel?.type === 'room') {
      const r = store.find('room', sel.id);
      if (r) r.points.forEach(([x, y]) => this._handle(ctx, x, y));
    }

    // 工具預覽
    this.drawToolPreview(ctx, lw);

    // 漫遊者
    if (this.visitor) {
      const v = this.visitor;
      ctx.save(); ctx.translate(v.x, v.y); ctx.rotate(v.yaw);
      ctx.fillStyle = 'rgba(234,88,12,0.18)';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 220, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ea580c'; ctx.beginPath(); ctx.arc(0, 0, this.px(7), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // 文字標籤（螢幕座標）
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const r of P.rooms) {
      const [cx, cy] = polygonCentroid(r.points);
      const s = this.toScreen(cx, cy);
      // 依房間在畫面上的大小決定是否顯示面積
      const bb = r.points.reduce((m, [x, y]) => ({ x0: Math.min(m.x0, x), x1: Math.max(m.x1, x), y0: Math.min(m.y0, y), y1: Math.max(m.y1, y) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
      const roomPx = Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) * scale;
      if (roomPx < 28) continue;
      const t1 = r.name || '房間', t2 = areaText(polygonArea(r.points));
      const showArea = roomPx > 70 && (bb.x1 - bb.x0) * scale > 120;
      ctx.font = '600 12px system-ui, sans-serif';
      const tw = Math.max(ctx.measureText(t1).width, showArea ? ctx.measureText(t2).width * 0.95 : 0);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(s.x - tw / 2 - 5, s.y - (showArea ? 16 : 9), tw + 10, showArea ? 32 : 18);
      ctx.fillStyle = '#1f2937'; ctx.fillText(t1, s.x, s.y - (showArea ? 6 : 0));
      if (showArea) { ctx.font = '10.5px system-ui, sans-serif'; ctx.fillStyle = '#4b5563'; ctx.fillText(t2, s.x, s.y + 8); }
    }
    this.drawScaleBar(ctx, W / this.dpr, H / this.dpr);
  }

  // 左上角比例尺（在「2D 平面圖」標籤下方）：依縮放選擇 1-2-5 進位的整數長度，長度約 70 到 170 px
  drawScaleBar(ctx, viewW, viewH) {
    const scale = this.view.scale;
    let len = 10;
    for (const base of [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) { len = base; if (base * scale >= 70) break; }
    const px = len * scale, x = 22, y = 58, seg = 4;
    const label = len >= 100 ? `${len / 100} m` : `${len} cm`;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillRect(x - 10, y - 22, px + 28, 32);
    for (let i = 0; i < seg; i++) {
      ctx.fillStyle = i % 2 ? '#ffffff' : '#1f2937';
      ctx.fillRect(x + (px / seg) * i, y - 4, px / seg, 6);
    }
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y - 4 + 0.5, px, 6);
    ctx.fillStyle = '#1f2937'; ctx.font = '10.5px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left'; ctx.fillText('0', x - 2, y - 9);
    ctx.textAlign = 'center'; ctx.fillText(label, x + px, y - 9);
    ctx.restore();
  }

  _handle(ctx, x, y, round = false) {
    const r = this.px(HANDLE / 1.4);
    ctx.save();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2563eb'; ctx.lineWidth = this.px(2);
    ctx.beginPath();
    if (round) ctx.arc(x, y, r, 0, Math.PI * 2); else ctx.rect(x - r, y - r, r * 2, r * 2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawOpening(ctx, op, lw, sel) {
    const w = store.wall(op.wallId);
    if (!w) return;
    const def = OPENING_MAP[op.kind] || {};
    const c = openingCenter(op, w);
    const t = w.thickness;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.f.angle);
    const hw = op.width / 2;
    // 牆開口
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--plan-bg').trim() || '#f7f7f5';
    ctx.fillRect(-hw, -t / 2 - 0.5, op.width, t + 1);
    ctx.strokeStyle = '#3d3f43'; ctx.lineWidth = lw * 1.4;
    ctx.beginPath(); ctx.moveTo(-hw, -t / 2); ctx.lineTo(-hw, t / 2); ctx.moveTo(hw, -t / 2); ctx.lineTo(hw, t / 2); ctx.stroke();
    const isSel = sel?.type === 'opening' && sel.id === op.id;
    ctx.strokeStyle = isSel ? '#2563eb' : '#374151';
    ctx.lineWidth = lw * (isSel ? 2 : 1.2);
    const sv = op.flipV ? -1 : 1; // 開門方向（牆的哪一側）
    const sh = op.flipH ? -1 : 1; // 鉸鏈位置
    if (def.type === 'door') {
      const hx = -hw * sh, ex = hw * sh;
      ctx.beginPath(); ctx.moveTo(hx, (t / 2) * sv); ctx.lineTo(hx, (t / 2 + op.width) * sv); ctx.stroke();
      ctx.beginPath();
      ctx.setLineDash([this.px(4), this.px(3)]);
      const a0 = sv > 0 ? (sh > 0 ? Math.PI / 2 : Math.PI / 2) : -Math.PI / 2;
      void a0;
      // 弧線由門片端點到牆上另一端
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * (Math.PI / 2);
        const x = hx + (ex - hx) * Math.sin(a);
        const y = (t / 2) * sv + op.width * Math.cos(a) * sv;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    } else if (def.type === 'double') {
      for (const s of [-1, 1]) {
        const hx = s * hw, L = hw;
        ctx.beginPath(); ctx.moveTo(hx, (t / 2) * sv); ctx.lineTo(hx, (t / 2 + L) * sv); ctx.stroke();
        ctx.setLineDash([this.px(4), this.px(3)]);
        ctx.beginPath();
        for (let i = 0; i <= 20; i++) { const a = (i / 20) * (Math.PI / 2); const x = hx - s * L * Math.sin(a); const y = (t / 2 + L * Math.cos(a)) * sv; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
        ctx.stroke(); ctx.setLineDash([]);
      }
    } else if (def.type === 'sliding') {
      ctx.strokeRect(-hw, -3, hw + 4, 3); ctx.strokeRect(-4, 0, hw + 4, 3);
    } else if (def.type === 'opening') {
      ctx.setLineDash([this.px(5), this.px(4)]);
      ctx.beginPath(); ctx.moveTo(-hw, 0); ctx.lineTo(hw, 0); ctx.stroke(); ctx.setLineDash([]);
    } else {
      ctx.fillStyle = '#e6f1f7';
      ctx.fillRect(-hw, -t / 2, op.width, t);
      ctx.strokeRect(-hw, -t / 2, op.width, t);
      ctx.beginPath(); ctx.moveTo(-hw, 0); ctx.lineTo(hw, 0); ctx.stroke();
      if (def.type === 'french') { ctx.beginPath(); ctx.moveTo(-hw, -t / 4); ctx.lineTo(hw, -t / 4); ctx.moveTo(-hw, t / 4); ctx.lineTo(hw, t / 4); ctx.stroke(); }
    }
    ctx.restore();
  }

  drawDim(ctx, x1, y1, x2, y2, selected = false, light = false) {
    const L = dist(x1, y1, x2, y2);
    if (L < 1) return;
    const lw = this.px(1);
    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.save();
    ctx.strokeStyle = selected ? '#2563eb' : light ? '#2563eb' : '#b45309';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const tk = this.px(5);
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a + Math.PI / 4) * tk, y + Math.sin(a + Math.PI / 4) * tk); ctx.lineTo(x - Math.cos(a + Math.PI / 4) * tk, y - Math.sin(a + Math.PI / 4) * tk); ctx.stroke();
    }
    ctx.translate((x1 + x2) / 2, (y1 + y2) / 2);
    let ta = a; if (ta > Math.PI / 2 || ta < -Math.PI / 2) ta += Math.PI;
    ctx.rotate(ta);
    ctx.font = `${this.px(12)}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const txt = `${Math.round(L)} cm`;
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-tw / 2 - this.px(3), -this.px(16), tw + this.px(6), this.px(14));
    ctx.fillStyle = selected || light ? '#1d4ed8' : '#92400e';
    ctx.fillText(txt, 0, -this.px(3));
    ctx.restore();
    if (selected) { this._handle(ctx, x1, y1); this._handle(ctx, x2, y2); }
  }

  drawToolPreview(ctx, lw) {
    const m = this.mouse;
    const d = this.drag;
    if (d?.type === 'roomRect') {
      ctx.fillStyle = 'rgba(37,99,235,0.1)'; ctx.strokeStyle = '#2563eb'; ctx.lineWidth = lw * 2;
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      this.drawDim(ctx, x, y - this.px(16), x + w, y - this.px(16), false, true);
      this.drawDim(ctx, x - this.px(16), y, x - this.px(16), y + h, false, true);
    }
    if (d?.type === 'dim') this.drawDim(ctx, d.x0, d.y0, d.x1, d.y1, true);
    if (!m.inside) return;
    if (this.tool === 'wall' || this.tool === 'polygon' || this.tool === 'dim' || this.tool === 'room') {
      const from = this.draft?.points.at(-1);
      const sp = this.tool === 'calibrate' ? m : this.snapPoint(m.x, m.y, { from, free: m.shift });
      ctx.fillStyle = sp.snapped === 'end' ? '#16a34a' : '#2563eb';
      ctx.beginPath(); ctx.arc(sp.x, sp.y, this.px(4), 0, Math.PI * 2); ctx.fill();
      if (this.draft?.points.length) {
        const pts = this.draft.points;
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = this.tool === 'wall' ? store.project.settings.wallThickness : lw * 2;
        ctx.globalAlpha = this.tool === 'wall' ? 0.45 : 1;
        ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.lineTo(sp.x, sp.y);
        if (this.tool === 'polygon') { ctx.fillStyle = 'rgba(37,99,235,0.08)'; ctx.fill(); }
        ctx.stroke(); ctx.globalAlpha = 1;
        this.drawDim(ctx, from.x, from.y, sp.x, sp.y, false, true);
      }
    }
    if (this.tool === 'calibrate' && this.draft) {
      const a = this.draft.points[0];
      ctx.strokeStyle = '#dc2626'; ctx.lineWidth = lw * 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(m.x, m.y); ctx.stroke();
    }
    if (this.tool === 'place' && this.placeKind) {
      const def = CATALOG_MAP[this.placeKind];
      if (def) { ctx.strokeStyle = '#2563eb'; ctx.lineWidth = lw * 1.5; ctx.setLineDash([this.px(4), this.px(3)]); ctx.strokeRect(m.x - def.w / 2, m.y - def.d / 2, def.w, def.d); ctx.setLineDash([]); }
      else if (OPENING_MAP[this.placeKind]) {
        const near = nearestWall(store.project.walls, m.x, m.y, 80);
        if (near) { ctx.fillStyle = '#2563eb'; ctx.beginPath(); ctx.arc(near.x, near.y, this.px(6), 0, Math.PI * 2); ctx.fill(); }
      }
    }
  }

  exportPNG() {
    return this.canvas.toDataURL('image/png');
  }

  autoDetectAll() {
    return detectRooms(store.project.walls);
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export { isTyping, rectCorners, pointInPolygon };
