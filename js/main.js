// 應用程式主控：介面、目錄、屬性面板、檔案、快捷鍵
import * as THREE from 'three';
import { store, emptyProject } from './core/state.js';
import { Plan2D, isTyping } from './editor/plan2d.js';
import { View3D } from './editor/view3d.js';
import { CATALOG, OPENINGS, CATALOG_MAP, OPENING_MAP, CATEGORIES, buildItemObject, itemParams } from './data/catalog.js';
import { MATERIALS, MATERIAL_MAP, materialSwatchURL } from './data/materials.js';
import { STYLES, STYLE_MAP, paletteFor } from './data/styles.js';
import { SAMPLES } from './data/samples.js';
import { detectRooms, polygonArea, polygonCentroid, pointInPolygon, wallLength, clamp, areaText, toWallLocal, PING } from './core/geometry.js';
import { nearestWall, roomAt, wallOnRoom, wallSideToward, scaleProject } from './core/model.js';
import { autoDesign, analyzeRooms, ROOM_TYPES } from './ai/designer.js';
import * as claude from './ai/claude.js';
import { VERSION, CHANGELOG, compareVersions } from './version.js';
import { Updater } from './core/updater.js';
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
    this.selectedStyle = null;
    this.catFilter = 'all';
    this.buildCatalogUI();
    this.buildMaterialsUI();
    this.buildAIPanel();
    this.bindTopbar();
    this.bindKeys();
    store.on('select', () => this.renderProps());
    store.on('change', (reason) => {
      if (!['move', 'resize'].includes(reason)) this.renderProps();
      else this.refreshPropValues();
      if (['load', 'design', 'room', 'history', 'edit'].includes(reason)) this.renderRoomTypes();
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
      c.width = c.height = 96;
      el.append(c);
      const s = document.createElement('span'); s.textContent = def.name; el.append(s);
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-catalog', def.id); e.dataTransfer.effectAllowed = 'copy'; });
      el.addEventListener('click', () => {
        const armed = el.classList.contains('armed');
        $$('.card.armed').forEach((x) => x.classList.remove('armed'));
        if (armed) { this.setTool('select'); return; }
        el.classList.add('armed');
        this.setTool('place', def.id);
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

  renderThumbnails() {
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch { return; }
    renderer.setSize(192, 192);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#9a8f80', 2.2));
    const dl = new THREE.DirectionalLight('#ffffff', 2.2); dl.position.set(2, 4, 3); scene.add(dl);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    const queue = [...CATALOG];
    const pal = paletteFor(store.project.design.styleId);
    const step = () => {
      const def = queue.shift();
      if (!def) { renderer.dispose(); return; }
      const obj = buildItemObject({ kind: def.id, w: def.w, d: def.d, h: def.h, id: def.id, elev: def.elev || 0 }, pal, { ceiling: (def.elev || 0) + def.h + 30 });
      obj.scale.setScalar(0.01);
      obj.rotation.y = -0.6;
      scene.add(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
      const R = Math.max(size.x, size.y, size.z) || 1;
      cam.position.set(center.x + R * 1.1, center.y + R * 0.95, center.z + R * 1.9);
      cam.lookAt(center);
      renderer.render(scene, cam);
      const card = $(`.cards .card[data-kind="${def.id}"] canvas`);
      if (card) {
        const ctx = card.getContext('2d');
        ctx.fillStyle = '#eef0f2'; ctx.fillRect(0, 0, 96, 96);
        ctx.drawImage(renderer.domElement, 0, 0, 96, 96);
      }
      scene.remove(obj);
      obj.traverse((o) => o.geometry?.dispose());
      (window.requestIdleCallback || ((f) => setTimeout(f, 16)))(step);
    };
    setTimeout(step, 300);
  }

  buildMaterialsUI() {
    const mk = (m) => {
      const el = document.createElement('div');
      el.className = 'swatch';
      el.draggable = true;
      el.title = m.name;
      el.innerHTML = `<img alt="" src="${materialSwatchURL(m.id)}"><span>${esc(m.name)}</span>`;
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
        if (k === 'name' || k === 'type' || k === 'kind') { t[k] = raw; if (k === 'kind') { const d = OPENING_MAP[raw]; Object.assign(t, { width: d.width, height: d.height, sill: d.sill }); } return; }
        if (k === 'color' || k === 'color2') { t[k] = raw; return; }
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
        else if (act === 'rot90') this.rotateSelection(90);
        else if (act === 'mirror') this.mirrorSelection();
        else if (act === 'resetColor0' || act === 'resetColor1') store.commit(() => { o[act === 'resetColor0' ? 'color' : 'color2'] = null; }, 'edit');
        else if (act === 'flipH' || act === 'flipV') store.commit(() => { o[act] = !o[act]; }, 'edit');
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
    $('#nightBtn').textContent = s.night ? '☾ 夜間' : '☀ 日間';
    $('#nightBtn').classList.toggle('on', s.night);
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
    $('[data-menu-toggle]', menu).addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
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
        night: () => { store.update((p) => { p.settings.night = !p.settings.night; }, 'settings'); this.syncToggles(); },
        ceiling: () => { store.update((p) => { p.settings.showCeiling = !p.settings.showCeiling; }, 'settings'); this.syncToggles(); },
        cutaway: () => { store.update((p) => { p.settings.cutaway = !p.settings.cutaway; }, 'settings'); this.syncToggles(); },
      };
      actions[a]?.();
      if (b.closest('.menu-pop')) menu.classList.remove('open');
    });
  }

  isMode(m) { return $('#views').classList.contains(`mode-${m}`); }

  toggleWalk() {
    const walking = this.view3d.mode !== 'walk';
    if (walking && this.isMode('2d')) this.setView('split');
    this.view3d.setMode(walking ? 'walk' : 'orbit');
    $('#walkBtn').classList.toggle('on', walking);
    $('#walkHelp').hidden = !walking;
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
      if (!$('#reportModal').hidden) { if (e.key === 'Escape') $('#reportModal').hidden = true; return; }
      if (!$('#updateModal').hidden) { if (e.key === 'Escape') $('#updateModal').querySelector('[data-update="later"], [data-update="close"]')?.click(); return; }
      const ctrl = e.ctrlKey || e.metaKey;
      if (this.view3d.mode === 'walk') {
        if (e.key === 'Escape') this.toggleWalk();
        else { this.view3d.walk.keys.add(e.code); if (/^(Arrow|Key[WASDQE])/.test(e.code)) e.preventDefault(); }
        return;
      }
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
