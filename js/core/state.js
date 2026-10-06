// 專案資料、選取、復原/重做、自動儲存
import { uid } from './geometry.js';
import { CATALOG_MAP, OPENING_MAP } from '../data/catalog.js';

const STORAGE_KEY = 'interior-studio:project';

export function emptyProject() {
  return {
    version: 1,
    name: '未命名專案',
    settings: { wallHeight: 280, wallThickness: 12, snap: true, grid: true, showCeiling: false, night: false, cutaway: false },
    walls: [],
    rooms: [],
    openings: [],
    items: [],
    dims: [],
    background: null,
    design: { styleId: null, report: null },
  };
}

class Store {
  constructor() {
    this.project = emptyProject();
    this.selection = null; // { type, id, side? }
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Map();
    this._saveTimer = null;
  }

  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt).delete(fn);
  }
  emit(evt, payload) {
    for (const fn of this.listeners.get(evt) || []) fn(payload);
  }

  snapshot() {
    const { background, ...rest } = this.project;
    // 底圖影像太大不放進復原紀錄，只記錄位置與比例
    if (background) rest._bg = { x: background.x || 0, y: background.y || 0, scale: background.scale };
    return JSON.stringify(rest);
  }
  // 在修改前呼叫，記錄一個復原點
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit('history');
  }
  // 修改資料並通知（不自動建立復原點）
  update(fn, reason = 'edit') {
    if (fn) fn(this.project);
    this.changed(reason);
  }
  // 建立復原點 + 修改
  commit(fn, reason = 'edit') {
    this.checkpoint();
    this.update(fn, reason);
  }
  changed(reason = 'edit') {
    this.emit('change', reason);
    this.scheduleSave();
  }
  restore(json) {
    const bg = this.project.background;
    const { _bg, ...data } = JSON.parse(json);
    if (bg && _bg) Object.assign(bg, _bg);
    this.project = { ...data, background: bg };
    if (this.selection && !this.find(this.selection.type, this.selection.id)) this.select(null);
    this.changed('history');
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
    this.emit('history');
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
    this.emit('history');
  }

  load(project, { keepHistory = false } = {}) {
    const base = emptyProject();
    this.project = { ...base, ...project, settings: { ...base.settings, ...(project.settings || {}) }, design: { ...base.design, ...(project.design || {}) } };
    for (const k of ['walls', 'rooms', 'openings', 'items', 'dims']) this.project[k] = this.project[k] || [];
    if (!keepHistory) { this.undoStack = []; this.redoStack = []; }
    this.selection = null;
    this.emit('select', null);
    this.changed('load');
    this.emit('history');
  }

  // ---- 查詢
  listOf(type) {
    return { item: this.project.items, wall: this.project.walls, opening: this.project.openings, room: this.project.rooms, dim: this.project.dims }[type];
  }
  find(type, id) { return this.listOf(type)?.find((o) => o.id === id); }
  wall(id) { return this.project.walls.find((w) => w.id === id); }
  selected() { return this.selection ? this.find(this.selection.type, this.selection.id) : null; }

  select(sel) {
    this.selection = sel;
    this.emit('select', sel);
  }

  // ---- 新增
  addWall(x1, y1, x2, y2, opts = {}) {
    const s = this.project.settings;
    const w = { id: uid('w'), x1, y1, x2, y2, thickness: opts.thickness || s.wallThickness, height: opts.height || s.wallHeight, matA: opts.matA || 'paint_white', matB: opts.matB || 'paint_white' };
    this.project.walls.push(w);
    return w;
  }
  addRoom(points, opts = {}) {
    const r = { id: uid('r'), name: opts.name || '房間', type: opts.type || 'auto', points, floor: opts.floor || 'wood_oak', ceiling: true };
    this.project.rooms.push(r);
    return r;
  }
  addItem(kind, x, y, opts = {}) {
    const def = CATALOG_MAP[kind];
    if (!def) return null;
    const it = {
      id: uid('f'), kind, name: def.name, x, y, rot: opts.rot || 0,
      w: opts.w || def.w, d: opts.d || def.d, h: opts.h || def.h,
      elev: opts.elev !== undefined ? opts.elev : def.elev || 0,
      color: opts.color || null, color2: opts.color2 || null,
      ...(opts.auto ? { auto: true } : {}),
    };
    if (def.ceiling && opts.elev === undefined) {
      it.elev = def.id === 'ceiling_light' ? this.project.settings.wallHeight - it.h : def.elev;
    }
    this.project.items.push(it);
    return it;
  }
  addOpening(kind, wallId, offset, opts = {}) {
    const def = OPENING_MAP[kind];
    if (!def) return null;
    const op = { id: uid('o'), kind, wallId, offset, width: opts.width || def.width, height: opts.height || def.height, sill: opts.sill !== undefined ? opts.sill : def.sill, flipH: !!opts.flipH, flipV: !!opts.flipV };
    this.project.openings.push(op);
    return op;
  }

  remove(type, id) {
    const list = this.listOf(type);
    const i = list.findIndex((o) => o.id === id);
    if (i >= 0) list.splice(i, 1);
    if (type === 'wall') this.project.openings = this.project.openings.filter((o) => o.wallId !== id);
    if (this.selection?.id === id) this.select(null);
  }

  // ---- 儲存
  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveLocal(), 700);
  }
  saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project));
    } catch (e) {
      // 背景圖過大時改為不含背景存檔
      try {
        const { background, ...rest } = this.project;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
        this.emit('toast', '背景圖過大，自動存檔不包含背景圖（請用「儲存檔案」匯出）');
      } catch { /* 無法存檔 */ }
    }
  }
  loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      this.load(JSON.parse(raw));
      return true;
    } catch { return false; }
  }
}

export const store = new Store();
