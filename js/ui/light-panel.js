// 燈光情境面板：選擇情境、調整色溫與亮度、個別開關燈具。停靠在畫面底部，和日照面板共用位置。
import { store } from '../core/state.js';
import { pointInPolygon } from '../core/geometry.js';
import { CATALOG_MAP } from '../data/catalog.js';
import { SCENES, lightingState, applyScene, tweakLighting, isLamp } from '../editor/lighting.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, el = document) => el.querySelector(s);

const tempName = (k) => (k <= 2500 ? '燭光暖黃' : k <= 3200 ? '暖黃' : k <= 4300 ? '自然光' : k <= 5500 ? '白光' : '冷白');

export class LightPanel {
  constructor(app) {
    this.app = app;
    this.el = $('#lightPanel');
    this.active = false;
    this.build();
    store.on('change', (reason) => {
      if (!this.active || this.updating) return;
      // 燈具增減、搬動或切換專案時重畫清單；其他時候只更新數值
      if (['load', 'design', 'edit', 'commit', 'history', 'move'].includes(reason)) this.render();
      else this.sync();
    });
  }

  build() {
    this.el.innerHTML = `
      <div class="sun-bar">
        <b class="sun-title">◑ 燈光情境</b>
        <span class="light-scenes">${Object.entries(SCENES).map(([k, s]) => `<button type="button" data-scene="${k}" title="${esc(s.tip)}">${esc(s.name)}</button>`).join('')}</span>
        <span class="sun-tools">
          <button type="button" class="btn small" data-light="list" title="個別開關每盞燈具">燈具 ▴</button>
          <button type="button" class="icon-btn" data-light="close" title="關閉燈光面板">✕</button>
        </span>
      </div>
      <div class="sun-bar light-adjust">
        <span class="sun-field"><label>色溫</label><input type="range" id="lightTemp" min="2200" max="6500" step="100"><b id="lightTempVal"></b></span>
        <span class="sun-field"><label>亮度</label><input type="range" id="lightDim" min="0" max="100" step="5"><b id="lightDimVal"></b></span>
        <span class="sun-info" id="lightInfo"></span>
      </div>
      <div class="sun-detail light-list" id="lightList" hidden></div>`;
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.scene) this.setScene(b.dataset.scene);
      else if (b.dataset.light === 'close') this.toggle(false);
      else if (b.dataset.light === 'list') this.setList(!this.listOpen);
    });
    $('#lightTemp').addEventListener('input', (e) => this.tweak({ temp: Number(e.target.value) }));
    $('#lightDim').addEventListener('input', (e) => this.tweak({ dim: Number(e.target.value) / 100 }));
    this.el.addEventListener('input', (e) => {
      const id = e.target.dataset.lamp;
      if (id && e.target.type === 'range') this.tweak({ lamps: { [id]: Number(e.target.value) / 100 } });
    });
    this.el.addEventListener('change', (e) => {
      const id = e.target.dataset.lamp;
      if (id && e.target.type === 'checkbox') { this.tweak({ lamps: { [id]: e.target.checked ? 1 : 0 } }); this.render(); }
    });
  }

  toggle(on = !this.active) {
    this.active = on;
    this.el.hidden = !on;
    $('#nightBtn')?.classList.toggle('on', on);
    if (on) {
      if (this.app.sunPanel?.active) this.app.sunPanel.toggle(false);
      try { this.setList(localStorage.getItem('interior-studio:light-list') === '1', true); } catch { this.setList(false, true); }
      this.dock(true);
      this.render();
    } else this.dock(false);
  }

  // 與日照面板相同：依面板高度讓畫面區域留出底部空間
  dock(on) {
    const views = $('#views');
    if (!on) {
      this.ro?.disconnect(); this.ro = null;
      if (!this.app.sunPanel?.active) { views.classList.remove('sun-open'); views.style.removeProperty('--sun-h'); }
      return;
    }
    views.classList.add('sun-open');
    const fit = () => views.style.setProperty('--sun-h', `${Math.ceil(this.el.offsetHeight)}px`);
    fit();
    if (!this.ro && typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(fit); this.ro.observe(this.el); }
  }

  setList(on, quiet) {
    this.listOpen = on;
    $('#lightList').hidden = !on;
    $('[data-light="list"]', this.el).textContent = on ? '燈具 ▾' : '燈具 ▴';
    if (!quiet) try { localStorage.setItem('interior-studio:light-list', on ? '1' : '0'); } catch { /* 無痕模式 */ }
  }

  setScene(id) {
    this.edit((p) => applyScene(p, id));
    this.render();
  }

  tweak(patch) {
    if (lightingState(store.project).time === 'day') return;
    this.edit((p) => tweakLighting(p, patch));
    this.sync();
  }

  edit(fn) {
    this.updating = true;
    try { store.update(fn, 'settings'); } finally { this.updating = false; }
    this.app.syncToggles?.();
  }

  // 燈具清單（依房間分組）
  render() {
    const P = store.project;
    const L = lightingState(P);
    const lamps = P.items.filter(isLamp);
    const groups = new Map();
    for (const it of lamps) {
      const r = P.rooms.find((x) => pointInPolygon(it.x, it.y, x.points));
      const k = r ? r.name : '其他';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const day = L.time === 'day';
    $('#lightList').innerHTML = lamps.length
      ? `${[...groups].map(([room, list]) => `<div class="light-room"><b>${esc(room)}</b>${list.map((it) => {
        const f = L.lamps.get(it.id) || 0;
        const own = L.dim > 0 ? Math.round((f / L.dim) * 100) : 0;
        return `<label class="light-lamp"><input type="checkbox" data-lamp="${it.id}" ${!day && f > 0 ? 'checked' : ''} ${day ? 'disabled' : ''}> ${esc(it.name || CATALOG_MAP[it.kind]?.name)}
          <input type="range" data-lamp="${it.id}" min="0" max="100" step="5" value="${own}" ${day ? 'disabled' : ''} aria-label="亮度"></label>`;
      }).join('')}</div>`).join('')}<p class="hint">漫遊時直接點燈具也可以開關。</p>`
      : '<p class="hint">平面圖中還沒有燈具。可以從左側目錄「燈具」加入吸頂燈、吊燈、立燈或檯燈；沒有燈具的房間在「夜晚全亮」「閱讀工作」「傍晚溫馨」情境會自動補一盞主燈。</p>';
    this.sync();
  }

  // 更新情境按鈕、滑桿與說明（不重畫清單，避免拖曳中斷）
  sync() {
    const L = lightingState(store.project);
    for (const b of this.el.querySelectorAll('[data-scene]')) b.classList.toggle('on', b.dataset.scene === L.scene);
    const day = L.time === 'day';
    $('#lightTemp').value = L.temp; $('#lightTemp').disabled = day;
    $('#lightDim').value = Math.round(L.dim * 100); $('#lightDim').disabled = day;
    $('#lightTempVal').textContent = `${L.temp}K ${tempName(L.temp)}`;
    $('#lightDimVal').textContent = `${Math.round(L.dim * 100)}%`;
    const on = [...L.lamps.values()].filter((f) => f > 0).length;
    $('#lightInfo').textContent = day ? `${L.def.tip}。選擇其他情境即可開燈` : `${L.def.tip} · 開啟 ${on} / ${L.lamps.size} 盞燈具${L.fill ? '（沒有燈具的房間自動補主燈）' : ''}`;
  }
}
