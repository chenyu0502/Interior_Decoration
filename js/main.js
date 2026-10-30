// 應用程式主控：介面、目錄、屬性面板、檔案、快捷鍵
import * as THREE from 'three';
import { store, emptyProject } from './core/state.js';
import { Plan2D, isTyping } from './editor/plan2d.js';
import { View3D } from './editor/view3d.js';
import { CATALOG, OPENINGS, CATALOG_MAP, OPENING_MAP, CATEGORIES, buildItemObject, itemParams, openingLook, LEAF_FINISHES, FRAME_FINISHES } from './data/catalog.js';
import { MATERIALS, MATERIAL_MAP, materialSwatchURL, setMaterialSwatch } from './data/materials.js';
import { ThumbStudio, THUMB_SIZE, looksBroken, thumbKey, thumbCacheGetAll, thumbCachePut } from './ui/thumbs.js';
import { STYLES, STYLE_MAP, paletteFor } from './data/styles.js';
import { SAMPLES } from './data/samples.js';
import { detectRooms, polygonArea, polygonCentroid, pointInPolygon, wallLength, clamp, areaText, toWallLocal, PING, largestInnerRect, uid } from './core/geometry.js';
import { nearestWall, roomAt, wallOnRoom, wallSideToward, scaleProject, projectBounds } from './core/model.js';
import { autoDesign, analyzeRooms, ROOM_TYPES } from './ai/designer.js';
import * as claude from './ai/claude.js';
import { DesignAssistant } from './ai/assistant.js';
import { SunPanel } from './ui/sun-panel.js';
import { LightPanel } from './ui/light-panel.js';
import { FengshuiPanel } from './ui/fengshui-panel.js';
import { ClearancePanel } from './ui/clearance-panel.js';
import { lightingState, tweakLighting } from './editor/lighting.js';
import { VERSION, CHANGELOG, compareVersions } from './version.js';
import { Updater } from './core/updater.js';
import { mountPano, panoViewerHTML } from './editor/pano-viewer.js';
import { vrSupported } from './editor/vr.js';
import { TourPlayer, planTour, pickMime, tourSteps, viewTargets, previewStop } from './editor/tour.js';
import { pickEncoder } from './editor/mp4-mux.js';
import { longLink, shortLink, readShareFromUrl, getGithubToken, setGithubToken, siteUrl } from './core/share.js';
import { makeQR, qrToCanvas } from './core/qrcode.js';
import { arPayload, arLink } from './ar/ar-link.js';
import { computeBudget, budgetCSV, TIERS, GROUPS } from './editor/budget.js';
import { quoteHTML, quoteOptions, validTaxId, validEmail } from './editor/quote.js';
import { ensureVariants, addVariant, switchVariant, renameVariant, deleteVariant, variantData, withVariant } from './core/variants.js';
import { checkFengshui } from './editor/fengshui.js';
import { checkClearance } from './editor/clearance.js';
import { RenderStudio, RENDER_TIMES, RENDER_QUALITY, RENDER_ASPECTS, RENDER_ENGINES, RENDER_TONES } from './editor/render.js';
import { analyzeFloorplan, buildProject, estimateScale, loadImageData } from './ai/floorplan-import.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3300);
}
store.on('toast', toast);

const TOOL_HINTS = {
  select: '點選物件後可拖曳移動；藍色圓點旋轉、方點縮放。拖曳空白處平移，滾輪縮放；雙擊封閉牆內可偵測房間。',
  wall: '點擊起點後連續點擊畫牆，雙擊／右鍵／Esc 結束。按住 Shift 取消角度吸附。',
  room: '拖曳畫出矩形房間（自動建立四面牆）；在封閉牆體內單擊可自動偵測房間範圍。',
  polygon: '依序點擊多邊形頂點，點回起點或雙擊完成（只建立地板，不建立牆）。',
  dim: '拖曳拉出量尺標註。',
  pan: '拖曳平移畫面。',
  calibrate: '在底圖上點擊一段已知長度的兩端（例如一面牆），再輸入實際長度。',
  place: '在平面圖上點擊放置（Shift 可連續放置），Esc 取消。',
};

class App {
  constructor() {
    this.plan = new Plan2D($('#planCanvas'), this);
    this.view3d = new View3D($('#view3d'), this);
    this.setupLive();
    this.setupAssistant();
    this.sunPanel = new SunPanel(this);
    this.lightPanel = new LightPanel(this);
    this.fsPanel = new FengshuiPanel(this);
    this.clPanel = new ClearancePanel(this);
    this.selectedStyle = null;
    this.catFilter = 'all';
    this.buildCatalogUI();
    this.buildMaterialsUI();
    this.buildAIPanel();
    this.bindTopbar();
    this.bindKeys();
    this.bindWalkTouch();
    this.bindMobileSheets();
    // 支援 WebXR 的頭盔瀏覽器（例如 Meta Quest）才顯示 VR 按鈕
    vrSupported().then((ok) => { $('#vrBtn').hidden = !ok; });
    store.on('select', () => this.renderProps());
    store.on('change', (reason) => {
      if (!['move', 'resize'].includes(reason)) this.renderProps();
      else this.refreshPropValues();
      if (['load', 'design', 'room', 'history', 'edit'].includes(reason)) this.renderRoomTypes();
      if (!['move', 'resize'].includes(reason)) this.syncToggles();
      if (['design', 'load', 'history', 'settings'].includes(reason)) this.renderVariantBar();
      this.updateStatus();
    });
    store.on('history', () => this.updateHistoryButtons());
    const restored = store.loadLocal();
    if (!restored) store.load(SAMPLES[0].make());
    this.syncToggles();
    this.renderProps();
    this.renderRoomTypes();
    requestAnimationFrame(() => this.plan.fit());
    this.setTool('select');
    this.initUpdater();
    this.openSharedFromUrl();
    // 在已開啟的分頁貼上分享連結時，只有 # 之後改變，頁面不會重新載入
    window.addEventListener('hashchange', () => { if (location.hash.startsWith('#share=')) this.openSharedFromUrl(); });
  }

  // ------------------------------------------------------------ 版本與更新
  initUpdater() {
    $('#versionLink').textContent = `v${VERSION}`;
    this.updater = new Updater((latest) => this.showUpdate(latest));
    $('#updateModal').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-update]');
      if (!b) return;
      if (b.dataset.update === 'later') {
        if (this.pendingVersion) { this.updater.snooze(this.pendingVersion); toast('已略過，本次瀏覽期間不再提醒；可從「檔案 → 檢查更新」手動更新'); }
        $('#updateModal').hidden = true;
      } else if (b.dataset.update === 'now') {
        b.disabled = true; b.textContent = '更新中…';
        store.saveLocal(); // 先存檔，更新後會自動還原目前的設計
        await this.updater.apply();
      } else if (b.dataset.update === 'close') {
        $('#updateModal').hidden = true;
      }
    });
    this.updater.start();
  }

  releaseHTML(list) {
    return list.map((r) => `<div class="release"><h4>v${esc(r.version)} <small>${esc(r.date)}</small>${r.version === VERSION ? ' <span class="ver-badge">目前版本</span>' : ''}</h4><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`).join('');
  }

  showUpdate(latest) {
    this.pendingVersion = latest.VERSION;
    const newer = (latest.CHANGELOG || []).filter((r) => compareVersions(r.version, VERSION) > 0);
    $('#updateTitle').textContent = `有新版本 v${latest.VERSION}`;
    $('#updateBody').innerHTML = `<p>目前使用 v${esc(VERSION)}，網站已發布 v${esc(latest.VERSION)}。是否立即更新？</p>
      ${newer.length ? `<p><b>更新內容</b></p>${this.releaseHTML(newer)}` : ''}
      <p class="hint">更新會重新整理頁面，目前的設計已自動存檔，更新後會自動還原。</p>`;
    $('#updateFoot').innerHTML = '<button class="btn" data-update="later">稍後再說</button><button class="btn primary" data-update="now">立即更新</button>';
    $('#updateModal').hidden = false;
  }

  async checkUpdateManually() {
    toast('正在檢查更新…');
    const r = await this.updater.check(true);
    if (!r) toast('無法檢查更新，請確認網路連線');
    else if (!r.newer) toast(`已是最新版本 v${VERSION}`);
  }

  showChangelog() {
    $('#updateTitle').textContent = `版本紀錄（目前 v${VERSION}）`;
    $('#updateBody').innerHTML = this.releaseHTML(CHANGELOG);
    $('#updateFoot').innerHTML = '<button class="btn" data-update="close">關閉</button>';
    this.pendingVersion = null;
    $('#updateModal').hidden = false;
  }

  // ------------------------------------------------------------ 目錄
  buildCatalogUI() {
    const chips = $('#catChips');
    const cats = ['all', ...new Set(CATALOG.filter((c) => c.tab !== 'openings').map((c) => c.cat))];
    chips.innerHTML = cats.map((c) => `<button data-cat="${c}" class="${c === 'all' ? 'active' : ''}">${c === 'all' ? '全部' : CATEGORIES[c]}</button>`).join('');
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      this.catFilter = b.dataset.cat;
      $$('button', chips).forEach((x) => x.classList.toggle('active', x === b));
      this.filterCatalog();
    });
    $('#catalogSearch').addEventListener('input', () => this.filterCatalog());
    const mk = (def, isOpening) => {
      const el = document.createElement('div');
      el.className = 'card';
      el.draggable = true;
      el.dataset.kind = def.id;
      el.dataset.cat = def.cat;
      el.dataset.name = def.name;
      el.title = isOpening ? `${def.name}（寬 ${def.width} × 高 ${def.height} cm）` : `${def.name}（${def.w} × ${def.d} × ${def.h} cm）`;
      const c = document.createElement('canvas');
      c.width = c.height = 192; // 2 倍密度，縮圖較清晰
      el.append(c);
      const s = document.createElement('span'); s.textContent = def.name; el.append(s);
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-catalog', def.id); e.dataTransfer.effectAllowed = 'copy'; });
      el.addEventListener('click', () => {
        const armed = el.classList.contains('armed');
        $$('.card.armed').forEach((x) => x.classList.remove('armed'));
        if (armed) { this.setTool('select'); return; }
        el.classList.add('armed');
        this.setTool('place', def.id);
        if (this.isMobileLayout()) {
          // 手機：收起面板、確保 2D 平面圖可見，再點平面圖放置
          this.closeSheets?.();
          if (this.isMode('3d')) this.setView('split');
          toast(`點 2D 平面圖要放「${def.name}」的位置`);
        }
      });
      this.drawPlanIcon(c, def, isOpening);
      return el;
    };
    $('#furnitureCards').append(...CATALOG.filter((d) => d.tab !== 'openings').map((d) => mk(d, false)));
    $('#openingCards').append(...OPENINGS.map((d) => mk(d, true)));
    $('#fenceCards').append(...CATALOG.filter((d) => d.tab === 'openings').map((d) => mk(d, false)));
    // 3D 縮圖（閒置時逐一產生）
    this.renderThumbnails();
  }

  filterCatalog() {
    const q = $('#catalogSearch').value.trim();
    for (const el of $$('#furnitureCards .card')) {
      const ok = (this.catFilter === 'all' || el.dataset.cat === this.catFilter) && (!q || el.dataset.name.includes(q));
      el.hidden = !ok;
    }
  }

  drawPlanIcon(c, def, isOpening) {
    const ctx = c.getContext('2d');
    ctx.setTransform(c.width / 96, 0, 0, c.width / 96, 0, 0);
    ctx.fillStyle = '#eef0f2'; ctx.fillRect(0, 0, 96, 96);
    const pal = paletteFor(store.project.design.styleId);
    if (isOpening) {
      ctx.save(); ctx.translate(48, 56);
      const s = 70 / def.width; ctx.scale(s, s);
      ctx.fillStyle = '#3d3f43'; ctx.fillRect(-def.width / 2 - 30, -6, def.width + 60, 12);
      ctx.fillStyle = '#eef0f2'; ctx.fillRect(-def.width / 2, -7, def.width, 14);
      ctx.strokeStyle = '#374151'; ctx.lineWidth = 1.5 / s;
      if (def.cat === 'door' && def.type !== 'sliding' && def.type !== 'opening') {
        ctx.beginPath(); ctx.moveTo(-def.width / 2, 0); ctx.lineTo(-def.width / 2, -def.width * (def.type === 'double' ? 0.5 : 1));
        ctx.arc(-def.width / 2, 0, def.width * (def.type === 'double' ? 0.5 : 1), -Math.PI / 2, 0); ctx.stroke();
      } else if (def.type === 'sliding') { ctx.strokeRect(-def.width / 2, -4, def.width / 2 + 5, 4); ctx.strokeRect(-5, 0, def.width / 2 + 5, 4); }
      else { ctx.fillStyle = '#d6e9f3'; ctx.fillRect(-def.width / 2, -6, def.width, 12); ctx.strokeRect(-def.width / 2, -6, def.width, 12); ctx.beginPath(); ctx.moveTo(-def.width / 2, 0); ctx.lineTo(def.width / 2, 0); ctx.stroke(); }
      ctx.restore();
      return;
    }
    ctx.save(); ctx.translate(48, 48);
    const s = 78 / Math.max(def.w, def.d, 30); ctx.scale(s, s);
    try { def.plan(ctx, def.w, def.d, 1 / s, pal, itemParams(null, def)); } catch { /* ignore */ }
    ctx.restore();
  }

  // 寫實縮圖：家具、門窗與材質擺在房間一角拍攝。先以快速渲染產生預覽，再以光線追蹤重拍成接近實景照片；
  // 光線追蹤完成的縮圖存在瀏覽器，下次開啟直接使用。換風格時地板、牆面與家具配色跟著改變。
  async renderThumbnails() {
    const run = (this.thumbRun = (this.thumbRun || 0) + 1);
    const stale = () => run !== this.thumbRun;
    const styleId = store.project.design.styleId || '';
    const style = STYLE_MAP[styleId];
    const pal = paletteFor(styleId);
    const floorId = style?.materials?.floor?.default || 'wood_oak';
    const wallId = style?.materials?.wall?.default || 'paint_warm';
    const scene = `${styleId}|${floorId}|${wallId}`;
    const jobs = [
      ...CATALOG.map((def) => ({ key: thumbKey('item', scene, def.id), id: def.id, kind: { type: 'item', def, pal } })),
      ...OPENINGS.map((def) => ({ key: thumbKey('opening', scene, def.id), id: def.id, kind: { type: 'opening', def, pal } })),
      ...MATERIALS.map((m) => ({ key: thumbKey('material', m.id), mat: m.id, kind: { type: 'material', id: m.id } })),
    ];
    const apply = (job, img) => {
      if (job.mat) {
        const url = typeof img === 'string' ? img : toJPEG(img, 160);
        setMaterialSwatch(job.mat, url);
        for (const el of $$(`img[data-mat="${job.mat}"]`)) el.src = url;
        return;
      }
      const draw = (src) => {
        if (stale()) return;
        for (const c of $$(`.cards .card[data-kind="${job.id}"] canvas`)) {
          const ctx = c.getContext('2d');
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(src, 0, 0, c.width, c.height);
        }
      };
      if (typeof img !== 'string') { draw(img); return; }
      const im = new Image();
      im.onload = () => draw(im);
      im.src = img;
    };
    // 1. 已存好的照片直接使用
    const cached = await thumbCacheGetAll(jobs.map((j) => j.key));
    if (stale()) return;
    const todo = [];
    for (const j of jobs) { if (cached.has(j.key)) apply(j, cached.get(j.key)); else todo.push(j); }
    if (!todo.length) return;
    let studio;
    try { studio = new ThumbStudio({ floorId, wallId }); } catch { return; }
    const idle = () => new Promise((res) => (window.requestIdleCallback ? requestIdleCallback(() => res(), { timeout: 400 }) : setTimeout(res, 16)));
    try {
      // 2. 快速預覽（材質預覽只需產生一次）
      await new Promise((res) => setTimeout(res, 300));
      for (const j of todo) {
        if (stale()) return;
        if (j.mat && this.matPreviewDone) continue;
        try { apply(j, studio.shoot(j.kind)); } catch (e) { console.warn('縮圖產生失敗', j.id || j.mat, e); }
        await idle();
      }
      this.matPreviewDone = true;
      // 3. 光線追蹤重拍
      try { await studio.initTracer(); } catch (e) { console.warn('縮圖光線追蹤無法使用', e); return; }
      const samples = this.isMobileLayout() ? 48 : 128;
      const paused = () => !!this.studio?.running || !!this.view3d?.vr?.active || !!this.view3d?.live?.busy;
      let checked = false;
      for (const j of todo) {
        if (stale()) return;
        await idle();
        let out;
        try { out = await studio.trace(j.kind, { samples, shouldStop: stale, paused }); } catch (e) { console.warn('縮圖光線追蹤失敗', j.id || j.mat, e); return; }
        if (!out) return;
        // 第一張檢查畫面是否正常（部分顯示卡無法正確執行光線追蹤）
        if (!checked) { checked = true; if (looksBroken(out)) { console.warn('縮圖光線追蹤畫面異常，保留快速預覽'); return; } }
        const url = toJPEG(out, j.mat ? 160 : THUMB_SIZE);
        apply(j, url);
        thumbCachePut(j.key, url);
      }
    } finally {
      studio.dispose();
    }
  }

  buildMaterialsUI() {
    const mk = (m) => {
      const el = document.createElement('div');
      el.className = 'swatch';
      el.draggable = true;
      el.title = m.name;
      el.innerHTML = `<img alt="" data-mat="${m.id}" src="${materialSwatchURL(m.id)}"><span>${esc(m.name)}</span>`;
      el.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-material', m.id));
      el.addEventListener('click', () => this.applyMaterialToSelection(m.id));
      return el;
    };
    $('#floorSwatches').append(...MATERIALS.filter((m) => m.cat !== 'wall').map(mk));
    $('#wallSwatches').append(...MATERIALS.filter((m) => m.cat !== 'floor').map(mk));
  }

  // ------------------------------------------------------------ 放置 / 材質
  placeCatalog(kind, x, y) {
    const P = store.project;
    if (CATALOG_MAP[kind]) {
      store.commit(() => {
        const it = store.addItem(kind, Math.round(x), Math.round(y));
        this.plan._magnet(it);
        store.select({ type: 'item', id: it.id });
      }, 'add');
      return;
    }
    if (OPENING_MAP[kind]) {
      const near = nearestWall(P.walls, x, y, 100);
      if (!near) { toast('門窗需要放在牆上，請拖曳到牆附近'); return; }
      const def = OPENING_MAP[kind];
      const L = wallLength(near.wall);
      const width = Math.min(def.width, L - 10);
      store.commit(() => {
        const op = store.addOpening(kind, near.wall.id, clamp(near.u, width / 2, L - width / 2), { width });
        // 門預設往點擊所在的一側開
        const { v } = toWallLocal(near.wall, x, y);
        if (def.cat === 'door') op.flipV = v < 0;
        store.select({ type: 'opening', id: op.id });
      }, 'add');
    }
  }

  applyMaterialAt(matId, x, y) {
    const hit = this.plan.hitTest(x, y);
    if (hit?.type === 'wall') {
      // 依滑鼠在牆的哪一側決定
      const w = store.wall(hit.id);
      const { v } = toWallLocal(w, x, y);
      this.applyMaterialToHit(matId, { type: 'wall', id: hit.id, side: v >= 0 ? 'A' : 'B' });
      return;
    }
    const room = roomAt(store.project.rooms, x, y);
    if (room) this.applyMaterialToHit(matId, { type: 'room', id: room.id });
  }

  applyMaterialToHit(matId, hit) {
    const m = MATERIAL_MAP[matId];
    if (hit.type === 'wall') {
      if (m.cat === 'floor') { toast(`「${m.name}」是地坪材質`); return; }
      store.commit(() => { const w = store.wall(hit.id); w[hit.side === 'B' ? 'matB' : 'matA'] = matId; }, 'material');
      toast(`牆面已套用「${m.name}」`);
    } else if (hit.type === 'room') {
      const r = store.find('room', hit.id);
      if (m.cat === 'wall') { this.applyWallMatToRoom(r, matId); return; }
      store.commit(() => { r.floor = matId; }, 'material');
      toast(`${r.name} 地板已套用「${m.name}」`);
    }
  }

  applyWallMatToRoom(r, matId) {
    store.commit(() => {
      for (const w of store.project.walls) {
        if (!wallOnRoom(w, r)) continue;
        const side = wallSideToward(w, r);
        if (side) w[side === 'A' ? 'matA' : 'matB'] = matId;
      }
    }, 'material');
    toast(`${r.name} 牆面已套用「${MATERIAL_MAP[matId].name}」`);
  }

  applyMaterialToSelection(matId) {
    const sel = store.selection;
    if (!sel) { toast('請先選取房間（地板）或牆面，或直接拖曳材質到畫面上'); return; }
    if (sel.type === 'room') {
      const r = store.find('room', sel.id);
      if (MATERIAL_MAP[matId].cat === 'wall') this.applyWallMatToRoom(r, matId);
      else this.applyMaterialToHit(matId, sel);
    } else if (sel.type === 'wall') {
      if (sel.side) this.applyMaterialToHit(matId, sel);
      else {
        if (MATERIAL_MAP[matId].cat === 'floor') { toast('這是地坪材質'); return; }
        store.commit(() => { const w = store.wall(sel.id); w.matA = matId; w.matB = matId; }, 'material');
      }
    } else toast('材質可套用在房間或牆面');
  }

  detectRoomAt(x, y) {
    const polys = detectRooms(store.project.walls).filter((p) => pointInPolygon(x, y, p)).sort((a, b) => Math.abs(polygonArea(a)) - Math.abs(polygonArea(b)));
    if (!polys.length) { toast('此處沒有封閉的牆體範圍'); return; }
    const poly = polys[0];
    const [cx, cy] = polygonCentroid(poly);
    const container = roomAt(store.project.rooms, cx, cy);
    if (container && Math.abs(Math.abs(polygonArea(container.points)) - Math.abs(polygonArea(poly))) < 5000) { store.select({ type: 'room', id: container.id }); return; }
    if (container) { this.detectAllRooms(); return; } // 房間被新牆分割
    store.commit(() => {
      const r = store.addRoom(poly, { name: `房間 ${store.project.rooms.length + 1}` });
      store.select({ type: 'room', id: r.id });
    }, 'room');
    toast(`已建立房間：${areaText(polygonArea(poly))}`);
  }

  // 依牆體重新整理房間：新增封閉區域、並把被新牆分割的房間拆開
  detectAllRooms() {
    const polys = detectRooms(store.project.walls);
    let added = 0, split = 0;
    store.checkpoint();
    const P = store.project;
    const used = new Set();
    for (const r of [...P.rooms]) {
      const inside = polys.filter((p) => { const [cx, cy] = polygonCentroid(p); return pointInPolygon(cx, cy, r.points); });
      inside.forEach((p) => used.add(p));
      if (inside.length < 2) continue;
      // 最大的一塊沿用原房間設定，其餘建立新房間
      inside.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
      r.points = inside[0];
      for (const p of inside.slice(1)) { store.addRoom(p, { name: `房間 ${P.rooms.length + 1}`, floor: r.floor }); split++; }
    }
    for (const p of polys) {
      if (used.has(p)) continue;
      const [cx, cy] = polygonCentroid(p);
      if (P.rooms.some((r) => pointInPolygon(cx, cy, r.points))) continue;
      store.addRoom(p, { name: `房間 ${P.rooms.length + 1}` });
      added++;
    }
    store.changed('room');
    toast(added || split ? `新增 ${added} 個房間${split ? `、分割出 ${split} 個房間` : ''}，可在右側修改名稱與類型` : '沒有偵測到新的封閉房間');
  }

  // ------------------------------------------------------------ 屬性面板
  renderProps() {
    const el = $('#props');
    const sel = store.selection;
    const o = store.selected();
    const P = store.project;
    if (!sel || !o) { el.innerHTML = this.projectPanel(); this.bindProjectPanel(); return; }
    let html = '';
    if (sel.type === 'item') {
      const def = CATALOG_MAP[o.kind] || {};
      const pal = paletteFor(P.design.styleId);
      const roleNames = { fabric: '布料', fabric2: '織品配色', wood: '木作', wood2: '深木', metal: '金屬', stone: '石材', lacquer: '櫃體', accent: '點綴', rug: '地毯', leaf: '植栽', ceramic: '陶瓷' };
      html = `<div class="props"><h3>${esc(def.name || o.kind)}</h3><div class="sub">${esc(CATEGORIES[def.cat] || '')}${o.auto ? ' · AI 配置' : ''}</div>
        <div class="field"><label>名稱</label><input type="text" data-k="name" value="${esc(o.name)}"></div>
        <div class="field"><label>尺寸 cm</label><div><div class="dims3"><input type="number" data-k="w" min="1" value="${o.w}"><input type="number" data-k="d" min="1" value="${o.d}"><input type="number" data-k="h" min="1" value="${o.h}"></div><div class="dims3"><div>寬</div><div>深</div><div>高</div></div></div></div>
        <div class="field"><label>位置 x / y</label><div class="row"><input type="number" data-k="x" value="${Math.round(o.x)}"><input type="number" data-k="y" value="${Math.round(o.y)}"></div></div>
        <div class="field"><label>離地高度</label><input type="number" data-k="elev" value="${o.elev || 0}"></div>
        <div class="field"><label>旋轉 °</label><div class="row"><input type="number" data-k="rot" value="${Math.round(o.rot || 0)}"><button class="btn small" data-act="rot90">↻90°</button></div></div>
        ${this.paramFields(def, o)}
        <div class="field"><label>左右翻轉</label><div class="row"><button class="btn small ${o.mirror ? 'on' : ''}" data-act="mirror" title="左右鏡像（M），例如流理台水槽與爐具互換">⇆ ${o.mirror ? '已翻轉' : '翻轉'}</button></div></div>
        ${(def.roles || []).map((r, i) => `<div class="field"><label>${roleNames[r] || r}</label><div class="row"><input type="color" data-k="${i ? 'color2' : 'color'}" value="${(i ? o.color2 : o.color) || pal[r] || '#cccccc'}"><button class="btn small" data-act="resetColor${i}" title="恢復風格預設">↺</button></div></div>`).join('')}
        <div class="btn-row"><button class="btn" data-act="dup">複製 (Ctrl+D)</button><button class="btn danger" data-act="del">刪除 (Del)</button></div>
        <div class="btn-row"><button class="btn" data-act="ar" title="產生 QR code，用手機 AR 以實際尺寸把這件家具擺進自己家">▣ 手機 AR 擺放</button></div>
        <p class="hint">拖曳靠近牆面會自動貼齊（按住 Alt 可取消磁吸）。方向鍵微調位置、R 鍵旋轉 90°、M 鍵左右翻轉。</p></div>`;
    } else if (sel.type === 'wall') {
      const L = Math.round(wallLength(o));
      const pick = (side) => `<div class="mat-pick">${MATERIALS.filter((m) => m.cat !== 'floor').map((m) => `<img title="${esc(m.name)}" data-side="${side}" data-mat="${m.id}" class="${o[side === 'A' ? 'matA' : 'matB'] === m.id ? 'current' : ''}" src="${materialSwatchURL(m.id)}">`).join('')}</div>`;
      html = `<div class="props"><h3>牆</h3><div class="sub">長度 ${L} cm${sel.side ? ` · 已選 ${sel.side} 面` : ''}</div>
        <div class="field"><label>長度</label><input type="number" data-k="length" value="${L}"></div>
        <div class="field"><label>厚度</label><input type="number" data-k="thickness" value="${o.thickness}"></div>
        <div class="field"><label>高度</label><input type="number" data-k="height" value="${o.height}"></div>
        <section><div class="kv"><span>A 面材質</span><span>${esc(MATERIAL_MAP[o.matA]?.name)}</span></div>${pick('A')}</section>
        <section><div class="kv"><span>B 面材質</span><span>${esc(MATERIAL_MAP[o.matB]?.name)}</span></div>${pick('B')}</section>
        <div class="btn-row"><button class="btn" data-act="splitWall">從中間分割</button><button class="btn danger" data-act="del">刪除</button></div>
        <div class="btn-row"><button class="btn" data-act="calibWall" title="輸入這面牆的實際長度，整張平面圖等比縮放">以此牆長度校正整體比例</button></div>
        <p class="hint">拖曳牆移動、拖曳兩端方點調整；在 3D 畫面點選牆面可直接選取該面。</p></div>`;
    } else if (sel.type === 'opening') {
      const def = OPENING_MAP[o.kind] || {};
      const w = store.wall(o.wallId);
      html = `<div class="props"><h3>${esc(def.name)}</h3><div class="sub">${def.cat === 'door' ? '門' : '窗'} · 所在牆長 ${w ? Math.round(wallLength(w)) : '-'} cm</div>
        <div class="field"><label>類型</label><select data-k="kind">${OPENINGS.map((d) => `<option value="${d.id}" ${d.id === o.kind ? 'selected' : ''}>${d.name}</option>`).join('')}</select></div>
        <div class="field"><label>寬度</label><input type="number" data-k="width" value="${o.width}"></div>
        <div class="field"><label>高度</label><input type="number" data-k="height" value="${o.height}"></div>
        <div class="field"><label>窗台高</label><input type="number" data-k="sill" value="${o.sill}"></div>
        <div class="field"><label>距牆起點</label><input type="number" data-k="offset" value="${Math.round(o.offset)}"></div>
        ${this.openingLookFields(o)}
        ${def.cat === 'door' ? `<div class="btn-row"><button class="btn" data-act="flipH">⇆ 左右翻轉</button><button class="btn" data-act="flipV">⇅ 內外翻轉</button></div>` : ''}
        <div class="btn-row"><button class="btn danger" data-act="del">刪除</button></div></div>`;
    } else if (sel.type === 'room') {
      const a = Math.abs(polygonArea(o.points));
      const floorPick = `<div class="mat-pick">${MATERIALS.filter((m) => m.cat !== 'wall').map((m) => `<img title="${esc(m.name)}" data-floor="${m.id}" class="${o.floor === m.id ? 'current' : ''}" src="${materialSwatchURL(m.id)}">`).join('')}</div>`;
      const wallPick = `<div class="mat-pick">${MATERIALS.filter((m) => m.cat !== 'floor').map((m) => `<img title="${esc(m.name)}" data-roomwall="${m.id}" src="${materialSwatchURL(m.id)}">`).join('')}</div>`;
      html = `<div class="props"><h3>${esc(o.name)}</h3><div class="sub">${areaText(a)}</div>
        <div class="field"><label>名稱</label><input type="text" data-k="name" value="${esc(o.name)}"></div>
        <div class="field"><label>房間類型</label><select data-k="type">${Object.entries(ROOM_TYPES).map(([k, v]) => `<option value="${k}" ${k === (o.type || 'auto') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <section><div class="kv"><span>地板</span><span>${esc(MATERIAL_MAP[o.floor]?.name)}</span></div>${floorPick}</section>
        <section><div class="kv"><span>四周牆面（一次套用）</span></div>${wallPick}</section>
        <div class="btn-row"><button class="btn" data-act="designRoom">✦ 只設計這個房間</button><button class="btn danger" data-act="del">刪除房間</button></div>
        <div class="btn-row"><button class="btn" data-act="arRoom" title="產生 QR code，用手機 AR 以實際尺寸把整個房間的家具擺進自己家">▣ 手機 AR 擺放整個房間</button></div>
        <div class="btn-row"><button class="btn" data-act="calibRoom" title="輸入這個房間的實際坪數，整張平面圖等比縮放">以此房間坪數校正整體比例</button></div>
        <p class="hint">拖曳頂點可調整房間形狀；刪除房間不會刪除牆。</p></div>`;
    } else if (sel.type === 'dim') {
      html = `<div class="props"><h3>量尺</h3><div class="sub">${Math.round(Math.hypot(o.x2 - o.x1, o.y2 - o.y1))} cm</div>
        <div class="btn-row"><button class="btn" data-act="calibDim" title="輸入這段量尺的實際長度，整張平面圖等比縮放">以此長度校正整體比例</button><button class="btn danger" data-act="del">刪除</button></div>
        <p class="hint">用量尺工具（D）量出圖面上已知長度的位置，再按上方按鈕輸入實際長度，即可校正整體比例。</p></div>`;
    }
    el.innerHTML = html;
    this.bindProps(el, sel, o);
  }

  refreshPropValues() {
    const o = store.selected();
    if (!o) return;
    for (const inp of $$('#props input[data-k]')) {
      if (document.activeElement === inp) continue;
      const k = inp.dataset.k;
      if (k === 'length') inp.value = Math.round(wallLength(o));
      else if (['x', 'y', 'rot', 'offset'].includes(k)) inp.value = Math.round(o[k] || 0);
      else if (k in o && inp.type !== 'color') inp.value = o[k] ?? '';
    }
  }

  bindProps(el, sel, o) {
    const commitField = (k, raw) => {
      store.commit(() => {
        const t = store.find(sel.type, sel.id);
        if (!t) return;
        const num = Number(raw);
        if (k === 'leafFinish' || k === 'frameFinish') {
          // 切換成玻璃或由玻璃切回時，顏色改回該材質的預設
          if (k === 'leafFinish' && (raw === 'glass' || t.leafFinish === 'glass')) t.leafColor = null;
          t[k] = raw || null; return;
        }
        if (k === 'name' || k === 'type' || k === 'kind') { t[k] = raw; if (k === 'kind') { const d = OPENING_MAP[raw]; Object.assign(t, { width: d.width, height: d.height, sill: d.sill }); } return; }
        if (k === 'color' || k === 'color2' || k === 'leafColor' || k === 'frameColor') { t[k] = raw; return; }
        if (!Number.isFinite(num)) return;
        if (k === 'length' && sel.type === 'wall') {
          const L = wallLength(t) || 1;
          t.x2 = t.x1 + ((t.x2 - t.x1) / L) * num; t.y2 = t.y1 + ((t.y2 - t.y1) / L) * num;
          return;
        }
        if (k === 'rot') { t.rot = ((num % 360) + 360) % 360; return; }
        t[k] = ['w', 'd', 'h', 'thickness', 'height', 'width'].includes(k) ? Math.max(1, num) : num;
      }, 'edit');
    };
    for (const inp of $$('[data-k]', el)) {
      const k = inp.dataset.k;
      if (inp.type === 'color') {
        let started = false;
        inp.addEventListener('input', () => {
          if (!started) { store.checkpoint(); started = true; }
          const t = store.find(sel.type, sel.id); t[k] = inp.value; store.update(null, 'move');
        });
        inp.addEventListener('change', () => { started = false; store.changed('edit'); });
      } else {
        inp.addEventListener('change', () => commitField(k, inp.value));
        if (inp.tagName === 'INPUT') inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      }
    }
    for (const inp of $$('[data-param]', el)) {
      inp.addEventListener('change', () => {
        const k = inp.dataset.param;
        store.commit(() => {
          const t = store.find(sel.type, sel.id);
          if (!t) return;
          const pd = (CATALOG_MAP[t.kind]?.params || []).find((x) => x.k === k);
          if (!pd) return;
          const v = pd.type === 'bool' ? inp.checked : Math.min(pd.max, Math.max(pd.min, Math.round(Number(inp.value) || pd.def)));
          t.params = { ...(t.params || {}), [k]: v };
        }, 'edit');
      });
      if (inp.type === 'number') inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    }
    for (const b of $$('[data-act]', el)) {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'del') this.deleteSelection();
        else if (act === 'dup') this.duplicate();
        else if (act === 'ar') this.openAR([o.id], { outline: false });
        else if (act === 'arRoom') this.openAR(store.project.items.filter((it) => pointInPolygon(it.x, it.y, o.points)).map((it) => it.id), { outline: true });
        else if (act === 'rot90') this.rotateSelection(90);
        else if (act === 'mirror') this.mirrorSelection();
        else if (act === 'resetColor0' || act === 'resetColor1') store.commit(() => { o[act === 'resetColor0' ? 'color' : 'color2'] = null; }, 'edit');
        else if (act === 'flipH' || act === 'flipV') store.commit(() => { o[act] = !o[act]; }, 'edit');
        else if (act === 'resetLeaf' || act === 'resetFrame') store.commit(() => { const p = act === 'resetLeaf' ? 'leaf' : 'frame'; o[`${p}Finish`] = null; o[`${p}Color`] = null; }, 'edit');
        else if (act === 'splitWall') this.splitWall(o);
        else if (act === 'designRoom') this.runDesign({ roomIds: [o.id] });
        else if (act === 'calibWall') this.calibrateByLength(wallLength(o), '這面牆');
        else if (act === 'calibDim') this.calibrateByLength(Math.hypot(o.x2 - o.x1, o.y2 - o.y1), '這段量尺');
        else if (act === 'calibRoom') this.calibrateByArea(Math.abs(polygonArea(o.points)), `「${o.name || '房間'}」`);
      });
    }
    for (const img of $$('img[data-mat]', el)) img.addEventListener('click', () => this.applyMaterialToHit(img.dataset.mat, { type: 'wall', id: o.id, side: img.dataset.side }));
    for (const img of $$('img[data-floor]', el)) img.addEventListener('click', () => this.applyMaterialToHit(img.dataset.floor, { type: 'room', id: o.id }));
    for (const img of $$('img[data-roomwall]', el)) img.addEventListener('click', () => this.applyWallMatToRoom(o, img.dataset.roomwall));
  }

  // 門窗外觀：門片材質與顏色（門）、框材質與顏色（門與窗）
  openingLookFields(o) {
    const look = openingLook(o, paletteFor(store.project.design.styleId));
    const opts = (map, cur, def) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(v)}${k === def ? '（預設）' : ''}</option>`).join('');
    let html = '<section><div class="kv"><span>外觀</span></div>';
    if (look.leaf) {
      html += `<div class="field"><label>門片材質</label><select data-k="leafFinish">${opts(LEAF_FINISHES, look.leaf.finish, look.defaults.leaf.finish)}</select></div>
        <div class="field"><label>門片顏色</label><div class="row"><input type="color" data-k="leafColor" value="${look.leaf.color}"><button class="btn small" data-act="resetLeaf" title="恢復風格預設">↺</button></div></div>`;
    }
    html += `<div class="field"><label>框材質</label><select data-k="frameFinish">${opts(FRAME_FINISHES, look.frame.finish, look.defaults.frame.finish)}</select></div>
      <div class="field"><label>框顏色</label><div class="row"><input type="color" data-k="frameColor" value="${look.frame.color}"><button class="btn small" data-act="resetFrame" title="恢復風格預設">↺</button></div></div>
      <p class="hint">${look.leaf ? '玻璃門片會加上四周細框；顏色會套用在玻璃上成為有色玻璃。' : '窗戶玻璃維持透明，可調整窗框材質與顏色。'}未自訂時跟隨風格配色。</p></section>`;
    return html;
  }

  // 物件專屬參數（例如格子層櫃的欄數、層數）
  paramFields(def, o) {
    if (!def?.params?.length) return '';
    const v = itemParams(o, def);
    return def.params.map((p) => p.type === 'bool'
      ? `<div class="field"><label>${esc(p.label)}</label><label class="check"><input type="checkbox" data-param="${p.k}" ${v[p.k] ? 'checked' : ''}> ${v[p.k] ? '開啟' : '關閉'}</label></div>`
      : `<div class="field"><label>${esc(p.label)}</label><input type="number" data-param="${p.k}" min="${p.min}" max="${p.max}" step="1" value="${v[p.k]}"${p.unit ? ` title="${p.unit}"` : ''}></div>`).join('');
  }

  projectPanel() {
    const P = store.project;
    const rooms = P.rooms;
    const total = rooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0);
    const style = STYLE_MAP[P.design.styleId];
    return `<div class="props"><h3>專案</h3><div class="sub">未選取物件時顯示專案設定</div>
      <div class="field"><label>專案名稱</label><input type="text" id="projName" value="${esc(P.name)}"></div>
      <div class="field"><label>預設牆高</label><input type="number" id="projWallH" value="${P.settings.wallHeight}"></div>
      <div class="field"><label>預設牆厚</label><input type="number" id="projWallT" value="${P.settings.wallThickness}"></div>
      <section>
        <div class="kv"><span>房間數</span><span>${rooms.length}</span></div>
        <div class="kv"><span>室內面積</span><span>${areaText(total)}</span></div>
        <div class="kv"><span>牆 / 門窗 / 家具</span><span>${P.walls.length} / ${P.openings.length} / ${P.items.length}</span></div>
        <div class="kv"><span>目前風格</span><span>${style ? esc(style.name) : '未套用'}</span></div>
      </section>
      <section><div class="kv"><span>比例尺 / 坪數調整</span></div>
        <div class="field"><label>目標坪數</label><div class="row"><input type="number" id="scalePing" step="0.1" min="0.1" value="${total ? (total / 10000 / PING).toFixed(1) : ''}" ${total ? '' : 'disabled placeholder="尚無房間"'}><button class="btn small" id="applyPing" ${total ? '' : 'disabled'}>套用</button></div></div>
        <div class="field"><label>縮放比例 %</label><div class="row"><input type="number" id="scalePct" step="1" min="10" max="1000" value="100"><button class="btn small" id="applyPct">套用</button></div></div>
        <p class="hint">整張平面圖等比縮放，牆厚、門窗與家具尺寸不變。也可以選取一面牆、一段量尺或一個房間，輸入實際長度或坪數校正。可按 Ctrl+Z 復原。</p>
      </section>
      ${P.design.report ? '<div class="btn-row"><button class="btn" id="showReport">查看 AI 設計建議書</button></div>' : ''}
      <div class="btn-row"><button class="btn" data-action="budget">預算與材料清單</button></div>
      <section><p class="hint"><b>快速上手</b><br>1. 用「畫牆」或「房間」工具畫出平面（或從「檔案 → 範例平面圖」開始、或匯入平面圖底圖描圖）。<br>2. 從左側拖曳門窗到牆上、拖曳家具到房間。<br>3. 到「AI 風格」選擇風格，一鍵自動配置。<br>4. 右側 3D 畫面可環繞、漫遊、直接拖拉家具。</p></section></div>`;
  }

  bindProjectPanel() {
    $('#projName')?.addEventListener('change', (e) => store.commit((p) => { p.name = e.target.value; }, 'edit'));
    $('#projWallH')?.addEventListener('change', (e) => {
      const v = clamp(Number(e.target.value) || 280, 150, 600);
      store.commit((p) => { const old = p.settings.wallHeight; p.settings.wallHeight = v; for (const w of p.walls) if (w.height === old) w.height = v; }, 'edit');
    });
    $('#projWallT')?.addEventListener('change', (e) => store.commit((p) => { p.settings.wallThickness = clamp(Number(e.target.value) || 12, 5, 60); }, 'edit'));
    $('#showReport')?.addEventListener('click', () => this.showReport(store.project.design.report));
    const applyPing = () => {
      const total = store.project.rooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0);
      const target = Number($('#scalePing').value);
      if (!total || !(target > 0)) return toast('請輸入大於 0 的坪數');
      this.rescaleProject(Math.sqrt((target * PING * 10000) / total));
    };
    const applyPct = () => {
      const pct = Number($('#scalePct').value);
      if (!(pct > 0)) return toast('請輸入大於 0 的百分比');
      this.rescaleProject(pct / 100);
    };
    $('#applyPing')?.addEventListener('click', applyPing);
    $('#applyPct')?.addEventListener('click', applyPct);
    $('#scalePing')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPing(); });
    $('#scalePct')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPct(); });
  }

  // ------------------------------------------------------------ 比例調整
  // 整張平面圖等比縮放 f 倍（以左上角為基準點）
  rescaleProject(f) {
    if (!Number.isFinite(f) || f <= 0) return;
    if (f < 0.1 || f > 10) return toast('縮放倍數需介於 0.1 到 10 倍之間');
    if (Math.abs(f - 1) < 1e-4) return toast('比例沒有變化');
    const P = store.project;
    if (!P.walls.length && !P.rooms.length && !P.items.length) return toast('平面圖是空的');
    store.commit((p) => scaleProject(p, f), 'edit');
    this.plan.fit();
    this.view3d.resetView?.();
    const total = store.project.rooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0);
    toast(`已等比縮放 ${(f * 100).toFixed(1)}%${total ? `，室內面積 ${areaText(total)}` : ''}（Ctrl+Z 可復原）`);
  }

  calibrateByLength(current, label) {
    if (!(current > 1)) return;
    const real = Number(prompt(`${label}目前為 ${Math.round(current)} cm，請輸入實際長度（cm），整張平面圖會等比縮放：`, Math.round(current)));
    if (!real || real <= 0) return;
    this.rescaleProject(real / current);
  }

  calibrateByArea(cm2, label) {
    if (!(cm2 > 0)) return;
    const ping = cm2 / 10000 / PING;
    const real = Number(prompt(`${label}目前為 ${areaText(cm2)}，請輸入實際坪數，整張平面圖會等比縮放：`, ping.toFixed(1)));
    if (!real || real <= 0) return;
    this.rescaleProject(Math.sqrt((real * PING * 10000) / cm2));
  }

  // ------------------------------------------------------------ 編輯操作
  deleteSelection() {
    const sel = store.selection;
    if (!sel) return;
    store.commit(() => store.remove(sel.type, sel.id), 'delete');
  }

  duplicate() {
    const o = store.selected();
    if (store.selection?.type !== 'item' || !o) return;
    store.commit(() => {
      const it = store.addItem(o.kind, o.x + 30, o.y + 30, { ...o, rot: o.rot });
      Object.assign(it, { name: o.name, color: o.color, color2: o.color2, elev: o.elev, mirror: !!o.mirror, ...(o.params ? { params: { ...o.params } } : {}) });
      store.select({ type: 'item', id: it.id });
    }, 'add');
  }

  // 左右翻轉（鏡像）：例如流理台水槽與爐具互換、L 型沙發貴妃椅換邊
  mirrorSelection() {
    const o = store.selected();
    if (store.selection?.type !== 'item' || !o) return;
    store.commit(() => { o.mirror = !o.mirror; }, 'edit');
  }

  rotateSelection(deg) {
    const o = store.selected();
    if (store.selection?.type !== 'item' || !o) return;
    store.commit(() => { o.rot = (((o.rot || 0) + deg) % 360 + 360) % 360; }, 'edit');
  }

  nudge(dx, dy) {
    const o = store.selected();
    const t = store.selection?.type;
    if (!o) return;
    store.commit(() => {
      if (t === 'item') { o.x += dx; o.y += dy; }
      else if (t === 'wall' || t === 'dim') { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
      else if (t === 'room') o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
    }, 'edit');
  }

  splitWall(w) {
    store.commit(() => {
      const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
      const L = wallLength(w);
      const nw = store.addWall(mx, my, w.x2, w.y2, { thickness: w.thickness, height: w.height, matA: w.matA, matB: w.matB });
      for (const op of store.project.openings.filter((o) => o.wallId === w.id && o.offset > L / 2)) { op.wallId = nw.id; op.offset -= L / 2; }
      w.x2 = mx; w.y2 = my;
    }, 'edit');
  }

  // ------------------------------------------------------------ AI 面板
  buildAIPanel() {
    const el = $('#aiPanel');
    el.innerHTML = `
      <p class="hint" style="margin-top:0">選擇風格模板，AI 會分析平面圖（房型、坪數、門窗與動線），自動配置家具、地坪與牆面材質並提供設計建議。</p>
      <div id="styleCards">${STYLES.map((s) => `
        <div class="style-card" data-style="${s.id}">
          <h5>${esc(s.name)} <small>${esc(s.en)}</small></h5>
          <dl><dt>特色</dt><dd>${esc(s.features)}</dd><dt>色彩材質</dt><dd>${esc(s.colors)}</dd><dt>適用空間</dt><dd>${esc(s.suits)}</dd></dl>
          <div class="palette">${s.swatches.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
        </div>`).join('')}</div>
      <div class="ai-opts">
        <b>套用方式</b>
        <label><input type="radio" name="aiMode" value="replace" checked> 重新配置家具（清除房間內原有家具）</label>
        <label><input type="radio" name="aiMode" value="keep"> 保留現有家具，只補齊缺少的</label>
        <label><input type="radio" name="aiMode" value="materials"> 只套用材質與配色</label>
        <b style="display:block;margin-top:8px">房間類型（可修正 AI 判斷）</b>
        <table class="room-types" id="roomTypes"></table>
      </div>
      <button class="btn primary big-btn" id="runAI">✦ AI 自動設計</button>
      <div class="btn-row"><button class="btn" id="aiReport">查看設計建議書</button></div>`;
    el.addEventListener('click', (e) => {
      const card = e.target.closest('.style-card');
      if (card) {
        this.selectedStyle = card.dataset.style;
        $$('.style-card', el).forEach((c) => c.classList.toggle('active', c === card));
      }
    });
    $('#runAI').addEventListener('click', () => this.runDesign({}));
    $('#aiReport').addEventListener('click', () => {
      if (store.project.design.report) this.showReport(store.project.design.report);
      else toast('尚未執行 AI 設計');
    });
  }

  renderRoomTypes() {
    const t = $('#roomTypes');
    if (!t) return;
    const analyses = analyzeRooms(store.project);
    if (!analyses.length) { t.innerHTML = '<tr><td class="hint">尚無房間。請先畫房間或按「自動偵測房間」。</td></tr>'; return; }
    t.innerHTML = analyses.map((a) => `<tr><td>${esc(a.room.name)}<br><span class="hint">${a.m2.toFixed(1)} m²</span></td><td><select data-room="${a.room.id}">${Object.entries(ROOM_TYPES).filter(([k]) => k !== 'auto').map(([k, v]) => `<option value="${k}" ${k === a.type ? 'selected' : ''}>${v}</option>`).join('')}</select></td></tr>`).join('');
    for (const s of $$('select', t)) s.addEventListener('change', () => store.commit(() => { store.find('room', s.dataset.room).type = s.value; }, 'edit'));
    if (store.project.design.styleId && !this.selectedStyle) {
      this.selectedStyle = store.project.design.styleId;
      $$('.style-card').forEach((c) => c.classList.toggle('active', c.dataset.style === this.selectedStyle));
    }
  }

  runDesign({ roomIds }) {
    const styleId = this.selectedStyle || store.project.design.styleId;
    if (!styleId) { this.showTab('ai'); toast('請先選擇一個風格模板'); return; }
    if (!store.project.rooms.length) {
      const polys = detectRooms(store.project.walls);
      if (polys.length) this.detectAllRooms();
      else { toast('平面圖中沒有房間，請先畫出房間'); return; }
    }
    const mode = $('input[name="aiMode"]:checked')?.value || 'replace';
    const report = autoDesign(styleId, { mode, roomIds });
    this.redrawIcons();
    toast(`已套用「${STYLE_MAP[styleId].name}」：配置 ${store.project.items.filter((i) => i.auto).length} 件家具`);
    this.showReport(report);
  }

  redrawIcons() {
    for (const el of $$('#openingCards .card')) this.drawPlanIcon($('canvas', el), OPENING_MAP[el.dataset.kind], true);
    this.renderThumbnails();
  }

  showReport(report) {
    const style = STYLE_MAP[report.styleId];
    const tag = (id) => (id ? `<span class="mat-tag"><img src="${materialSwatchURL(id)}" alt="">${esc(MATERIAL_MAP[id]?.name)}</span>` : '');
    $('#reportTitle').textContent = `AI 設計建議書 · ${style.name}`;
    $('#reportBody').innerHTML = `
      <p><b>風格特色：</b>${esc(style.features)}<br><b>色彩與材質：</b>${esc(style.colors)}<br><b>適用空間：</b>${esc(style.suits)}</p>
      <div class="palette" style="max-width:360px">${style.swatches.map((c) => `<i style="background:${c};height:22px"></i>`).join('')}</div>
      <h3>整體評估</h3><ul>${report.fit.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h3>整體設計原則</h3><ul>${report.general.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h3>各空間配置</h3>
      ${report.rooms.map((r) => `<div class="report-room">
        <h4>${esc(r.name)} <small>${esc(ROOM_TYPES[r.type] || r.type)} · ${r.m2.toFixed(1)} m²（${r.ping.toFixed(1)} 坪）</small></h4>
        <div class="mat-tags">${tag(r.floor)}${tag(r.wall)}</div>
        <ul>${[...r.notes, ...(r.tips || [])].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}
      <div class="claude-box">
        <b>✦ 進階：以 Claude 撰寫完整設計提案</b>
        <p class="hint">將平面資料與上述配置交給 Claude，產生更完整的色彩計畫、逐室建議與預算分配。需要您自己的 Anthropic API Key（只儲存在本機瀏覽器，直接由瀏覽器連線 Anthropic，不經過其他伺服器）。</p>
        <input type="password" id="claudeKey" placeholder="sk-ant-…" value="${esc(claude.getApiKey())}" autocomplete="off">
        <textarea id="claudeExtra" rows="2" placeholder="補充需求（選填）：例如 家中有小孩與貓、預算 150 萬、需要大量收納…" style="margin-top:6px"></textarea>
        <div class="btn-row"><button class="btn primary" id="claudeGo">產生提案</button><button class="btn" id="claudeForget">清除金鑰</button></div>
        <div class="claude-out" id="claudeOut"></div>
      </div>`;
    $('#reportModal').hidden = false;
    $('#claudeForget').addEventListener('click', () => { claude.setApiKey(''); $('#claudeKey').value = ''; toast('已清除金鑰'); });
    $('#claudeGo').addEventListener('click', async () => {
      const key = $('#claudeKey').value.trim();
      if (!key) { toast('請輸入 API Key'); return; }
      claude.setApiKey(key);
      const out = $('#claudeOut');
      const btn = $('#claudeGo');
      btn.disabled = true; btn.textContent = '撰寫中…';
      let text = '';
      out.innerHTML = '<p class="hint">Claude 正在分析平面圖…</p>';
      try {
        await claude.requestProposal(store.project, report, (t) => { text += t; out.innerHTML = renderMarkdown(text); }, $('#claudeExtra').value.trim());
        store.project.design.proposal = text;
        store.changed('edit');
      } catch (e) {
        out.innerHTML = `<p style="color:var(--danger)">${esc(claude.describeError(e))}</p>`;
      } finally { btn.disabled = false; btn.textContent = '重新產生'; }
    });
    if (store.project.design.proposal && store.project.design.report === report) $('#claudeOut').innerHTML = renderMarkdown(store.project.design.proposal);
  }

  // ------------------------------------------------------------ 工具列
  setTool(t, kind = null) {
    this.plan.setTool(t, kind);
  }

  onToolChanged(t) {
    $$('#tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t || (t === 'place' && false)));
    if (t !== 'place') $$('.card.armed').forEach((x) => x.classList.remove('armed'));
    $('#toolHint').textContent = TOOL_HINTS[t] || '';
  }

  onPlanHover(x, y) {
    $('#statusCoords').textContent = `x: ${Math.round(x)} · y: ${Math.round(y)} cm`;
  }

  onVisitor(v) { this.plan.visitor = v; this.plan.invalidate(); }

  updateStatus() {
    const P = store.project;
    const style = STYLE_MAP[P.design.styleId];
    $('#statusInfo').textContent = `${P.name} · ${P.rooms.length} 房間 · ${P.items.length} 件家具${style ? ` · ${style.name}` : ''}`;
  }

  updateHistoryButtons() {
    $('[data-action="undo"]').disabled = !store.undoStack.length;
    $('[data-action="redo"]').disabled = !store.redoStack.length;
  }

  syncToggles() {
    const s = store.project.settings;
    $('#snapToggle').checked = s.snap;
    $('#gridToggle').checked = s.grid;
    const L = lightingState(store.project);
    $('#nightBtn').textContent = `${L.time === 'day' ? '☀' : '☾'} ${L.def.short}`;
    $('#nightBtn').classList.toggle('on', !!this.lightPanel?.active);
    $('#ceilBtn').classList.toggle('on', s.showCeiling);
    $('#cutBtn').classList.toggle('on', !!s.cutaway);
    this.updateStatus();
    this.updateHistoryButtons();
  }

  setView(v) {
    const views = $('#views');
    views.className = `views mode-${v}`;
    $$('#viewSeg button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    requestAnimationFrame(() => { this.plan.resize(); this.view3d.resize(); });
  }

  showTab(name) {
    $$('#leftTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== name; });
  }

  bindTopbar() {
    // 檔案選單
    const menu = $('#fileMenu');
    $('[data-menu-toggle]', menu).addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
      if (menu.classList.contains('open')) this.fitMenu(menu);
    });
    window.addEventListener('resize', () => { if (menu.classList.contains('open')) this.fitMenu(menu); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    $('#sampleList').innerHTML = SAMPLES.map((s) => `<button data-sample="${s.id}">${esc(s.name)}</button>`).join('');
    $('#sampleList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sample]'); if (!b) return;
      if (!this.confirmReplace()) return;
      store.load(SAMPLES.find((s) => s.id === b.dataset.sample).make());
      this.afterLoad();
    });
    $$('#tools [data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    $$('#viewSeg button').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view)));
    $$('#leftTabs button').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab)));
    $('#snapToggle').addEventListener('change', (e) => store.update((p) => { p.settings.snap = e.target.checked; }, 'settings'));
    $('#gridToggle').addEventListener('change', (e) => store.update((p) => { p.settings.grid = e.target.checked; }, 'settings'));
    $('#reportModal').addEventListener('click', (e) => { if (e.target.id === 'reportModal' || e.target.closest('[data-close]')) $('#reportModal').hidden = true; });
    $('#fileOpen').addEventListener('change', (e) => this.openFile(e.target.files[0]));
    $('#fileBg').addEventListener('change', (e) => this.importBackground(e.target.files[0]));
    $('#fileAuto').addEventListener('change', (e) => this.autoImportImage(e.target.files[0]));

    document.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const a = b.dataset.action;
      const actions = {
        new: () => { if (this.confirmReplace()) { store.load(emptyProject()); this.afterLoad(); } },
        open: () => $('#fileOpen').click(),
        save: () => this.saveFile(),
        importBg: () => $('#fileBg').click(),
        importAuto: () => { if (this.confirmReplace()) $('#fileAuto').click(); },
        calibrate: () => { if (!store.project.background) { toast('請先匯入底圖'); return; } if (this.isMode('3d')) this.setView('split'); this.setTool('calibrate'); },
        removeBg: () => store.update((p) => { p.background = null; }, 'bg'),
        export2d: () => download(this.plan.exportPNG(), `${store.project.name}-平面圖.png`),
        export3d: () => download(this.view3d.screenshot(), `${store.project.name}-3D.png`),
        checkUpdate: () => this.checkUpdateManually(),
        changelog: () => { e.preventDefault(); this.showChangelog(); },
        undo: () => store.undo(),
        redo: () => store.redo(),
        detectAll: () => this.detectAllRooms(),
        openAI: () => { this.showTab('ai'); if (this.selectedStyle) this.runDesign({}); else toast('請在左側選擇一個風格模板，再按「AI 自動設計」'); },
        zoomIn: () => this.plan.zoomBy(1.25),
        zoomOut: () => this.plan.zoomBy(0.8),
        fit: () => this.plan.fit(),
        resetView: () => this.view3d.resetView(),
        topView: () => this.view3d.topView(),
        walk: () => this.toggleWalk(),
        render: () => this.openRender(),
        assistant: () => this.toggleAssistant(),
        sun: () => this.sunPanel.toggle(),
        tour: () => this.openTour(),
        fengshui: () => this.fsPanel.toggle(),
        clearance: () => this.clPanel.toggle(),
        budget: () => this.openBudget(),
        variants: () => this.openVariants(),
        share: () => this.openShare(),
        ar: () => this.openAR(),
        keepShared: () => this.keepShared(),
        leaveShared: () => { location.href = siteUrl(); },
        live: () => { const l = this.view3d.live; l.setEnabled(!l.enabled); toast(l.enabled ? '實景模式已開啟：停止操作約 1 秒後，畫面會逐漸算成照片' : '實景模式已關閉'); },
        vr: () => this.toggleVR(),
        night: () => this.lightPanel.toggle(),
        ceiling: () => { store.update((p) => { p.settings.showCeiling = !p.settings.showCeiling; }, 'settings'); this.syncToggles(); },
        cutaway: () => { store.update((p) => { p.settings.cutaway = !p.settings.cutaway; }, 'settings'); this.syncToggles(); },
      };
      actions[a]?.();
      if (b.closest('.menu-pop')) menu.classList.remove('open');
    });
  }

  // 選單高度限制在畫面內（手機扣掉底部的選單列），超出時在選單內捲動
  fitMenu(menu) {
    const pop = $('.menu-pop', menu), bar = $('#mobileBar');
    const bottom = bar && bar.offsetParent ? bar.getBoundingClientRect().top : window.innerHeight;
    pop.style.maxHeight = `${Math.max(160, Math.floor(bottom - pop.getBoundingClientRect().top - 8))}px`;
    // 右側超出畫面時往左移
    pop.style.left = '';
    const r = pop.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    if (r.right > vw - 8) pop.style.left = `${Math.round(Math.max(8 - (r.left - pop.offsetLeft), pop.offsetLeft - (r.right - (vw - 8))))}px`;
  }

  isMode(m) { return $('#views').classList.contains(`mode-${m}`); }

  // 一句話改設計：輸入或說出想要的修改，Claude 透過工具直接修改設計
  setupAssistant() {
    const panel = $('#aiChat'), log = $('#aiChatLog'), form = $('#aiChatForm'), input = $('#aiChatText');
    const send = $('#aiChatSend'), mic = $('#aiChatMic');
    this.assistant = new DesignAssistant();
    const EXAMPLES = ['沙發移到窗邊', '客廳地板換成胡桃木', '主臥加一張書桌', '整間改成日式無印風', '晚上開燈看看'];
    const showExamples = () => {
      if (log.children.length) return;
      const box = document.createElement('div');
      box.className = 'ai-examples';
      box.innerHTML = EXAMPLES.map((t) => `<button type="button">${esc(t)}</button>`).join('');
      box.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { input.value = b.textContent; form.requestSubmit(); } });
      log.append(box);
    };
    const needKey = () => { const no = !claude.getApiKey(); $('#aiChatKey').hidden = !no; return no; };
    $('#aiChatKeySave').addEventListener('click', () => {
      const k = $('#aiChatKeyInput').value.trim();
      if (!k) { toast('請輸入 API Key'); return; }
      claude.setApiKey(k); needKey(); input.focus();
    });
    $('#aiChatClose').addEventListener('click', () => this.toggleAssistant(false));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.toggleAssistant(false); });
    this.toggleAssistant = (on = panel.hidden) => {
      panel.hidden = !on;
      if (on) { needKey(); showExamples(); if (!this.isMobileLayout()) input.focus(); this.closeSheets?.(); }
      else { this.assistantAbort?.abort(); }
    };
    const scroll = () => { log.scrollTop = log.scrollHeight; };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || this.assistant.busy) return;
      if (needKey()) { toast('請先輸入 API Key'); return; }
      log.querySelector('.ai-examples')?.remove();
      input.value = '';
      const u = document.createElement('div'); u.className = 'ai-msg-user'; u.textContent = text;
      const bot = document.createElement('div'); bot.className = 'ai-msg-bot';
      bot.innerHTML = '<ul class="ai-actions"></ul><div class="ai-text"></div>';
      log.append(u, bot); scroll();
      const acts = $('.ai-actions', bot), txt = $('.ai-text', bot);
      send.disabled = true; send.textContent = '修改中…';
      const ctrl = new AbortController();
      this.assistantAbort = ctrl;
      const undoDepth = store.undoStack.length;
      const styleBefore = store.project.design.styleId;
      try {
        const { changed } = await this.assistant.run(text, {
          signal: ctrl.signal,
          onText: (t) => { txt.textContent += t; scroll(); },
          onAction: (a) => {
            const li = document.createElement('li');
            if (!a.ok) li.className = 'err';
            li.textContent = a.label;
            if (a.warnings?.length) { const w = document.createElement('span'); w.className = 'warn'; w.textContent = a.warnings.join('；'); li.append(w); }
            acts.append(li); scroll();
          },
        });
        // 換了風格時，選單縮圖依新配色重新產生
        if (store.project.design.styleId !== styleBefore) this.redrawIcons();
        if (changed) {
          const b = document.createElement('button');
          b.className = 'btn small ai-undo'; b.textContent = '復原這次修改';
          b.addEventListener('click', () => {
            // 退回到這次指令之前的狀態（中間若有其他修改也一併退回）
            while (store.undoStack.length > undoDepth) store.undo();
            b.disabled = true; b.textContent = '已復原';
            this.assistant.reset();
          });
          bot.append(b);
        }
      } catch (err) {
        const d = document.createElement('div'); d.className = 'ai-err';
        d.textContent = ctrl.signal.aborted ? '已停止。' : claude.describeError(err);
        bot.append(d);
        if (err?.status === 401) { $('#aiChatKey').hidden = false; $('#aiChatKeyInput').value = ''; }
      } finally {
        send.disabled = false; send.textContent = '送出';
        this.assistantAbort = null;
        scroll();
      }
    });
    // 語音輸入（瀏覽器支援時顯示）
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      mic.hidden = false;
      let rec = null;
      mic.addEventListener('click', () => {
        if (rec) { rec.stop(); return; }
        rec = new SR();
        rec.lang = 'zh-TW'; rec.interimResults = true; rec.continuous = false;
        mic.classList.add('on'); mic.textContent = '聆聽中';
        rec.onresult = (ev) => { input.value = [...ev.results].map((r) => r[0].transcript).join(''); };
        rec.onerror = (ev) => { if (ev.error === 'not-allowed') toast('請允許使用麥克風'); };
        rec.onend = () => {
          mic.classList.remove('on'); mic.textContent = '語音'; rec = null;
          if (input.value.trim()) form.requestSubmit();
        };
        rec.start();
      });
    }
  }

  // 實景模式：按鈕狀態與進度標籤
  setupLive() {
    const live = this.view3d.live;
    const btn = $('#liveBtn'), badge = $('#liveBadge');
    live.onStatus = (st) => {
      btn.classList.toggle('on', st.enabled && !st.failed);
      badge.classList.toggle('warn', st.failed);
      let text = '';
      if (st.failed && st.enabled) text = `此裝置無法使用實景模式：${st.reason || '原因不明'}`;
      else if (st.enabled && st.state === 'tracing') text = st.covering ? `實景計算中 ${Math.round(st.progress * 100)}%` : '實景準備中…';
      else if (st.enabled && st.state === 'done') text = '實景照片';
      badge.title = st.failed ? st.reason || '' : '';
      if (badge.textContent !== text) badge.textContent = text;
      badge.hidden = !text;
    };
    live.status();
  }

  // ------------------------------------------------------------ 寫實渲染
  openRender() {
    const m = $('#renderModal');
    if (!this.studio) {
      this.studio = new RenderStudio(this.view3d);
      const fill = (sel, obj) => { $(sel).innerHTML = Object.entries(obj).map(([k, v]) => `<option value="${k}">${esc(typeof v === 'string' ? v : v.name)}</option>`).join(''); };
      fill('#rEngine', RENDER_ENGINES); fill('#rTone', RENDER_TONES); fill('#rTime', RENDER_TIMES); fill('#rQuality', RENDER_QUALITY); fill('#rAspect', RENDER_ASPECTS);
      $('#rQuality').value = 'standard';
      $('#rTime').addEventListener('change', () => { $('#rLights').checked = RENDER_TIMES[$('#rTime').value].lights; });
      $('#rExposure').addEventListener('input', () => this.studio.setExposure(Number($('#rExposure').value)));
      $('#rTone').addEventListener('change', () => this.studio.setTone($('#rTone').value));
      $('#rOutput').addEventListener('change', () => this.syncRenderOutput());
      m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-render]');
        if (e.target === m) { this.closeRender(); return; }
        if (!b) return;
        const a = b.dataset.render;
        if (a === 'close') this.closeRender();
        else if (a === 'start') this.startRender();
        else if (a === 'stop') { this.studio.stop(); this.renderButtons(false); $('#renderEta').textContent = '已停止，可下載目前畫面'; $('#renderBarWrap').classList.remove('busy'); this.renderTitle(null); }
        else if (a === 'download') { const url = this.studio.toDataURL(); if (url) download(url, `${store.project.name}-${this.lastPano ? '360環景' : '渲染'}.png`); }
        else if (a === 'html') this.downloadPanoHTML();
        else if (a === 'toggle360') this.showPano(!this.panoViewer);
      });
    }
    const P = store.project;
    // 依目前的燈光情境預設時段與是否開燈
    const LS = lightingState(P);
    $('#rTime').value = LS.time === 'day' ? ($('#rTime').value === 'night' || $('#rTime').value === 'dusk' ? 'day' : $('#rTime').value || 'day') : LS.time;
    $('#rLights').checked = LS.time === 'day' ? RENDER_TIMES[$('#rTime').value].lights : LS.anyOn;
    $('#rCeiling').checked = this.view3d.mode === 'walk' || (P.settings.showCeiling && !P.settings.cutaway);
    // 環景拍攝位置：漫遊中可用目前位置，也可選任一房間中央
    const target = this.view3d.controls.target;
    const here = P.rooms.find((r) => pointInPolygon(target.x * 100, target.z * 100, r.points));
    $('#rPanoPos').innerHTML = (this.view3d.mode === 'walk' ? '<option value="walk">目前漫遊位置</option>' : '')
      + P.rooms.map((r) => `<option value="room:${r.id}" ${here && here.id === r.id && this.view3d.mode !== 'walk' ? 'selected' : ''}>${esc(r.name || '房間')} 中央</option>`).join('');
    this.syncRenderOutput();
    m.hidden = false;
  }

  syncRenderOutput() {
    const pano = $('#rOutput').value === 'pano';
    $('#rPanoPosField').hidden = !pano;
    $('#rAspect').disabled = pano;
    if (pano) $('#rCeiling').checked = true; // 環景在室內拍攝，需要天花板
    $('#rCeiling').disabled = pano;
  }

  // 環景拍攝點（公尺）與預設面向
  panoOrigin() {
    const v = this.view3d, P = store.project;
    const sel = $('#rPanoPos').value;
    if (sel === 'walk' || !sel) {
      const dir = new THREE.Vector3(); v.camera.getWorldDirection(dir);
      return { pos: v.camera.position.clone(), yaw: Math.atan2(-dir.x, -dir.z), label: '漫遊位置' };
    }
    const room = P.rooms.find((r) => `room:${r.id}` === sel);
    if (!room) return null;
    let [cx, cy] = polygonCentroid(room.points);
    if (!pointInPolygon(cx, cy, room.points)) { const r = largestInnerRect(room.points); cx = (r.x0 + r.x1) / 2; cy = (r.y0 + r.y1) / 2; }
    // 面向房間較長的方向
    const xs = room.points.map((p) => p[0]), ys = room.points.map((p) => p[1]);
    const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    const f = wide ? [1, 0] : [0, 1];
    return { pos: new THREE.Vector3(cx / 100, 1.5, cy / 100), yaw: Math.atan2(-f[0], -f[1]), label: room.name || '房間' };
  }

  // 顯示 360° 檢視（拖曳環顧）或切回平面圖片
  showPano(on) {
    const host = $('#renderHost');
    this.panoViewer?.dispose();
    this.panoViewer = null;
    const url = this.studio.toDataURL();
    if (!url) return;
    if (on) {
      const img = new Image();
      img.onload = () => {
        host.replaceChildren();
        host.classList.add('pano');
        this.panoViewer = mountPano(host, img, { yaw: this.lastPano?.yaw || 0 });
      };
      img.src = url;
      $('[data-render="toggle360"]').textContent = '平面圖片';
    } else {
      host.classList.remove('pano');
      const img = new Image(); img.src = url;
      host.replaceChildren(img);
      $('[data-render="toggle360"]').textContent = '360° 檢視';
    }
  }

  downloadPanoHTML() {
    const src = this.studio.toDataURL();
    if (!src || !this.lastPano) return;
    // 網頁內嵌 JPEG 以縮小檔案
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const html = panoViewerHTML(c.toDataURL('image/jpeg', 0.9), `${store.project.name} · ${this.lastPano.label}`, this.lastPano.yaw);
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      download(url, `${store.project.name}-360環景.html`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    img.src = src;
  }

  // 畫面底部的停靠面板（日照、燈光、風水）一次只開一個
  closeDocks(except) {
    for (const p of [this.sunPanel, this.lightPanel, this.fsPanel, this.clPanel]) if (p && p !== except && p.active) p.toggle(false);
  }
  anyDockOpen() { return [this.sunPanel, this.lightPanel, this.fsPanel, this.clPanel].some((p) => p?.active); }

  // 漫遊時點燈具：開燈 / 關燈（白天情境不開燈）
  toggleLamp(id) {
    const P = store.project;
    const L = lightingState(P);
    const it = P.items.find((x) => x.id === id);
    if (L.time === 'day') { toast('白天情境不開燈：按 3D 右上角的燈光按鈕選擇其他情境'); return; }
    const on = !((L.lamps.get(id) || 0) > 0);
    store.update((p) => tweakLighting(p, { lamps: { [id]: on ? 1 : 0 } }), 'settings');
    toast(`${on ? '開燈' : '關燈'}：${it?.name || '燈具'}`);
    if (this.lightPanel.active) this.lightPanel.render();
  }

  // ------------------------------------------------------------ 方案管理與對照
  // 目前 3D 畫面的縮圖（方案卡片用）
  variantThumb() {
    try {
      const src = this.view3d.canvas;
      if (!src.width || !src.height) return null;
      this.view3d.renderer.render(this.view3d.scene, this.view3d.camera);
      const c = document.createElement('canvas');
      c.width = 320; c.height = Math.round((320 * src.height) / src.width);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.75);
    } catch { return null; }
  }

  // 3D 畫面左上角的方案切換列（有兩個以上方案時顯示）
  renderVariantBar() {
    const P = store.project, bar = $('#variantBar');
    if (!bar) return;
    const list = P.variants || [];
    bar.hidden = list.length < 2;
    if (bar.hidden) return;
    bar.innerHTML = list.map((v) => `<button type="button" data-varsw="${v.id}" class="${v.id === P.activeVariant ? 'on' : ''}" title="切換到${esc(v.name)}">${esc(v.name)}</button>`).join('')
      + '<button type="button" data-action="variants" title="方案管理與對照">對照</button>';
    if (!this.varBarBound) {
      this.varBarBound = true;
      bar.addEventListener('click', (e) => {
        const id = e.target.closest('[data-varsw]')?.dataset.varsw;
        if (id) { switchVariant(id, this.variantThumb()); toast(`已切換到${store.project.variants.find((v) => v.id === id)?.name}`); }
      });
    }
  }

  openVariants() {
    const m = $('#variantModal');
    if (!this.varBound) {
      this.varBound = true;
      this.varView = 'persp';
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-var="close"]')) { m.hidden = true; return; }
        const b = e.target.closest('[data-var]');
        const vb = e.target.closest('[data-view]');
        if (vb) { this.varView = vb.dataset.view; for (const x of m.querySelectorAll('[data-view]')) x.classList.toggle('on', x === vb); this.renderWipe(); return; }
        if (!b) return;
        const id = b.dataset.id, a = b.dataset.var;
        if (a === 'add') { addVariant(null, this.variantThumb()); this.renderVariants(true); toast(`已新增${activeName()}，目前的修改會存在這個方案`); }
        else if (a === 'switch') { switchVariant(id, this.variantThumb()); this.renderVariants(); }
        else if (a === 'rename') { const v = store.project.variants.find((x) => x.id === id); const n = prompt('方案名稱', v?.name || ''); if (n) { renameVariant(id, n); this.renderVariants(); } }
        else if (a === 'delete') { const v = store.project.variants.find((x) => x.id === id); if (confirm(`刪除「${v?.name}」？此動作可用復原（Ctrl+Z）還原。`)) { deleteVariant(id); this.renderVariants(true); } }
      });
      for (const id of ['#varA', '#varB']) $(id).addEventListener('change', () => this.renderCompare());
      const activeName = () => store.project.variants.find((v) => v.id === store.project.activeVariant)?.name || '';
    }
    store.update((P) => ensureVariants(P), 'settings');
    // 目前方案的縮圖
    const cur = store.project.variants.find((v) => v.id === store.project.activeVariant);
    if (cur && !cur.thumb) cur.thumb = this.variantThumb();
    m.hidden = false;
    this.renderVariants(true);
  }

  // 方案的評估指標（預算、風水、動線）
  variantMetrics(v) {
    const data = variantData(v);
    const P = { ...store.project, ...data };
    const budget = computeBudget(P), fs = checkFengshui(P), cl = checkClearance(P);
    return { data, P, budget, fs, cl };
  }

  renderVariants(resetPick = false) {
    const P = store.project, list = P.variants || [];
    const fmt = (n) => Math.round(n).toLocaleString('zh-TW');
    this.varMetrics = new Map(list.map((v) => [v.id, this.variantMetrics(v)]));
    $('#varList').innerHTML = list.map((v) => {
      const mt = this.varMetrics.get(v.id), on = v.id === P.activeVariant;
      return `<div class="var-item ${on ? 'on' : ''}">
        ${v.thumb ? `<img src="${v.thumb}" alt="${esc(v.name)}">` : '<div class="var-noimg">尚無縮圖</div>'}
        <div class="var-info"><b>${esc(v.name)}</b>${on ? '（目前）' : ''}<br>
          ${esc(STYLE_NAME(mt.P.design.styleId))} · 家具 ${mt.P.items.length} 件<br>
          預算約 ${fmt(mt.budget.total / 10000)} 萬 · 風水 ${mt.fs.score} · 動線 ${mt.cl.score}</div>
        <div class="btn-row">
          ${on ? '' : `<button type="button" class="btn small primary" data-var="switch" data-id="${v.id}">切換到此方案</button>`}
          <button type="button" class="btn small" data-var="rename" data-id="${v.id}">改名</button>
          ${list.length > 1 ? `<button type="button" class="btn small" data-var="delete" data-id="${v.id}">刪除</button>` : ''}
        </div></div>`;
    }).join('') + '<button type="button" class="var-add" data-var="add">＋ 以目前設計新增方案<br><span class="hint">複製目前方案，再修改成另一種配置或風格</span></button>';
    const opts = list.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
    const a = $('#varA').value, b = $('#varB').value;
    $('#varA').innerHTML = opts; $('#varB').innerHTML = opts;
    const ids = list.map((v) => v.id);
    if (!resetPick && ids.includes(a) && ids.includes(b)) { $('#varA').value = a; $('#varB').value = b; }
    else if (ids.length >= 2) {
      // 預設依方案順序：第一個方案與目前方案（目前就是第一個時取第二個）
      const second = P.activeVariant !== ids[0] ? P.activeVariant : ids[1];
      $('#varA').value = ids[0]; $('#varB').value = second;
    }
    this.renderVariantBar();
    this.renderCompare();
  }

  // 以目前視角算出方案的透視圖與俯視圖（暫時套用方案內容，不影響專案）
  renderVariantImages(data) {
    const v = this.view3d, cam = v.camera;
    const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), target: v.controls.target.clone() };
    // 固定以 16:9 橫幅算圖，不受分割畫面中 3D 窗格寬窄影響
    v.renderer.setSize(1280, 720, false);
    cam.aspect = 16 / 9;
    cam.updateProjectionMatrix();
    const shot = () => { v.sync(); v.renderer.render(v.scene, cam); return v.canvas.toDataURL('image/jpeg', 0.88); };
    try {
      const persp = withVariant(data, shot);
      // 俯視：矮牆、正上方
      const top = withVariant({ ...data, settings: { ...data.settings, cutaway: true } }, () => {
        const mode = v.mode;
        if (mode === 'walk') v.mode = 'orbit';
        v.topView();
        // 依 16:9 畫面讓整個平面完整入鏡
        const b = projectBounds(store.project), t = Math.tan((cam.fov * Math.PI) / 360);
        const h = Math.max(((b.y1 - b.y0) * 0.01) / 2 / t, ((b.x1 - b.x0) * 0.01) / 2 / (t * cam.aspect)) * 1.12 + 1;
        cam.position.y = h;
        cam.lookAt(v.controls.target);
        cam.updateMatrixWorld();
        try { return shot(); } finally { v.mode = mode; }
      });
      return { persp, top };
    } finally {
      cam.position.copy(saved.pos); cam.quaternion.copy(saved.quat); v.controls.target.copy(saved.target);
      cam.updateMatrixWorld();
      v.resize();
      v.sync();
      v.needsSync = true;
      v.live.activity?.(true);
    }
  }

  renderCompare() {
    const list = store.project.variants || [];
    const A = list.find((v) => v.id === $('#varA').value), B = list.find((v) => v.id === $('#varB').value);
    if (list.length < 2 || !A || !B) {
      $('#varWipe').innerHTML = '<div class="render-empty">新增第二個方案後即可對照</div>';
      $('#varTable').innerHTML = '';
      return;
    }
    const mA = this.varMetrics.get(A.id), mB = this.varMetrics.get(B.id);
    this.varImgs = { A: this.renderVariantImages(mA.data), B: this.renderVariantImages(mB.data), nameA: A.name, nameB: B.name };
    this.renderWipe();
    // 指標對照：數字較好的標綠色
    const fmt = (n) => Math.round(n).toLocaleString('zh-TW');
    const row = (label, a, b, better = null, f = (x) => x) => {
      const cls = (x, y) => (better === null || x === y ? '' : (better === 'low' ? x < y : x > y) ? 'better' : '');
      return `<tr><th>${label}</th><td class="n ${cls(a, b)}">${f(a)}</td><td class="n ${cls(b, a)}">${f(b)}</td></tr>`;
    };
    const cats = [...new Set([...mA.budget.groups, ...mB.budget.groups].map((g) => g.name))];
    const sub = (m, n) => m.budget.groups.find((g) => g.name === n)?.subtotal || 0;
    $('#varTable').innerHTML = `<table>
      <colgroup><col class="var-col-label"><col><col></colgroup>
      <thead><tr><th>項目</th><th class="n">${esc(A.name)}</th><th class="n">${esc(B.name)}</th></tr></thead>
      <tbody>
        <tr><th>風格</th><td class="n">${esc(STYLE_NAME(mA.P.design.styleId))}</td><td class="n">${esc(STYLE_NAME(mB.P.design.styleId))}</td></tr>
        ${row('家具件數', mA.P.items.length, mB.P.items.length)}
        ${row('預算總計（元）', mA.budget.total, mB.budget.total, 'low', fmt)}
        ${row('每坪單價（元）', mA.budget.perPing, mB.budget.perPing, 'low', fmt)}
        ${cats.map((n) => row(`　${n}`, sub(mA, n), sub(mB, n), 'low', fmt)).join('')}
        ${row('風水分數', mA.fs.score, mB.fs.score, 'high')}
        ${row('動線健檢分數', mA.cl.score, mB.cl.score, 'high')}
        <tr><th>風水需注意</th><td class="n">${esc(mA.fs.findings.filter((f) => f.level === 'warn').map((f) => f.title).join('、') || '無')}</td><td class="n">${esc(mB.fs.findings.filter((f) => f.level === 'warn').map((f) => f.title).join('、') || '無')}</td></tr>
        <tr><th>動線需注意</th><td class="n">${mA.cl.findings.filter((f) => f.level === 'warn').length} 項</td><td class="n">${mB.cl.findings.filter((f) => f.level === 'warn').length} 項</td></tr>
      </tbody></table>
      <h4 style="margin:12px 0 0">主要差異</h4>
      <ul class="var-diffs">${this.variantDiffs(mA.P, mB.P, A.name, B.name).map((d) => `<li>${esc(d)}</li>`).join('') || '<li>兩個方案內容相同</li>'}</ul>`;
  }

  // 列出兩個方案的差異：風格、各房間地坪與牆面、家具增減
  variantDiffs(PA, PB, nA, nB) {
    const out = [];
    const matName = (id) => MATERIAL_MAP[id]?.name || id || '預設';
    if (PA.design.styleId !== PB.design.styleId) out.push(`風格：${nA}為${STYLE_NAME(PA.design.styleId)}，${nB}為${STYLE_NAME(PB.design.styleId)}`);
    for (const ra of PA.rooms) {
      const rb = PB.rooms.find((r) => r.id === ra.id);
      if (!rb) { out.push(`${ra.name}：只在${nA}`); continue; }
      if ((ra.floor || '') !== (rb.floor || '')) out.push(`${ra.name}地坪：${matName(ra.floor)} → ${matName(rb.floor)}`);
    }
    for (const rb of PB.rooms) if (!PA.rooms.some((r) => r.id === rb.id)) out.push(`${rb.name}：只在${nB}`);
    const wallMats = (P) => { const m = new Map(); for (const w of P.walls) for (const k of [w.matA, w.matB]) m.set(k || 'paint_white', (m.get(k || 'paint_white') || 0) + 1); return m; };
    const wa = wallMats(PA), wb = wallMats(PB);
    for (const k of new Set([...wa.keys(), ...wb.keys()])) if ((wa.get(k) || 0) !== (wb.get(k) || 0)) out.push(`牆面${matName(k)}：${wa.get(k) || 0} 面 → ${wb.get(k) || 0} 面`);
    const count = (P) => { const m = new Map(); for (const it of P.items) m.set(it.kind, (m.get(it.kind) || 0) + 1); return m; };
    const ca = count(PA), cb = count(PB);
    for (const k of new Set([...ca.keys(), ...cb.keys()])) {
      const a = ca.get(k) || 0, b = cb.get(k) || 0;
      if (a !== b) out.push(`${CATALOG_MAP[k]?.name || k}：${a} 件 → ${b} 件`);
    }
    // 同一件家具移動位置
    const moved = PA.items.filter((a) => { const b = PB.items.find((x) => x.id === a.id); return b && (Math.hypot(a.x - b.x, a.y - b.y) > 20 || (a.rot || 0) !== (b.rot || 0)); });
    if (moved.length) out.push(`移動或轉向的家具：${[...new Set(moved.map((x) => x.name || CATALOG_MAP[x.kind]?.name))].slice(0, 8).join('、')}${moved.length > 8 ? ' 等' : ''}`);
    return out;
  }

  // 滑桿左右比較：左邊方案 A、右邊方案 B
  renderWipe() {
    const I = this.varImgs;
    if (!I) return;
    const k = this.varView === 'top' ? 'top' : 'persp';
    const box = $('#varWipe');
    box.innerHTML = `<img src="${I.B[k]}" alt="${esc(I.nameB)}"><div class="var-top"><img src="${I.A[k]}" alt="${esc(I.nameA)}"></div>
      <div class="var-line"></div><span class="var-tag" style="left:8px">${esc(I.nameA)}</span><span class="var-tag" style="right:8px">${esc(I.nameB)}</span>
      <input type="range" min="0" max="100" value="50" aria-label="左右比較">`;
    const top = box.querySelector('.var-top'), line = box.querySelector('.var-line'), r = box.querySelector('input');
    const set = () => { top.style.clipPath = `inset(0 ${100 - r.value}% 0 0)`; line.style.left = `calc(${r.value}% - 1px)`; };
    r.addEventListener('input', set);
    set();
  }

  // ------------------------------------------------------------ 預算與材料清單
  openBudget() {
    const m = $('#budgetModal');
    if (!this.budgetBound) {
      this.budgetBound = true;
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-budget="close"]')) { m.hidden = true; return; }
        const a = e.target.closest('[data-budget]')?.dataset.budget;
        if (a === 'csv') download(URL.createObjectURL(new Blob([budgetCSV(store.project, this.budgetMode())], { type: 'text/csv' })), `${store.project.name || '室內設計'}-預算與材料清單${this.budgetMode() === 'room' ? '（依房間）' : ''}.csv`);
        else if (a === 'print') this.printBudget();
        else if (a === 'reset') { if (confirm('恢復所有預設單價？')) this.editBudget((B) => { B.prices = {}; }); }
        const reset = e.target.closest('[data-reset]');
        if (reset) this.editBudget((B) => { delete B.prices[reset.dataset.reset]; });
        const del = e.target.closest('[data-del-custom]');
        if (del) this.editBudget((B) => { B.custom = (B.custom || []).filter((c) => c.id !== del.dataset.delCustom); });
        if (a === 'add') this.addBudgetItem();
        const nb = e.target.closest('[data-note-toggle]');
        if (nb) { const k = nb.dataset.noteToggle; if (this.budgetOpen.has(k)) this.budgetOpen.delete(k); else this.budgetOpen.add(k); this.renderBudget(); }
        const ph = e.target.closest('[data-photo-del]');
        if (ph) { const [k, i] = [ph.dataset.photoDel, Number(ph.dataset.i)]; this.editNote(k, (n) => { n.photos.splice(i, 1); }); return; }
        const img = e.target.closest('.b-photos img');
        if (img) this.viewPhoto(img.src);
      });
      m.addEventListener('change', (e) => {
        const t = e.target;
        if (t.id === 'bTier') this.editBudget((B) => { B.tier = t.value; });
        else if (t.dataset.noteText) this.editNote(t.dataset.noteText, (n) => { n.text = t.value.trim().slice(0, 1000); });
        else if (t.dataset.notePhoto) { this.addNotePhotos(t.dataset.notePhoto, [...t.files]); t.value = ''; }
        else if (t.name === 'bMode') { try { localStorage.setItem('interior-studio:budget-mode', t.value); } catch { /* 無痕模式 */ } this.renderBudget(); }
        else if (t.id === 'bCeiling') this.editBudget((B) => { B.ceiling = t.checked; });
        else if (t.dataset.on) {
          const k = t.dataset.on;
          this.editBudget((B) => {
            if (k === 'ceiling') B.ceiling = t.checked;
            else if (k.startsWith('extra:')) B.extras[k.slice(6)] = t.checked;
            else if (t.checked) delete B.off[k]; else B.off[k] = true;
          });
        } else if (t.dataset.price || t.dataset.qty) {
          const k = t.dataset.price || t.dataset.qty, v = Math.max(0, Number(t.value));
          if (!Number.isFinite(v)) return;
          const custom = k.startsWith('custom:') && k.slice(7);
          this.editBudget((B) => {
            const c = custom && (B.custom || []).find((x) => x.id === custom);
            if (c) { if (t.dataset.qty) c.qty = Math.round(v * 100) / 100; else c.price = Math.round(v); }
            else B.prices[k] = Math.round(v);
          });
        }
      });
    }
    this.budgetOpen = this.budgetOpen || new Set();
    m.hidden = false;
    this.renderBudget();
  }

  // ---- 預算項目的備註與照片：存在 project.budgetNotes（各方案共用、不列入復原），依項目鍵對應
  noteOf(key) { return store.project.budgetNotes?.[key] || null; }

  // 項目名稱下方：備註按鈕與摘要
  budgetNoteCell(key) {
    const n = this.noteOf(key), open = this.budgetOpen?.has(key);
    const cnt = n?.photos?.length || 0;
    const label = n?.text || cnt ? `備註${cnt ? ` · ${cnt} 張照片` : ''}` : '＋ 備註 / 照片';
    return `<div class="b-note-sum"><button type="button" class="b-note-btn ${n?.text || cnt ? 'has' : ''}" data-note-toggle="${esc(key)}" aria-expanded="${open ? 'true' : 'false'}">${label} ${open ? '▴' : '▾'}</button>${n?.text && !open ? `<span class="b-note-text">${esc(n.text)}</span>` : ''}</div>`;
  }

  // 展開的備註列：文字、照片縮圖、加入照片
  budgetNoteRow(key) {
    if (!this.budgetOpen?.has(key)) return '';
    const n = this.noteOf(key) || {}, photos = n.photos || [];
    return `<tr class="b-note-row"><td></td><td colspan="5">
      <textarea data-note-text="${esc(key)}" rows="2" maxlength="1000" placeholder="例如：品牌型號、顏色、廠商報價、施工注意事項">${esc(n.text || '')}</textarea>
      <div class="b-photos">${photos.map((src, i) => `<figure><img src="${src}" alt="照片 ${i + 1}" title="點一下放大"><button type="button" class="icon-btn" data-photo-del="${esc(key)}" data-i="${i}" title="刪除照片">✕</button></figure>`).join('')}
        ${photos.length < NOTE_PHOTO_MAX ? `<label class="b-photo-add" title="加入照片（最多 ${NOTE_PHOTO_MAX} 張）">＋ 照片<input type="file" accept="image/*" multiple data-note-photo="${esc(key)}" hidden></label>` : ''}</div>
    </td></tr>`;
  }

  editNote(key, fn) {
    store.update((p) => {
      const all = { ...(p.budgetNotes || {}) };
      const n = { text: '', photos: [], ...(all[key] || {}) };
      n.photos = [...(n.photos || [])];
      fn(n);
      if (!n.text && !n.photos.length) delete all[key]; else all[key] = n;
      p.budgetNotes = all;
    }, 'settings');
    this.renderBudget();
  }

  async addNotePhotos(key, files) {
    const room = NOTE_PHOTO_MAX - (this.noteOf(key)?.photos?.length || 0);
    const list = files.filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, room));
    if (files.length > list.length) toast(`每個項目最多 ${NOTE_PHOTO_MAX} 張照片`);
    const out = [];
    for (const f of list) {
      try { out.push(await shrinkPhoto(f)); } catch { toast(`無法讀取「${f.name}」`); }
    }
    if (out.length) this.editNote(key, (n) => { n.photos.push(...out); });
  }

  viewPhoto(src) {
    const v = document.createElement('div');
    v.className = 'photo-view';
    v.innerHTML = `<img src="${src}" alt="照片"><button type="button" class="icon-btn" title="關閉">✕</button>`;
    v.addEventListener('click', () => v.remove());
    $('#budgetModal').append(v);
  }

  editBudget(fn) {
    store.update((p) => {
      const B = p.settings.budget || {};
      B.prices = B.prices || {}; B.extras = B.extras || {}; B.off = B.off || {};
      fn(B);
      p.settings.budget = B;
    }, 'settings');
    this.renderBudget();
  }

  // 清單顯示方式：依工程類別或依房間（瀏覽器偏好，不存在專案中）
  budgetMode() {
    try { return localStorage.getItem('interior-studio:budget-mode') === 'room' ? 'room' : 'group'; } catch { return 'group'; }
  }

  renderBudget() {
    const P = store.project, B = P.settings.budget || {};
    const r = computeBudget(P), mode = this.budgetMode();
    const sections = mode === 'room' ? r.rooms : r.groups;
    const fmt = (n) => Math.round(n).toLocaleString('zh-TW');
    const num = (q) => (Number.isInteger(q) ? q : q.toFixed(2));
    $('#budgetOpts').innerHTML = `
      <span class="seg budget-mode" role="radiogroup" aria-label="分組方式">
        <label><input type="radio" name="bMode" value="group" ${mode === 'group' ? 'checked' : ''}><span>依工程類別</span></label>
        <label><input type="radio" name="bMode" value="room" ${mode === 'room' ? 'checked' : ''}><span>依房間</span></label>
      </span>
      <label>價位等級 <select id="bTier">${Object.entries(TIERS).map(([k, t]) => `<option value="${k}" ${r.tier === k ? 'selected' : ''}>${t.name}</option>`).join('')}</select></label>
      <span class="hint">${mode === 'room'
        ? '依房間顯示時，同一個項目（例如同一種地板）分在各房間，勾選「做」或修改單價會套用到所有房間；水電、拆除等依全室坪數計價的工程列在「全室共用」。'
        : '取消勾選「做」的項目不列入總計；水電、拆除、設計監工等在「其他工程」中勾選，也可以在最下方新增自訂工程。'}</span>`;
    $('#budgetBody').innerHTML = `
      <table class="budget-table">
        <thead><tr><th class="b-on">做</th><th>項目</th><th class="n">數量</th><th>單位</th><th class="n">單價（元）</th><th class="n">小計（元）</th></tr></thead>
        ${sections.map((g) => `<tbody>
          <tr class="bg"><th colspan="5">${esc(g.name)}${mode === 'room' && r.total ? ` <span class="hint">${Math.round((g.subtotal / r.total) * 100)}%</span>` : ''}</th><th class="n">${fmt(g.subtotal)}</th></tr>
          ${g.lines.map((l) => `<tr class="${l.on ? '' : 'off'}">
            <td class="b-on"><input type="checkbox" data-on="${esc(l.key)}" ${l.on ? 'checked' : ''} aria-label="${esc(l.name)}要做" title="取消勾選表示不做，不列入總計"></td>
            <td>${esc(l.name)}${l.custom ? ` <button type="button" class="icon-btn" data-del-custom="${esc(l.key.slice(7))}" title="刪除這個自訂工程">✕</button>` : ''}${mode === 'room' ? `<div class="hint">${esc(l.group)}</div>` : l.details.length ? `<div class="hint">${esc(l.details.join('、'))}</div>` : ''}${this.budgetNoteCell(l.key)}</td>
            <td class="n">${l.custom ? `<input type="number" min="0" step="1" data-qty="${esc(l.key)}" value="${l.qty}" aria-label="${esc(l.name)}數量">` : num(l.qty)}${l.waste ? `<div class="hint">含損耗 ${Math.round(l.waste * 100)}%</div>` : ''}</td>
            <td>${esc(l.unit)}</td>
            <td class="n"><input type="number" min="0" step="100" data-price="${esc(l.key)}" value="${l.price}" aria-label="${esc(l.name)}單價">${Number.isFinite(B.prices?.[l.key]) ? `<button type="button" class="icon-btn" data-reset="${esc(l.key)}" title="恢復預設單價">↺</button>` : ''}</td>
            <td class="n">${l.on ? fmt(l.amount) : '不做'}</td></tr>${this.budgetNoteRow(l.key)}`).join('')}
        </tbody>`).join('')}
      </table>
      <div class="budget-add">
        <b>新增工程</b>
        <select id="bAddGroup" aria-label="類別">${GROUPS.map((g) => `<option ${g === '其他工程' ? 'selected' : ''}>${g}</option>`).join('')}</select>
        <input id="bAddName" placeholder="項目名稱，例如：系統衣櫃拉門" aria-label="項目名稱">
        <input id="bAddQty" type="number" min="0" step="1" value="1" aria-label="數量">
        <input id="bAddUnit" value="式" aria-label="單位">
        <input id="bAddPrice" type="number" min="0" step="100" placeholder="單價" aria-label="單價（元）">
        <button type="button" class="btn small primary" data-budget="add">新增</button>
      </div>`;
    $('#budgetTotal').innerHTML = `總計 <b>${fmt(r.total)}</b> 元 <span class="hint">室內約 ${r.area.toFixed(1)} 坪 · 每坪約 ${fmt(r.perPing)} 元</span>`;
  }

  addBudgetItem() {
    const name = $('#bAddName').value.trim();
    if (!name) { toast('請輸入項目名稱'); $('#bAddName').focus(); return; }
    const c = {
      id: uid('b'), group: $('#bAddGroup').value, name: name.slice(0, 40), unit: $('#bAddUnit').value.trim().slice(0, 6) || '式',
      qty: Math.max(0, Number($('#bAddQty').value) || 0), price: Math.max(0, Math.round(Number($('#bAddPrice').value) || 0)),
    };
    this.editBudget((B) => { B.custom = [...(B.custom || []), c]; });
    toast(`已新增「${c.name}」`);
  }

  // 列印報價單：先顯示報價單設定（分組方式、業主與報價單位資訊、稅金、分頁、照片、說明條款），再開新視窗列印
  printBudget() {
    const card = $('#budgetModal .budget-card');
    let el = $('#quotePanel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'quotePanel';
      el.className = 'quote-panel';
      card.append(el);
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-quote]')?.dataset.quote;
        if (a === 'cancel') el.hidden = true;
        else if (a === 'logo-del') { setQuoteLogo(''); this.saveQuoteForm(); this.printBudget(); }
        else if (a === 'print') { this.saveQuoteForm(); el.hidden = true; this.openQuote(el.querySelector('input[name=qMode]:checked').value); }
      });
      el.addEventListener('change', async (e) => {
        if (e.target.name === 'qMode') this.quoteMode = e.target.value;
        this.saveQuoteForm();
        const f = e.target.matches('[data-quote-logo]') && e.target.files[0];
        if (!f) return;
        try {
          setQuoteLogo(await shrinkLogo(f));
          this.printBudget();
        } catch (err) { toast(err.message || '無法讀取這張圖片'); }
      });
    }
    const o = quoteOptions(store.project), mode = this.quoteMode || this.budgetMode();
    const field = (k, label, ph = '') => `<label><span>${label}</span><input data-q="${k}" value="${esc(o[k])}" placeholder="${esc(ph)}"></label>`;
    el.innerHTML = `
      <div class="quote-box" role="dialog" aria-label="列印報價單">
        <h3>列印報價單</h3>
        <div class="quote-row"><span>分組方式</span>
          <span class="seg budget-mode">
            <label><input type="radio" name="qMode" value="room" ${mode === 'room' ? 'checked' : ''}><span>依房間</span></label>
            <label><input type="radio" name="qMode" value="group" ${mode === 'group' ? 'checked' : ''}><span>依工程類別</span></label>
          </span></div>
        <div class="quote-grid">
          ${field('client', '業主', '業主姓名或公司名稱')}
          <label><span>業主統一編號</span><input data-q="clientTaxId" value="${esc(o.clientTaxId)}" inputmode="numeric" maxlength="8" placeholder="業主為公司時填寫"></label>
          ${field('phone', '聯絡電話')}
          <label><span>業主電子郵件</span><input data-q="clientEmail" type="email" value="${esc(o.clientEmail)}" inputmode="email" autocomplete="off" placeholder="name@example.com"></label>
          ${field('site', '案場地址')}${field('company', '報價單位', '公司或工作室名稱')}
          <label><span>公司統一編號</span><input data-q="taxId" value="${esc(o.taxId)}" inputmode="numeric" maxlength="8" placeholder="8 碼數字"></label>
          ${field('companyAddr', '公司地址')}
          <label><span>公司電話</span><input data-q="companyPhone" type="tel" value="${esc(o.companyPhone)}" placeholder="02-1234-5678"></label>
          <label><span>手機</span><input data-q="companyMobile" type="tel" value="${esc(o.companyMobile)}" placeholder="0912-345-678"></label>
          ${field('lineId', 'LINE ID')}${field('wechat', 'WeChat ID')}
          <div class="quote-logo"><span>公司 Logo</span>
            <div>${quoteLogo() ? `<img src="${quoteLogo()}" alt="公司 Logo">` : '<em>尚未設定</em>'}
              <label class="btn small">${quoteLogo() ? '更換' : '上傳'}<input type="file" accept="image/*" data-quote-logo hidden></label>
              ${quoteLogo() ? '<button type="button" class="btn small" data-quote="logo-del">移除</button>' : ''}</div>
            <small class="hint">存在這個瀏覽器中，所有專案的報價單共用</small></div>
          ${field('contact', '報價人')}
          <label><span>有效天數</span><input data-q="validDays" type="number" min="1" max="365" value="${esc(o.validDays)}"></label>
        </div>
        <div class="quote-row checks">
          <label class="check"><input type="checkbox" data-q="tax" ${o.tax ? 'checked' : ''}> 加計營業稅 5%</label>
          <label class="check"><input type="checkbox" data-q="pageBreak" ${o.pageBreak ? 'checked' : ''}> 每個房間 / 類別從新的一頁開始</label>
          <label class="check"><input type="checkbox" data-q="photos" ${o.photos ? 'checked' : ''}> 附上備註照片</label>
        </div>
        <label class="quote-terms"><span>報價說明（付款方式、注意事項）</span><textarea data-q="terms" rows="4">${esc(o.terms)}</textarea></label>
        <div class="quote-foot">
          <button type="button" class="btn" data-quote="cancel">取消</button>
          <button type="button" class="btn primary" data-quote="print">列印報價單</button>
        </div>
      </div>`;
    el.hidden = false;
  }

  saveQuoteForm() {
    const el = $('#quotePanel');
    if (!el) return;
    const q = {};
    for (const i of el.querySelectorAll('[data-q]')) {
      const k = i.dataset.q;
      q[k] = i.type === 'checkbox' ? i.checked : k === 'validDays' ? Math.min(365, Math.max(1, Number(i.value) || 30)) : i.value.trim().slice(0, k === 'terms' ? 2000 : k === 'taxId' || k === 'clientTaxId' ? 8 : k === 'clientEmail' ? 120 : 80);
    }
    store.update((p) => { p.settings.budget = { ...(p.settings.budget || {}), quote: q }; }, 'settings');
    // 統一編號格式或檢查碼不符時提醒（仍照填寫內容儲存）
    for (const k of ['taxId', 'clientTaxId']) {
      const tax = el.querySelector(`[data-q=${k}]`);
      const bad = !!q[k] && !validTaxId(q[k]);
      tax.classList.toggle('invalid', bad);
      tax.title = bad ? '統一編號應為 8 碼數字，且檢查碼需正確，請再確認' : '';
    }
    const mail = el.querySelector('[data-q=clientEmail]'), badMail = !!q.clientEmail && !validEmail(q.clientEmail);
    mail.classList.toggle('invalid', badMail);
    mail.title = badMail ? '電子郵件格式不正確，請再確認' : '';
  }

  openQuote(mode) {
    const P = store.project;
    const html = quoteHTML(P, computeBudget(P), mode, P.budgetNotes || {}, quoteLogo());
    const w = window.open('', '_blank');
    if (!w) { toast('瀏覽器擋住了列印視窗，請允許彈出視窗後再試'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  }

  // ------------------------------------------------------------ 分享連結與 QR code
  // 開啟別人分享的設計：唯讀檢視（不自動存檔），可選擇存成自己的專案
  async openSharedFromUrl() {
    if (!/#share=|[?&]g=/.test(location.href)) return;
    if (/[?&]g=/.test(location.search)) toast('正在讀取分享的設計…');
    let shared;
    try { shared = await readShareFromUrl(); } catch (err) { toast(`無法開啟分享的設計：${err.message}`); return; }
    if (!shared) return;
    store.readOnly = true;
    store.load(shared.project);
    this.afterLoad();
    this.renderProps(); this.renderRoomTypes();
    $('#shareName').textContent = `「${shared.project.name || '未命名'}」`;
    $('#shareBanner').hidden = false;
    if (this.isMobileLayout()) this.setView('3d');
  }

  keepShared() {
    if (!confirm('存成我的專案會取代這個瀏覽器中自動存檔的設計。\n若原本的設計還需要，請先回到我的專案，用「檔案 → 儲存專案檔」備份。\n\n確定要存成我的專案嗎？')) return;
    store.readOnly = false;
    store.saveLocal();
    history.replaceState(null, '', siteUrl());
    $('#shareBanner').hidden = true;
    toast('已存成您的專案，之後的修改會自動存檔');
  }

  async openShare() {
    const m = $('#shareModal');
    if (!this.shareBound) {
      this.shareBound = true;
      m.addEventListener('click', (e) => {
        if (e.target === m) { m.hidden = true; return; }
        const a = e.target.closest('[data-share]')?.dataset.share;
        if (!a) return;
        if (a === 'close') m.hidden = true;
        else if (a === 'copyLong') this.copyText($('#shareLong').value);
        else if (a === 'copyShort') this.copyText($('#shareShort').value);
        else if (a === 'sysLong') this.systemShare($('#shareLong').value);
        else if (a === 'sysShort') this.systemShare($('#shareShort').value);
        else if (a === 'saveToken') {
          const t = $('#shareToken').value.trim();
          if (!/^(ghp_|github_pat_|gho_)[A-Za-z0-9_]{20,}$/.test(t)) { toast('權杖格式不正確，應為 ghp_ 或 github_pat_ 開頭'); return; }
          setGithubToken(t); $('#shareToken').value = '';
          this.syncShareToken();
          toast('已儲存 GitHub 權杖');
        } else if (a === 'clearToken') { setGithubToken(''); this.syncShareToken(); toast('已移除 GitHub 權杖'); }
        else if (a === 'makeShort') this.makeShortLink(e.target.closest('button'));
        else if (a === 'dlQr' && this.shareQr) {
          const c = this.qrImage(this.shareQr.url);
          download(c.toDataURL('image/png'), `${store.project.name || '室內設計'}-QR.png`);
        }
      });
    }
    m.hidden = false;
    this.syncShareToken();
    $('#shareShortRow').hidden = true;
    $('#shareLong').value = '產生中…';
    const url = await longLink(store.project);
    $('#shareLong').value = url;
    const canShare = !!navigator.share;
    m.querySelector('[data-share="sysLong"]').hidden = !canShare;
    m.querySelector('[data-share="sysShort"]').hidden = !canShare;
    // 長網址夠短時直接做成 QR code（版本 20 以內，手機才掃得出來）
    const qr = makeQR(url, 'L');
    const fits = qr && qr.version <= 20;
    $('#shareLongInfo').textContent = `網址長度 ${url.length.toLocaleString()} 字元${fits ? '，可直接做成 QR code。' : '，太長做不成 QR code，請改用下方的短網址。'}`;
    this.showShareQr(fits ? { url, qr, note: '掃描開啟分享連結' } : null);
  }

  syncShareToken() {
    const has = !!getGithubToken();
    $('#shareSetup').hidden = has;
    $('#shareReady').hidden = !has;
  }

  async makeShortLink(btn) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '產生中…';
    try {
      const { url } = await shortLink(store.project);
      $('#shareShort').value = url;
      $('#shareShortRow').hidden = false;
      this.showShareQr({ url, qr: makeQR(url, 'M'), note: '掃描開啟分享的設計（短網址）' });
      toast('已產生短網址與 QR code');
    } catch (err) {
      toast(`無法產生短網址：${err.message}`);
      if (/權杖/.test(err.message) && /無效|過期/.test(err.message)) { setGithubToken(''); this.syncShareToken(); }
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  showShareQr(s) {
    this.shareQr = s;
    const box = $('#shareQr');
    $('#shareModal').querySelector('[data-share="dlQr"]').disabled = !s;
    if (!s) {
      box.textContent = '設計資料較多，請產生短網址後再顯示 QR code';
      $('#shareQrInfo').textContent = '';
      return;
    }
    box.replaceChildren(qrToCanvas(s.qr, 6));
    $('#shareQrInfo').textContent = s.note;
  }

  // 下載用的 QR code 圖片：QR code 加上專案名稱與說明
  qrImage(url) {
    const qr = makeQR(url, url.length < 200 ? 'M' : 'L');
    const q = qrToCanvas(qr, Math.max(4, Math.round(480 / (qr.size + 8))));
    const c = document.createElement('canvas');
    c.width = q.width + 40; c.height = q.height + 110;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(q, 20, 20);
    ctx.fillStyle = '#111'; ctx.textAlign = 'center';
    const font = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
    ctx.font = `700 26px ${font}`;
    ctx.fillText(store.project.name || '室內設計', c.width / 2, q.height + 58, c.width - 30);
    ctx.font = `400 16px ${font}`; ctx.fillStyle = '#555';
    ctx.fillText('手機掃描即可查看 2D、3D 與漫遊', c.width / 2, q.height + 88, c.width - 30);
    return c;
  }

  // ------------------------------------------------------------ 手機 AR 擺放家具
  // ids：預先勾選的家具（從屬性面板開啟時為選取的家具）
  openAR(ids, { outline } = {}) {
    const m = $('#arModal');
    if (!this.arBound) {
      this.arBound = true;
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-ar="close"]')) { m.hidden = true; return; }
        const a = e.target.closest('[data-ar]')?.dataset.ar;
        if (a === 'copy') this.copyText($('#arUrl').value);
        else if (a === 'open' && $('#arUrl').value) window.open($('#arUrl').value, '_blank', 'noopener');
        else if (a === 'none') { this.arPick.clear(); this.renderARPick(); this.updateARLink(); }
        const room = e.target.closest('[data-ar-room]');
        if (room) {
          const list = this.arRooms.get(room.dataset.arRoom) || [];
          const all = list.every((it) => this.arPick.has(it.id));
          for (const it of list) { if (all) this.arPick.delete(it.id); else this.arPick.add(it.id); }
          this.renderARPick(); this.updateARLink();
        }
      });
      m.addEventListener('change', (e) => {
        if (e.target.id === 'arOutline') { this.updateARLink(); return; }
        const id = e.target.dataset.arItem;
        if (!id) return;
        if (e.target.checked) this.arPick.add(id); else this.arPick.delete(id);
        this.renderARPick(); this.updateARLink();
      });
    }
    const sel = store.selection?.type === 'item' ? [store.selection.id] : [];
    this.arPick = new Set((ids || sel).filter((id) => store.find('item', id)));
    if (outline !== undefined) $('#arOutline').checked = outline;
    m.hidden = false;
    this.renderARPick();
    this.updateARLink();
  }

  renderARPick() {
    const P = store.project;
    const rooms = new Map();
    for (const it of P.items) {
      if (!CATALOG_MAP[it.kind]) continue;
      const r = P.rooms.find((x) => pointInPolygon(it.x, it.y, x.points));
      const k = r ? r.name : '其他';
      if (!rooms.has(k)) rooms.set(k, []);
      rooms.get(k).push(it);
    }
    this.arRooms = rooms;
    $('#arPick').innerHTML = P.items.length ? [...rooms].map(([name, list]) => {
      const on = list.filter((it) => this.arPick.has(it.id)).length;
      return `<div class="ar-room"><div class="ar-room-head"><b>${esc(name)}</b><button type="button" class="btn small" data-ar-room="${esc(name)}">${on === list.length ? '取消整間' : '整間勾選'}</button></div>
        ${list.map((it) => `<label class="ar-row"><input type="checkbox" data-ar-item="${it.id}" ${this.arPick.has(it.id) ? 'checked' : ''}> ${esc(it.name || CATALOG_MAP[it.kind].name)} <span class="hint">${Math.round(it.w)}×${Math.round(it.d)}×${Math.round(it.h)}</span></label>`).join('')}</div>`;
    }).join('') : '<p class="hint">平面圖中還沒有家具。</p>';
  }

  async updateARLink() {
    const token = (this.arToken = (this.arToken || 0) + 1);
    const items = store.project.items.filter((it) => this.arPick.has(it.id));
    const box = $('#arQr');
    if (!items.length) {
      box.textContent = '請在左側勾選家具'; $('#arUrl').value = ''; $('#arQrInfo').textContent = '';
      return;
    }
    // 勾選「附上房間地板範圍」時，帶入選取家具所在的房間輪廓
    const P = store.project;
    const rooms = $('#arOutline').checked ? P.rooms.filter((r) => r.points.length >= 3 && items.some((it) => pointInPolygon(it.x, it.y, r.points))) : [];
    const url = await arLink(arPayload(items, { styleId: P.design.styleId, name: P.name || '', rooms }));
    if (token !== this.arToken) return;
    $('#arUrl').value = url;
    const qr = makeQR(url, url.length < 600 ? 'M' : 'L');
    if (!qr) {
      box.textContent = '勾選的家具太多，網址放不進 QR code，請減少件數，或複製連結傳到手機開啟';
      $('#arQrInfo').textContent = `已選 ${items.length} 件`;
      return;
    }
    box.replaceChildren(qrToCanvas(qr, 6));
    $('#arQrInfo').textContent = `已選 ${items.length} 件${rooms.length ? `，含 ${rooms.map((r) => r.name).join('、')}地板範圍` : ''} · 用手機相機掃描`;
  }

  async copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('已複製連結'); } catch {
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); toast('已複製連結'); } catch { toast('無法自動複製，請手動選取網址複製'); }
      t.remove();
    }
  }

  async systemShare(url) {
    try { await navigator.share({ title: store.project.name || '室內設計', text: '用 Interior Studio 查看這個室內設計', url }); } catch (err) {
      if (err?.name !== 'AbortError') toast(`無法分享：${err?.message || err}`);
    }
  }

  // 導覽影片：規劃路線、錄製、預覽、下載與分享
  openTour() {
    if (this.view3d.vr.active) { toast('請先離開 VR 再錄製導覽影片'); return; }
    if (this.studio?.running) { toast('寫實渲染進行中，請等渲染完成再錄製'); return; }
    if (!tourSteps(store.project).length) { toast('平面圖中還沒有房間，請先畫出房間（或載入範例）'); return; }
    const m = $('#tourModal');
    if (!this.tourBound) {
      this.tourBound = true;
      m.addEventListener('click', (e) => {
        if (e.target === m) { this.closeTour(); return; }
        const a = e.target.closest('[data-tour]')?.dataset.tour;
        if (a === 'close') this.closeTour();
        else if (a === 'start') this.startTour();
        else if (a === 'stop') this.tour?.stop(false);
        else if (a === 'download' && this.tourVideo) download(this.tourVideo.url, this.tourVideo.name);
        else if (a === 'share' && this.tourVideo) this.shareTour();
      });
      for (const id of ['#tAspect', '#tPace']) $(id).addEventListener('change', () => this.tourSummary());
      this.bindTourRoute();
    }
    if (!pickMime()) $('#tourStatus').textContent = '此瀏覽器不支援錄影，只能預覽運鏡；請改用 Chrome、Edge 或 Safari';
    m.hidden = false;
    this.tourRoute();
  }

  tourSize() {
    const q = Number($('#tQuality').value);
    const [a, b] = $('#tAspect').value.split(':').map(Number);
    // 寬高取偶數（影片編碼需要）
    const even = (x) => Math.round(x / 2) * 2;
    return a >= b ? { width: even((q * a) / b), height: q } : { width: q, height: even((q * b) / a) };
  }

  // 走訪順序（可編輯）：調整順序、略過、新增站點；每一站可設定視角（自動 / 朝向家具門窗 / 擷取 3D 視角）、
  // 左右轉向、停留時間、字幕名稱與要特別注意的細節，並可預覽該站畫面
  tourRoute(reset = false) {
    this.tourList = tourSteps(store.project, { reset });
    const rooms = store.project.rooms.filter((r) => this.tourList.some((st) => st.room === r.id));
    const count = (room) => this.tourList.filter((st) => st.room === room).length;
    const L = this.tourList;
    $('#tourRoute').innerHTML = `
      <div class="tr-top"><span id="tourLen">走訪順序</span><button type="button" class="btn small" data-tr="reset" title="恢復自動排列的順序，並清除新增的站點、視角與描述">重設</button></div>
      <ol class="tr-list">${L.map((st, i) => {
        const room = store.project.rooms.find((r) => r.id === st.room);
        const targets = room ? viewTargets(room) : [];
        const v = st.view;
        const opt = (val, label) => `<option value="${esc(val)}" ${(v.mode === 'face' ? `face:${v.target}` : v.mode) === val ? 'selected' : ''}>${esc(label)}</option>`;
        return `
        <li data-i="${i}" class="${st.skip ? 'skip' : ''}">
          <div class="tr-head">
            <label class="check"><input type="checkbox" data-tr="use" ${st.skip ? '' : 'checked'}> <b>${esc(st.title || st.name)}</b>${st.title ? ` <small>${esc(st.name)}</small>` : ''}</label>
            <span class="tr-move">
              <button type="button" class="icon-btn" data-tr="up" title="往前移" ${i ? '' : 'disabled'}>↑</button>
              <button type="button" class="icon-btn" data-tr="down" title="往後移" ${i < L.length - 1 ? '' : 'disabled'}>↓</button>
              ${count(st.room) > 1 ? '<button type="button" class="icon-btn" data-tr="del" title="刪除這一站">✕</button>' : ''}
            </span>
          </div>
          <div class="tr-body" ${st.skip ? 'hidden' : ''}>
            <div class="tr-row"><label>視角</label><select data-tr="mode">${opt('auto', '自動')}${targets.map((t) => opt(`face:${t.id}`, `朝向：${t.name}`)).join('')}${v.cam ? opt('custom', '自訂（擷取的 3D 視角）') : ''}</select>
              <button type="button" class="btn small" data-tr="cap" title="使用目前 3D 畫面的位置與方向">擷取 3D</button></div>
            <div class="tr-row"><label>轉向</label><input type="range" data-tr="turn" min="-180" max="180" step="5" value="${v.turn}" title="鏡頭往左（負）或往右（正）轉"><span class="tr-turn">${v.turn > 0 ? '右 ' : v.turn < 0 ? '左 ' : ''}${Math.abs(v.turn)}°</span>
              <button type="button" class="btn small" data-tr="prev" title="在右側預覽這一站的畫面">預覽</button></div>
            <div class="tr-row"><label>停留</label><select data-tr="hold">${[[0, '標準'], [3, '多 3 秒'], [6, '多 6 秒'], [10, '多 10 秒']].map(([n, t]) => `<option value="${n}" ${st.hold === n ? 'selected' : ''}>${t}</option>`).join('')}</select>
              <input type="text" data-tr="title" value="${esc(st.title)}" placeholder="字幕名稱（預設：${esc(st.name)}）" maxlength="20"></div>
            <textarea rows="1" data-tr="note" placeholder="特別注意的細節（選填），例：窗邊的貴妃椅">${esc(st.note)}</textarea>
          </div>
          <div class="tr-hint"></div>
        </li>`;
      }).join('')}</ol>
      <div class="tr-add"><select data-tr="addroom">${rooms.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select><button type="button" class="btn small" data-tr="add" title="新增一站，同一個房間可以有多站（例如客廳、餐廳各一站）">＋ 新增一站</button></div>`;
    this.tourSummary();
  }

  bindTourRoute() {
    const box = $('#tourRoute');
    const idx = (el) => Number(el.closest('li')?.dataset.i);
    const step = (el) => this.tourList[idx(el)];
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tr]');
      if (!b) return;
      const a = b.dataset.tr, L = this.tourList;
      if (a === 'reset') { store.update((p) => { delete p.settings.tour; }, 'tour'); this.tourRoute(true); return; }
      if (a === 'add') {
        const room = box.querySelector('[data-tr="addroom"]').value;
        const base = L.find((st) => st.room === room);
        const at = L.map((st) => st.room).lastIndexOf(room) + 1;
        L.splice(at, 0, { id: `${room}~${Date.now().toString(36)}`, room, skip: false, note: '', title: '', view: { mode: 'auto', target: null, turn: 0, cam: null }, hold: 0, name: base.name });
        this.saveTourSteps(); this.tourRoute();
        box.querySelector(`li[data-i="${at}"]`)?.scrollIntoView({ block: 'nearest' });
        return;
      }
      const i = idx(b), st = L[i];
      if (a === 'up' || a === 'down') {
        const j = i + (a === 'up' ? -1 : 1);
        if (j < 0 || j >= L.length) return;
        [L[i], L[j]] = [L[j], L[i]];
        this.saveTourSteps(); this.tourRoute();
        box.querySelector(`li[data-i="${j}"] [data-tr="${a}"]`)?.focus();
      } else if (a === 'del') {
        L.splice(i, 1);
        this.saveTourSteps(); this.tourRoute();
      } else if (a === 'cap') {
        const cam = this.view3d.camera, d = new THREE.Vector3();
        cam.getWorldDirection(d);
        st.view = { ...st.view, mode: 'custom', turn: 0, cam: { x: cam.position.x * 100, y: cam.position.z * 100, h: cam.position.y, yaw: Math.atan2(d.x, -d.z), pitch: Math.asin(Math.max(-1, Math.min(1, d.y))) } };
        this.saveTourSteps(); this.tourRoute();
        this.previewTourStep(st.id);
        toast('已擷取目前 3D 畫面的視角。要換角度：關閉此視窗，在 3D 畫面（建議按「漫遊」走到想要的位置）轉好方向，再回來按「擷取 3D」');
      } else if (a === 'prev') this.previewTourStep(st.id);
    });
    box.addEventListener('change', (e) => {
      const t = e.target.dataset.tr;
      if (!t || t === 'addroom') return;
      const st = step(e.target), li = e.target.closest('li');
      if (t === 'use') {
        st.skip = !e.target.checked;
        li.classList.toggle('skip', st.skip);
        li.querySelector('.tr-body').hidden = st.skip;
      } else if (t === 'mode') {
        const v = e.target.value;
        st.view = { ...st.view, mode: v.startsWith('face:') ? 'face' : v, target: v.startsWith('face:') ? v.slice(5) : st.view.target };
        this.previewTourStep(st.id);
      } else if (t === 'hold') st.hold = Number(e.target.value);
      else if (t === 'turn') this.previewTourStep(st.id);
      else return;
      this.saveTourSteps(); this.tourSummary();
    });
    box.addEventListener('input', (e) => {
      const t = e.target.dataset.tr;
      if (t === 'turn') {
        const st = step(e.target), n = Number(e.target.value);
        st.view = { ...st.view, turn: n };
        e.target.nextElementSibling.textContent = `${n > 0 ? '右 ' : n < 0 ? '左 ' : ''}${Math.abs(n)}°`;
        // 拖曳時延遲預覽，放開後立即更新
        clearTimeout(this.tourPrevT);
        this.tourPrevT = setTimeout(() => this.previewTourStep(st.id), 250);
        return;
      }
      if (t !== 'note' && t !== 'title') return;
      const st = step(e.target);
      st[t] = e.target.value;
      if (t === 'title') e.target.closest('li').querySelector('.tr-head b').textContent = st.title || st.name;
      // 輸入時延遲存檔與重算，避免每個字都重建
      clearTimeout(this.tourNoteT);
      this.tourNoteT = setTimeout(() => { this.saveTourSteps(); this.tourSummary(); }, 350);
    });
  }

  saveTourSteps() {
    const steps = this.tourList.map(({ id, room, skip, note, title, view, hold }) => ({ id, room, skip, note, title, view, hold }));
    store.update((p) => { p.settings.tour = { steps }; }, 'tour');
  }

  // 在右側預覽區顯示某一站的畫面
  previewTourStep(id) {
    if (this.tour) return;
    const { width, height } = this.tourSize();
    // 預覽用較小的解析度，速度較快
    const k = Math.min(1, 640 / Math.max(width, height));
    const urls = previewStop(this.view3d, { width: Math.round(width * k / 2) * 2, height: Math.round(height * k / 2) * 2, pace: Number($('#tPace').value), captions: $('#tCaptions').checked, steps: this.tourList }, id);
    if (!urls) { toast('這一站目前不會拍攝（已略過）'); return; }
    // 大圖為中段，下方三格為開始、中段、結束，點小圖可放大
    const big = new Image();
    big.src = urls[1]; big.alt = '預覽';
    const strip = document.createElement('div');
    strip.className = 'tour-strip';
    ['開始', '中段', '結束'].forEach((label, n) => {
      const f = document.createElement('figure');
      f.innerHTML = `<img src="${urls[n]}" alt="${label}"><figcaption>${label}</figcaption>`;
      f.classList.toggle('on', n === 1);
      f.addEventListener('click', () => { big.src = urls[n]; for (const x of strip.children) x.classList.toggle('on', x === f); });
      strip.appendChild(f);
    });
    const wrap = document.createElement('div');
    wrap.className = 'tour-preview';
    wrap.append(big, strip);
    $('#tourHost').replaceChildren(wrap);
    const st = this.tourList.find((x) => x.id === id);
    $('#tourStatus').textContent = `預覽：${st ? st.title || st.name : ''}（點下方小圖切換開始、中段、結束）`;
    if (this.isMobileLayout()) $('#tourHost').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    for (const li of $('#tourRoute').querySelectorAll('li[data-i]')) li.classList.toggle('previewing', this.tourList[Number(li.dataset.i)]?.id === id);
  }

  // 預估長度、每一站會怎麼拍（特寫哪些對象、哪些文字以字幕顯示、是否淡出切換）
  tourSummary() {
    if (!this.tourList) return;
    const { width, height } = this.tourSize();
    const plan = planTour(store.project, { aspect: width / height, pace: Number($('#tPace').value), steps: this.tourList });
    $('#tourLen').textContent = plan ? `走訪順序（${plan.order.length} 站，約 ${Math.round(plan.duration)} 秒）` : '走訪順序（請至少勾選一站）';
    const stops = new Map((plan?.order || []).map((o, k) => [o.id, { ...o, first: k === 0 }]));
    for (const li of $('#tourRoute').querySelectorAll('li[data-i]')) {
      const st = this.tourList[Number(li.dataset.i)];
      const o = stops.get(st.id);
      const hint = li.querySelector('.tr-hint');
      if (!o) { hint.textContent = '不停留（需要時只會穿過）'; continue; }
      const parts = [];
      if (!o.first && !o.via && !o.same) parts.push('從上一站淡出切換');
      if (o.same) parts.push('在同一個房間移動過來');
      if (st.view.mode === 'face') parts.push(`朝向${li.querySelector('[data-tr="mode"]').selectedOptions[0]?.textContent.replace('朝向：', '') || '指定對象'}`);
      if (st.view.mode === 'custom') parts.push('自訂視角');
      if (st.view.turn) parts.push(`${st.view.turn > 0 ? '右' : '左'}轉 ${Math.abs(st.view.turn)}°`);
      if (st.hold) parts.push(`多停留 ${st.hold} 秒`);
      if (o.shotDetails.length) parts.push(`特寫：${o.shotDetails.join('、')}`);
      if (o.shotTexts.length) parts.push(`字幕：${o.shotTexts.join('，')}`);
      if (!st.note.trim() && st.view.mode === 'auto' && !st.view.turn) parts.push('照原設計運鏡');
      hint.textContent = parts.join(' · ');
    }
  }

  tourButtons(running) {
    const m = $('#tourModal');
    m.querySelector('[data-tour="stop"]').disabled = !running;
    m.querySelector('[data-tour="start"]').disabled = running;
    m.querySelector('[data-tour="download"]').disabled = running || !this.tourVideo;
    const share = m.querySelector('[data-tour="share"]');
    share.hidden = !this.tourVideo?.file || !navigator.canShare?.({ files: [this.tourVideo.file] });
    share.disabled = running;
    for (const el of m.querySelectorAll('.render-opts select, .render-opts input, .render-opts textarea, .tour-route button')) el.disabled = running;
    if (!running) this.tourRoute();
  }

  async startTour() {
    if (this.tour || this.tourStarting) return;
    const { width, height } = this.tourSize();
    const host = $('#tourHost');
    this.tourStarting = true;
    const encoder = await pickEncoder(width, height).catch(() => null);
    this.tourStarting = false;
    if ($('#tourModal').hidden) return;
    const record = !!encoder || !!pickMime();
    if (this.tourVideo) { URL.revokeObjectURL(this.tourVideo.url); this.tourVideo = null; }
    const player = new TourPlayer(this.view3d, {
      width, height, record, encoder,
      pace: Number($('#tPace').value), captions: $('#tCaptions').checked, openDoors: $('#tDoors').checked,
      onProgress: (p, shot, t, total) => {
        $('#tourBar').style.width = `${(p * 100).toFixed(1)}%`;
        $('#tourPct').textContent = `${Math.round(p * 100)}%`;
        $('#tourTime').textContent = `${fmtClock(t)} / ${fmtClock(total)}`;
        const label = shot.kind === 'walk' ? '穿過門口' : shot.title ? (shot.outro ? '片尾空拍' : '片頭空拍') : shot.caption;
        const speed = encoder && this.tourT0 ? ` · 製作速度 ${(t / ((performance.now() - this.tourT0) / 1000)).toFixed(1)} 倍` : '';
        $('#tourStatus').textContent = `${encoder ? '製作中' : record ? '錄製中' : '預覽中'}：${label}${speed}`;
      },
      onDone: ({ blob, mime, completed, error }) => {
        this.tour = null;
        if (error) toast(`影片編碼失敗：${error.message || error}`);
        $('#tourBarWrap').classList.toggle('done', completed);
        if (blob && completed) {
          const ext = mime.includes('mp4') ? 'mp4' : 'webm';
          const name = `${store.project.name || '室內設計'}-導覽影片.${ext}`;
          const url = URL.createObjectURL(blob);
          let file = null;
          try { file = new File([blob], name, { type: blob.type }); } catch { /* 舊版瀏覽器沒有 File 建構子 */ }
          this.tourVideo = { url, name, file };
          const video = document.createElement('video');
          video.src = url; video.controls = true; video.playsInline = true; video.loop = true;
          host.replaceChildren(video);
          $('#tourStatus').textContent = `完成：${(blob.size / 1048576).toFixed(1)} MB · ${ext.toUpperCase()}`;
        } else {
          host.replaceChildren(Object.assign(document.createElement('div'), { className: 'render-empty', textContent: completed ? '預覽完成（此瀏覽器不支援錄影）' : error ? '影片編碼失敗' : '已停止錄製' }));
          $('#tourStatus').textContent = completed ? '預覽完成' : error ? '編碼失敗' : '已停止';
        }
        this.tourButtons(false);
      },
    });
    if (!player.ok) { toast('請在走訪順序中至少勾選一個要拍攝的空間'); return; }
    this.tour = player;
    $('#tourBarWrap').classList.remove('done');
    host.replaceChildren(player.canvas);
    this.tourButtons(true);
    this.tourT0 = performance.now();
    player.start();
  }

  async shareTour() {
    const v = this.tourVideo;
    try {
      await navigator.share({ files: [v.file], title: v.name });
    } catch (err) {
      if (err?.name !== 'AbortError') toast(`無法分享：${err?.message || err}，請改用「下載影片」`);
    }
  }

  closeTour() {
    this.tour?.stop(false);
    $('#tourModal').hidden = true;
  }

  closeRender() {
    this.studio?.stop();
    this.panoViewer?.dispose(); this.panoViewer = null;
    this.renderTitle(null);
    this.renderButtons(false);
    $('#renderModal').hidden = true;
  }

  // 進度條、百分比、預估剩餘時間；busy 為準備階段的跑馬條
  renderProgress({ pct = 0, busy = false, done = false, text = '', eta = '' }) {
    const wrap = $('#renderBarWrap');
    wrap.classList.toggle('busy', busy);
    wrap.classList.toggle('done', done);
    const p = Math.max(0, Math.min(100, pct));
    const label = busy ? '準備中' : `${p < 10 ? p.toFixed(1) : Math.floor(p)}%`;
    $('#renderBar').style.width = busy ? '' : `${p}%`;
    $('#renderPct').textContent = label;
    $('#renderStatus').textContent = text;
    $('#renderEta').textContent = busy ? '' : eta;
    const badge = $('#renderBadge');
    badge.hidden = done || (!busy && p === 0 && !text);
    badge.textContent = busy ? '準備中' : label;
    this.renderTitle(done ? null : label);
  }

  // 分頁標題顯示進度，切到其他視窗時也看得到
  renderTitle(label) {
    if (!this._baseTitle) this._baseTitle = document.title;
    document.title = label ? `［${label}］渲染中 · ${this._baseTitle}` : this._baseTitle;
  }

  renderButtons(running) {
    $('[data-render="start"]').disabled = running;
    $('[data-render="stop"]').disabled = !running;
    $('[data-render="download"]').disabled = running || !(this.studio?.renderer || this.studio?.resultURL);
    const pano = !!this.lastPano && !running;
    $('[data-render="html"]').hidden = !this.lastPano;
    $('[data-render="html"]').disabled = !pano;
    $('[data-render="toggle360"]').hidden = !pano;
  }

  startRender() {
    const opts = {
      engine: $('#rEngine').value, time: $('#rTime').value, quality: $('#rQuality').value, aspect: $('#rAspect').value,
      ceiling: $('#rCeiling').checked, lights: $('#rLights').checked, lighting: lightingState(store.project),
      exposure: Number($('#rExposure').value), sunRotate: Number($('#rSun').value),
      toneMapping: $('#rTone').value, autoExposure: $('#rAuto').checked, denoise: $('#rDenoise').checked, detail: $('#rDetail').checked,
    };
    if ($('#rOutput').value === 'pano') {
      const o = this.panoOrigin();
      if (!o) { toast('請先建立房間，或進入漫遊後再拍攝 360° 環景'); return; }
      Object.assign(opts, { panorama: true, panoPos: o.pos, ceiling: true });
      this.pendingPano = o;
    } else this.pendingPano = null;
    this.panoViewer?.dispose(); this.panoViewer = null;
    $('#renderHost').classList.remove('pano');
    this.lastPano = null;
    this.renderOpts = opts;
    if (!store.project.walls.length && !store.project.items.length) { toast('平面圖是空的，請先畫牆或放家具'); return; }
    this.studio.dispose();
    this.renderButtons(true);
    this.renderProgress({ busy: true, text: '載入光線追蹤引擎…' });
    this.studio.start(opts, $('#renderHost'), {
      onProgress: ({ stage, samples, exact, total, elapsed, eta }) => {
        if (stage === 'scene') { this.renderProgress({ busy: true, text: '建立場景…' }); return; }
        if (stage === 'compile') { this.renderProgress({ busy: true, text: `準備著色器（第一次較久）… 已用 ${fmtDuration(elapsed)}` }); return; }
        const pct = (exact / total) * 100;
        this.renderProgress({
          pct,
          text: `取樣 ${samples} / ${total} · 已用 ${fmtDuration(elapsed)}`,
          eta: eta == null ? '預估剩餘時間計算中…' : `預估剩餘約 ${fmtDuration(eta)}`,
        });
      },
      onDone: ({ samples, elapsed, W, H, engine, reason, partial }) => {
        this.lastPano = this.pendingPano;
        this.renderButtons(false);
        if (this.lastPano) this.showPano(true);
        if (partial) {
          this.renderProgress({ pct: 100, done: true, text: `渲染途中顯示卡輸出異常，已保留取樣 ${samples} 次的畫面。原因：${reason}`, eta: '已保留最後正常畫面' });
          toast('渲染途中顯示卡輸出異常，已保留最後一張正常畫面；可改用較低品質或相容模式');
        } else if (engine === 'raster') {
          this.renderProgress({ pct: 100, done: true, text: reason ? `光線追蹤無法正常輸出，已改用相容模式。原因：${reason}` : `${W} × ${H} · 相容模式 · 共 ${fmtDuration(elapsed)}`, eta: '渲染完成（相容模式）' });
          if (reason) toast('光線追蹤輸出異常，已自動改用相容模式產生效果圖');
        } else {
          this.renderProgress({ pct: 100, done: true, text: `${W} × ${H} · 取樣 ${samples} 次 · 共 ${fmtDuration(elapsed)}`, eta: '渲染完成' });
        }
      },
      onError: (err) => {
        console.error(err);
        this.renderButtons(false);
        this.renderProgress({ pct: 0, text: '', eta: '' });
        $('#renderStatus').textContent = `渲染失敗：${err?.message || err}。此瀏覽器或顯示卡可能不支援 WebGL2 光線追蹤，可改用「檔案 → 匯出 3D 透視圖 PNG」。`;
      },
    });
  }

  // VR 頭盔模式：從漫遊位置進入；不在漫遊時從畫面中心所在房間的中央進入
  async toggleVR() {
    const v = this.view3d;
    if (v.vr.active) { v.vr.exit(); return; }
    let start;
    if (v.mode === 'walk') start = { x: v.walk.pos.x, z: v.walk.pos.z, yaw: v.walk.yaw };
    else {
      const P = store.project, t = v.controls.target;
      const room = P.rooms.find((r) => pointInPolygon(t.x * 100, t.z * 100, r.points)) || P.rooms[0];
      let x = t.x, z = t.z;
      if (room) {
        let [cx, cy] = polygonCentroid(room.points);
        if (!pointInPolygon(cx, cy, room.points)) { const r = largestInnerRect(room.points); cx = (r.x0 + r.x1) / 2; cy = (r.y0 + r.y1) / 2; }
        x = cx / 100; z = cy / 100;
      }
      const dir = new THREE.Vector3(); v.camera.getWorldDirection(dir);
      start = { x, z, yaw: Math.atan2(-dir.x, -dir.z) };
    }
    try {
      await v.vr.enter(start);
      this.onVRChange(true);
    } catch (err) {
      console.error(err);
      toast(`無法進入 VR：${err?.message || err}`);
    }
  }

  onVRChange(on) {
    $('#vrBtn').classList.toggle('on', on);
    $('#vrBtn').textContent = on ? '◈ 離開 VR' : '◈ VR';
    if (on) toast('VR：左搖桿移動、右搖桿轉向、按住扳機指向地板放開即可瞬間移動');
    else if (this.view3d.mode !== 'walk') this.onVisitor(null);
  }

  // 手機版：底部按鈕開啟目錄（家具、門窗、材質、AI 風格）與屬性面板
  isMobileLayout() { return window.matchMedia('(max-width: 820px)').matches; }

  bindMobileSheets() {
    const left = $('#leftPanel'), right = $('#rightPanel');
    for (const [el, title] of [[left, '目錄'], [right, '屬性']]) {
      const h = document.createElement('div');
      h.className = 'sheet-head';
      h.innerHTML = `<span class="grip"></span><b>${title}</b><button class="icon-btn" data-sheet-close title="收起">✕</button>`;
      el.prepend(h);
    }
    const bar = $('#mobileBar');
    this.closeSheets = () => {
      left.classList.remove('open'); right.classList.remove('open');
      $$('button', bar).forEach((b) => b.classList.remove('on'));
    };
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sheet]');
      if (!b) return;
      const s = b.dataset.sheet;
      const wasOn = b.classList.contains('on');
      this.closeSheets();
      if (wasOn) return;
      if (s === 'props') { right.classList.add('open'); b.classList.remove('dot'); }
      else { this.showTab(s); left.classList.add('open'); }
      b.classList.add('on');
    });
    $$('[data-sheet-close]').forEach((x) => x.addEventListener('click', () => this.closeSheets()));
    // 面板內切換分頁時，同步底部按鈕
    $('#leftTabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t && left.classList.contains('open')) $$('button', bar).forEach((b) => b.classList.toggle('on', b.dataset.sheet === t.dataset.tab));
    });
    // 選取物件時，屬性按鈕加上提示點
    store.on('select', (sel) => { if (this.isMobileLayout() && sel && !right.classList.contains('open')) $('[data-sheet="props"]', bar).classList.add('dot'); });
  }

  // 手機漫遊：虛擬搖桿（前後左右移動）與陀螺儀（轉動手機看四周）
  bindWalkTouch() {
    const joy = $('#walkJoy'), knob = joy.querySelector('i');
    let id = null;
    const set = (e) => {
      const r = joy.getBoundingClientRect();
      let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      this.view3d.walk.joy.x = Math.abs(x) < 0.12 ? 0 : x;
      this.view3d.walk.joy.y = Math.abs(y) < 0.12 ? 0 : y;
      knob.style.transform = `translate(${x * 33}px, ${y * 33}px)`;
    };
    const end = () => { id = null; this.view3d.walk.joy.x = this.view3d.walk.joy.y = 0; knob.style.transform = ''; };
    joy.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); id = e.pointerId; try { joy.setPointerCapture(id); } catch { /* 部分瀏覽器不支援 */ } set(e); });
    joy.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);
    $('#gyroBtn').addEventListener('click', async () => {
      const b = $('#gyroBtn');
      const on = !b.classList.contains('on');
      const ok = await this.view3d.setGyro(on);
      b.classList.toggle('on', on && ok);
      b.textContent = on && ok ? '◉ 陀螺儀開啟中' : '◎ 陀螺儀';
      if (on && !ok) toast('此裝置或瀏覽器無法使用陀螺儀（需要 HTTPS 並允許「動作與方向」權限）');
      else if (on) toast('轉動手機即可環顧四周；拖曳畫面可調整水平方向');
    });
  }

  toggleWalk() {
    const walking = this.view3d.mode !== 'walk';
    const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
    // 手機漫遊改為 3D 全畫面，離開時回到原本的版面
    if (walking && touch) { this.viewBeforeWalk = ['2d', 'split', '3d'].find((m) => this.isMode(m)); this.setView('3d'); }
    else if (walking && this.isMode('2d')) this.setView('split');
    else if (!walking && touch && this.viewBeforeWalk) { this.setView(this.viewBeforeWalk); this.viewBeforeWalk = null; }
    this.view3d.setMode(walking ? 'walk' : 'orbit');
    $('#walkBtn').classList.toggle('on', walking);
    $('#walkHelp').hidden = !walking;
    // 觸控裝置：顯示虛擬搖桿與陀螺儀按鈕
    $('#walkTouch').hidden = !walking || !touch;
    $('#gyroBtn').hidden = typeof DeviceOrientationEvent === 'undefined';
    $('#gyroBtn').classList.remove('on'); $('#gyroBtn').textContent = '◎ 陀螺儀';
    if (touch) $('#walkHelp').textContent = '拖曳環顧 · 搖桿移動 · 點門窗櫃子、燈具開關 · 再按「漫遊」離開';
    if (walking) this.view3d.canvas.focus();
  }

  confirmReplace() {
    const P = store.project;
    if (!P.walls.length && !P.items.length) return true;
    return confirm('將取代目前的平面圖（可先用「儲存專案檔」備份），確定繼續？');
  }

  afterLoad() {
    this.view3d.firstBuild = true;
    this.selectedStyle = store.project.design.styleId;
    $$('.style-card').forEach((c) => c.classList.toggle('active', c.dataset.style === this.selectedStyle));
    this.syncToggles();
    requestAnimationFrame(() => this.plan.fit());
  }

  saveFile() {
    const blob = new Blob([JSON.stringify(store.project, null, 1)], { type: 'application/json' });
    download(URL.createObjectURL(blob), `${store.project.name || 'project'}.json`);
  }

  openFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!Array.isArray(data.walls)) throw new Error('格式不符');
        store.load(data);
        this.afterLoad();
        toast(`已開啟：${data.name || file.name}`);
      } catch (e) { toast(`無法開啟檔案：${e.message}`); }
    };
    r.readAsText(file);
    $('#fileOpen').value = '';
  }

  // 從平面圖圖片自動建立牆、門窗與房間（不保留底圖）
  async autoImportImage(file) {
    $('#fileAuto').value = '';
    if (!file) return;
    toast('正在辨識平面圖…');
    try {
      const src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      const img = await loadImageData(src);
      await new Promise((r) => setTimeout(r, 30)); // 讓提示先顯示
      const an = analyzeFloorplan(img);
      if (!an.ok) { toast(`辨識失敗：${an.reason}。可改用「匯入平面圖底圖」手動描圖。`); return; }
      const est = estimateScale(an);
      let result = buildProject(an, est.scale, { name: file.name.replace(/\.[^.]+$/, '') });
      // 比例確認：可直接按確定接受推估值
      const basis = est.by === 'door' ? `依 ${est.n} 個門寬推估` : '依牆厚推估（未偵測到門）';
      const ans = prompt(`辨識完成（${basis}），外框約 ${result.size.W} × ${result.size.H} cm。\n若知道實際總寬度，請輸入公分數以校正比例；不確定請直接按確定。`, String(result.size.W));
      if (ans === null) return;
      const real = Number(ans);
      if (real > 0 && Math.abs(real - result.size.W) > 1) result = buildProject(an, est.scale * (real / result.size.W), { name: result.project.name });
      const P = result.project;
      if (P.walls.length < 3) { toast('辨識到的牆太少，請改用「匯入平面圖底圖」手動描圖'); return; }
      this.nameRooms(P);
      store.checkpoint(); // 匯入結果不滿意時可按 Ctrl+Z 復原
      store.load(P, { keepHistory: true });
      this.afterLoad();
      this.setTool('select');
      toast(`已自動建立 ${P.walls.length} 面牆、${P.openings.length} 個門窗、${P.rooms.length} 個房間，請檢查並修正細節`);
    } catch (e) {
      console.error(e);
      toast(`辨識失敗：${e.message}`);
    }
  }

  // 依面積與門的連通關係推斷房型並命名
  nameRooms(P) {
    const base = { living: '客廳', dining: '餐廳', master: '主臥室', bedroom: '臥室', study: '書房', kitchen: '廚房', bathroom: '浴室', entry: '玄關', hall: '走道', balcony: '陽台', closet: '更衣室' };
    const floor = { bathroom: 'tile_bath', kitchen: 'tile_white', balcony: 'tile_bath', entry: 'tile_beige' };
    for (const r of P.rooms) { r.name = ''; r.type = 'auto'; }
    const an = analyzeRooms(P);
    // 每個房間邊界上的門
    const doorsOf = new Map(an.map((a) => [a, Object.values(a.sides).flatMap((s) => s.doors)]));
    const opRooms = new Map();
    for (const a of an) for (const d of doorsOf.get(a)) { if (!opRooms.has(d.op.id)) opRooms.set(d.op.id, []); opRooms.get(d.op.id).push(a); }
    const type = new Map();
    const sorted = [...an].sort((x, y) => y.m2 - x.m2);
    const living = sorted[0];
    if (living) type.set(living, 'living');
    for (const a of sorted.slice(1)) {
      const doors = doorsOf.get(a);
      const minDim = Math.min(a.rect.x1 - a.rect.x0, a.rect.y1 - a.rect.y0);
      const toLiving = doors.filter((d) => (opRooms.get(d.op.id) || []).includes(living));
      if (a.m2 < 4.5 && (doors.length >= 3 || minDim < 130)) type.set(a, 'hall');
      else if (a.m2 <= 14 && !sorted.some((x) => type.get(x) === 'kitchen') && toLiving.some((d) => d.def.type === 'sliding' || d.def.type === 'opening')) type.set(a, 'kitchen');
      else if (a.m2 < 6.5 && doors.length <= 1) type.set(a, 'bathroom');
    }
    const rest = sorted.filter((a) => !type.has(a));
    rest.forEach((a, i) => type.set(a, i === 0 ? 'master' : 'bedroom'));
    // 三間以上臥室時，最小一間（小於 9 m²）設為書房
    const beds = rest.filter((a) => type.get(a) === 'bedroom');
    if (rest.length >= 3 && beds.length && beds[beds.length - 1].m2 < 9) type.set(beds[beds.length - 1], 'study');
    const counts = {}, seen = {};
    for (const a of an) counts[type.get(a)] = (counts[type.get(a)] || 0) + 1;
    for (const a of an) {
      const t = type.get(a);
      seen[t] = (seen[t] || 0) + 1;
      a.room.type = t;
      a.room.name = base[t] + (counts[t] > 1 ? ` ${seen[t]}` : '');
      a.room.floor = floor[t] || 'wood_oak';
    }
  }

  importBackground(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = 1000 / img.naturalWidth; // 先假設寬 10 公尺，再請使用者校正
        store.update((p) => { p.background = { src: r.result, x: 0, y: 0, scale, opacity: 0.5, visible: true }; }, 'bg');
        this.plan.fit();
        toast('底圖已匯入，請在底圖上點擊一段已知長度的兩端以校正比例');
        this.setTool('calibrate');
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
    $('#fileBg').value = '';
  }

  finishCalibration(measured) {
    const bg = store.project.background;
    if (!bg || measured < 1) return;
    const real = Number(prompt(`這段在底圖上目前為 ${Math.round(measured)} cm，請輸入實際長度（cm）：`, Math.round(measured)));
    if (!real || real <= 0) return;
    store.update((p) => { p.background.scale *= real / measured; }, 'bg');
    this.plan.fit();
    toast('比例已校正，現在可以用「畫牆」工具沿著底圖描繪');
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (e.key === 'Escape' && !$('#aiChat').hidden) { this.toggleAssistant(false); return; }
      if (!$('#reportModal').hidden) { if (e.key === 'Escape') $('#reportModal').hidden = true; return; }
      if (!$('#renderModal').hidden) { if (e.key === 'Escape') this.closeRender(); return; }
      if (!$('#tourModal').hidden) { if (e.key === 'Escape') this.closeTour(); return; }
      if (!$('#shareModal').hidden) { if (e.key === 'Escape') $('#shareModal').hidden = true; return; }
      if (!$('#arModal').hidden) { if (e.key === 'Escape') $('#arModal').hidden = true; return; }
      if (!$('#budgetModal').hidden) {
        if (e.key === 'Escape') {
          const pv = $('#budgetModal .photo-view'), qp = $('#quotePanel');
          if (pv) pv.remove(); else if (qp && !qp.hidden) qp.hidden = true; else $('#budgetModal').hidden = true;
        }
        return;
      }
      if (!$('#variantModal').hidden) { if (e.key === 'Escape') $('#variantModal').hidden = true; return; }
      if (!$('#updateModal').hidden) { if (e.key === 'Escape') $('#updateModal').querySelector('[data-update="later"], [data-update="close"]')?.click(); return; }
      const ctrl = e.ctrlKey || e.metaKey;
      if (this.view3d.mode === 'walk') {
        if (e.key === 'Escape') this.toggleWalk();
        else { this.view3d.walk.keys.add(e.code); if (/^(Arrow|Key[WASDQE])/.test(e.code)) e.preventDefault(); }
        return;
      }
      if (e.key === '/' && !ctrl) { e.preventDefault(); this.toggleAssistant(true); return; }
      if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
      if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
      if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicate(); return; }
      if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveFile(); return; }
      if (ctrl) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); return; }
      if (e.key === 'Escape') { if (!this.plan.cancel()) store.select(null); return; }
      const step = e.shiftKey ? 10 : 1;
      const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (arrows[e.key] && store.selection) { e.preventDefault(); this.nudge(...arrows[e.key]); return; }
      const keyTools = { v: 'select', w: 'wall', r: 'room', p: 'polygon', d: 'dim', h: 'pan' };
      const k = e.key.toLowerCase();
      if (k === 'r' && store.selection?.type === 'item') { this.rotateSelection(e.shiftKey ? -90 : 90); return; }
      if (k === 'm' && store.selection?.type === 'item') { this.mirrorSelection(); return; }
      if (keyTools[k]) this.setTool(keyTools[k]);
    });
    window.addEventListener('keyup', (e) => this.view3d.walk.keys.delete(e.code));
  }
}

// 秒數轉成「1 分 05 秒」
// 畫布轉成 JPEG 網址（縮圖快取用）
function toJPEG(src, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(src, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.9);
}

// 秒數轉成「1:05」
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} 秒`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h} 小時 ${m} 分` : `${m} 分 ${String(s).padStart(2, '0')} 秒`;
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

// 簡易 Markdown 轉 HTML（先跳脫再轉換，避免注入）
function renderMarkdown(md) {
  const lines = esc(md).split('\n');
  let html = '', inList = false;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (m) html += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

window.app = new App();

// 風格名稱（方案對照用）
const STYLE_NAME = (id) => STYLE_MAP[id]?.name || '未指定風格';

// 預算備註照片：縮小到長邊 800px 的 JPEG，避免專案檔與自動存檔過大
const NOTE_PHOTO_MAX = 6;
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.72);
}

// 報價單的公司 Logo：縮小到長邊 480px 的 PNG（保留透明背景），存在瀏覽器中
const LOGO_KEY = 'interior-studio:quote-logo';
const quoteLogo = () => { try { return localStorage.getItem(LOGO_KEY) || ''; } catch { return ''; } };
function setQuoteLogo(src) {
  try { if (src) localStorage.setItem(LOGO_KEY, src); else localStorage.removeItem(LOGO_KEY); } catch { throw new Error('瀏覽器無法儲存 Logo（可能是無痕模式或空間不足）'); }
}
async function shrinkLogo(file) {
  if (!file.type.startsWith('image/')) throw new Error('請選擇圖片檔');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('無法讀取這張圖片')); i.src = url; });
    const w = img.naturalWidth || 480, h = img.naturalHeight || 480, k = Math.min(1, 480 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}
