// 日照模擬面板：選擇地點、房子座向、日期與時間，3D 畫面依真實太陽位置投下陽光與陰影，
// 2D 平面圖畫出此刻陽光照到的地板範圍，並列出各房間的日照時數與西曬時段。
import { store } from '../core/state.js';
import { projectBounds } from '../core/model.js';
import { CITIES, solarPosition, sunTimes, fmtTime, compassName, sunDir3, planSunDir, sunPatches, exteriorWindows, daySunReport } from '../editor/sun.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, el = document) => el.querySelector(s);

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 春分、夏至、秋分、冬至（取常見日期）
const SEASONS = [['今天', null], ['春分', '03-20'], ['夏至', '06-21'], ['秋分', '09-23'], ['冬至', '12-22']];

// 太陽光色：低角度偏橘、高角度偏白
function sunColor(alt) {
  const t = Math.min(1, Math.max(0, alt / 35));
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  const r = 255, g = lerp(150, 244), b = lerp(80, 226);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export class SunPanel {
  constructor(app) {
    this.app = app;
    this.el = $('#sunPanel');
    this.active = false;
    this.date = todayStr();
    this.minutes = 15 * 60;
    this.playing = null;
    this.build();
    store.on('change', (reason) => {
      if (!this.active) return;
      if (reason === 'load') this.syncFromProject();
      // 平面、門窗變動時重算統計（延遲合併）
      clearTimeout(this.repT);
      this.repT = setTimeout(() => this.updateReport(), 400);
      this.app.plan.invalidate?.();
    });
  }

  get cfg() {
    const s = store.project.settings.sun || {};
    const city = CITIES[s.city] || CITIES.taipei;
    return { city: CITIES[s.city] ? s.city : 'taipei', lat: city.lat, lon: city.lon, north: Number.isFinite(s.north) ? s.north : 0 };
  }

  setCfg(patch) {
    store.update((p) => { p.settings.sun = { ...this.cfg, ...patch }; delete p.settings.sun.lat; delete p.settings.sun.lon; }, 'settings');
  }

  build() {
    const el = this.el;
    // 停靠在畫面區域底部：2D 與 3D 畫面自動縮短讓出空間，面板不會蓋住畫面
    el.innerHTML = `
      <div class="sun-bar">
        <b class="sun-title">◔ 日照</b>
        <span class="sun-field sun-more"><label>地點</label><select id="sunCity">${Object.entries(CITIES).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join('')}</select></span>
        <span class="sun-field sun-more sun-north"><label>座向</label><input type="range" id="sunNorth" min="0" max="359" step="1" title="正北方向：拖曳調整平面圖上哪一邊是北方"><span class="sun-compass" id="sunCompass" title="正北方向"><i>北</i></span></span>
        <span class="sun-field sun-more"><label>日期</label><input type="date" id="sunDate"><span class="sun-chips">${SEASONS.map(([n, d]) => `<button type="button" data-season="${d || ''}">${n}</button>`).join('')}</span></span>
        <span class="sun-tools">
          <button type="button" class="btn small" data-sun="report" title="各房間一整天的日照時數與西曬時段">統計 ▴</button>
          <button type="button" class="btn small" data-sun="collapse" title="收合成只有時間軸">收合</button>
          <button type="button" class="icon-btn" data-sun="close" title="關閉日照模擬">✕</button>
        </span>
      </div>
      <div class="sun-bar sun-time">
        <label>時間</label><input type="range" id="sunTime" min="300" max="1170" step="5"><b id="sunClock"></b>
        <button type="button" class="btn small" id="sunPlay">播放</button>
        <span class="sun-info" id="sunInfo"></span>
      </div>
      <div class="sun-detail" id="sunDetail" hidden>
        <div class="sun-report" id="sunReport"></div>
        <p class="hint">2D 平面圖的黃色區域是此刻陽光照到的地板。只計算外牆上的窗戶，不含鄰棟與陽台等室外遮蔽。</p>
      </div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.sun === 'close') this.toggle(false);
      else if (b.dataset.sun === 'report') this.setDetail(!this.detail);
      else if (b.dataset.sun === 'collapse') this.setCollapsed(!this.collapsed);
      else if (b.dataset.season !== undefined) {
        this.date = b.dataset.season ? `${this.date.slice(0, 4)}-${b.dataset.season}` : todayStr();
        $('#sunDate').value = this.date;
        this.update(); this.updateReport();
      }
    });
    $('#sunCity').addEventListener('change', (e) => { this.setCfg({ city: e.target.value }); this.update(); this.updateReport(); });
    $('#sunNorth').addEventListener('input', (e) => { this.setCfg({ north: Number(e.target.value) }); this.update(); });
    $('#sunNorth').addEventListener('change', () => this.updateReport());
    $('#sunDate').addEventListener('change', (e) => { if (e.target.value) { this.date = e.target.value; this.update(); this.updateReport(); } });
    $('#sunTime').addEventListener('input', (e) => { this.minutes = Number(e.target.value); this.update(); });
    $('#sunPlay').addEventListener('click', () => this.togglePlay());
  }

  // 統計表展開 / 收起、整個面板收合成只剩時間軸（記在瀏覽器）
  setDetail(on) {
    this.detail = on;
    if (on) this.setCollapsed(false, true);
    $('#sunDetail').hidden = !on;
    $('[data-sun="report"]', this.el).textContent = on ? '統計 ▾' : '統計 ▴';
    this.savePrefs();
  }

  setCollapsed(on, quiet) {
    this.collapsed = on;
    this.el.classList.toggle('collapsed', on);
    $('[data-sun="collapse"]', this.el).textContent = on ? '展開' : '收合';
    if (on && this.detail) { this.detail = false; $('#sunDetail').hidden = true; $('[data-sun="report"]', this.el).textContent = '統計 ▴'; }
    if (!quiet) this.savePrefs();
  }

  savePrefs() {
    try { localStorage.setItem('interior-studio:sun-ui', JSON.stringify({ detail: this.detail, collapsed: this.collapsed })); } catch { /* 無痕模式 */ }
  }

  loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem('interior-studio:sun-ui') || '{}'); } catch { /* 無痕模式 */ }
    this.setCollapsed(!!p.collapsed, true);
    this.setDetail(!!p.detail && !p.collapsed);
  }

  // 依面板高度讓畫面區域留出底部空間
  dock(on) {
    const views = $('#views');
    if (!on) {
      this.ro?.disconnect(); this.ro = null;
      views.classList.remove('sun-open');
      views.style.removeProperty('--sun-h');
      return;
    }
    views.classList.add('sun-open');
    const fit = () => views.style.setProperty('--sun-h', `${Math.ceil(this.el.offsetHeight)}px`);
    fit();
    if (!this.ro && typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(fit); this.ro.observe(this.el); }
  }

  syncFromProject() {
    const c = this.cfg;
    $('#sunCity').value = c.city;
    $('#sunNorth').value = c.north;
  }

  toggle(on = !this.active) {
    this.active = on;
    this.el.hidden = !on;
    $('#sunBtn')?.classList.toggle('on', on);
    if (on) {
      if (store.project.settings.night) store.update((p) => { p.settings.night = false; }, 'settings');
      this.loadPrefs();
      this.dock(true);
      this.syncFromProject();
      $('#sunDate').value = this.date;
      $('#sunTime').value = this.minutes;
      this.app.plan.overlay = (ctx, lw) => this.drawPlan(ctx, lw);
      this.update();
      this.updateReport();
      // 畫面縮短後重新取景，整間房子都在畫面內
      requestAnimationFrame(() => {
        this.app.plan.fit?.();
        if (this.app.view3d.mode === 'orbit') this.app.view3d.resetView();
      });
    } else {
      this.dock(false);
      this.stopPlay();
      this.app.plan.overlay = null;
      this.app.plan.invalidate?.();
      this.app.view3d.setSunSim(null);
    }
  }

  update() {
    const c = this.cfg;
    const { alt, az } = solarPosition(this.date, this.minutes, c.lat, c.lon);
    this.pos = { alt, az };
    const times = sunTimes(this.date, c.lat, c.lon);
    $('#sunClock').textContent = fmtTime(this.minutes);
    $('#sunCompass').style.transform = `rotate(${c.north}deg)`;
    $('#sunInfo').innerHTML = alt > 0
      ? `太陽在<b>${compassName(az)}方</b>（方位 ${Math.round(az)}°、高度 ${Math.round(alt)}°） · 日出 ${fmtTime(times.rise)} · 日落 ${fmtTime(times.set)}`
      : `太陽已下山 · 日出 ${fmtTime(times.rise)} · 日落 ${fmtTime(times.set)}`;
    const dir = sunDir3(alt, az, c.north);
    const intensity = alt > 0 ? 0.8 + 3 * Math.min(1, Math.sin((alt * Math.PI) / 180) * 1.6) : 0;
    this.app.view3d.setSunSim({ dir, alt, color: sunColor(alt), intensity });
    this.app.plan.invalidate?.();
  }

  updateReport() {
    if (!this.active) return;
    const c = this.cfg;
    const rep = daySunReport(store.project, this.date, c.lat, c.lon, c.north);
    const rows = [...rep.values()].filter((x) => x.room.points.length >= 3);
    const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分`);
    $('#sunReport').innerHTML = rows.length ? `<table><thead><tr><th>房間</th><th>日照</th><th>時段</th><th>西曬</th></tr></thead><tbody>${rows.map((x) => `
      <tr><td>${esc(x.room.name)}</td><td>${x.minutes ? dur(x.minutes) : '無直射'}</td><td>${x.minutes ? `${fmtTime(x.first)}–${fmtTime(x.last)}` : '—'}</td>
      <td>${x.westMinutes >= 30 ? `<span class="sun-west">${fmtTime(x.westFrom)}–${fmtTime(x.westTo)}</span>` : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">平面圖中沒有房間。</p>';
    this.report = rep;
  }

  togglePlay() {
    if (this.playing) { this.stopPlay(); return; }
    $('#sunPlay').textContent = '暫停';
    if (this.minutes >= 1165) this.minutes = 300;
    let last = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      // 約 12 秒播完一天
      this.minutes = Math.min(1170, this.minutes + ((now - last) / 1000) * 72);
      last = now;
      $('#sunTime').value = this.minutes;
      this.update();
      if (this.minutes >= 1170) { this.stopPlay(); return; }
      this.playing = requestAnimationFrame(step);
    };
    this.playing = requestAnimationFrame(step);
  }

  stopPlay() {
    if (this.playing) cancelAnimationFrame(this.playing);
    this.playing = null;
    const b = $('#sunPlay');
    if (b) b.textContent = '播放';
    this.minutes = Math.round(this.minutes / 5) * 5;
  }

  // 2D 平面圖：陽光照到的地板、太陽方向與指北針
  drawPlan(ctx, lw) {
    const P = store.project;
    const c = this.cfg;
    const pos = this.pos;
    if (!pos) return;
    ctx.save();
    if (pos.alt > 0) {
      for (const p of sunPatches(P, pos.alt, pos.az, c.north, exteriorWindows(P))) {
        ctx.save();
        const path = (pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
        path(p.room.points); ctx.clip();
        path(p.outer); ctx.clip();
        path(p.inner);
        ctx.fillStyle = 'rgba(255, 196, 40, 0.5)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(230, 150, 0, 0.8)'; ctx.lineWidth = lw; ctx.stroke();
        ctx.restore();
      }
    }
    // 指北針與太陽方向（放在平面右上角外側）
    const b = projectBounds(P);
    const r = lw * 22, cx = b.x1 - r * 1.2, cy = b.y0 - r * 2.2;
    const n = planSunDir(0, c.north);
    ctx.lineWidth = lw * 1.5;
    ctx.strokeStyle = '#374151'; ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#dc2626';
    ctx.beginPath(); ctx.moveTo(cx + n.x * r * 0.85, cy + n.y * r * 0.85); ctx.lineTo(cx - n.y * r * 0.22, cy + n.x * r * 0.22); ctx.lineTo(cx + n.y * r * 0.22, cy - n.x * r * 0.22); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#111'; ctx.font = `${lw * 11}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('北', cx + n.x * r * 1.35, cy + n.y * r * 1.35);
    if (pos.alt > 0) {
      const s = planSunDir(pos.az, c.north);
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath(); ctx.arc(cx + s.x * r * 0.7, cy + s.y * r * 0.7, r * 0.18, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}
