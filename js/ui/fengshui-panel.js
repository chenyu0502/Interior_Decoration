// 風水檢查面板：列出問題與化解建議，並在 2D 平面圖上標出位置。停靠在畫面底部，和日照、燈光面板共用位置。
import { store } from '../core/state.js';
import { checkFengshui, openingInfo, CHECKS } from '../editor/fengshui.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, el = document) => el.querySelector(s);
const COLOR = { warn: '#dc2626', tip: '#d97706' };

export class FengshuiPanel {
  constructor(app) {
    this.app = app;
    this.el = $('#fsPanel');
    this.active = false;
    this.focus = null;
    this.el.addEventListener('click', (e) => {
      if (e.target.closest('[data-fs="close"]')) { this.toggle(false); return; }
      const card = e.target.closest('[data-fid]');
      if (card) this.select(card.dataset.fid);
    });
    store.on('change', (reason) => {
      if (!this.active || reason === 'settings') return;
      // 家具、門窗移動後延遲重新檢查
      clearTimeout(this.t);
      this.t = setTimeout(() => this.run(), 300);
    });
  }

  toggle(on = !this.active) {
    this.active = on;
    this.el.hidden = !on;
    $('#fsBtn')?.classList.toggle('on', on);
    if (on) {
      this.app.closeDocks?.(this);
      // 需要看得到 2D 平面圖
      if (this.app.isMode?.('3d')) this.app.setView(this.app.isMobileLayout() ? '2d' : 'split');
      this.app.plan.overlayTop = (ctx, lw) => this.draw(ctx, lw);
      this.dock(true);
      this.run();
      // 畫面縮短後重新取景，整張平面圖都看得到
      setTimeout(() => this.app.plan.fit?.(), 150);
    } else {
      this.app.plan.overlayTop = null;
      this.app.plan.invalidate?.();
      this.dock(false);
    }
  }

  dock(on) {
    const views = $('#views');
    if (!on) {
      this.ro?.disconnect(); this.ro = null;
      if (!this.app.anyDockOpen?.()) { views.classList.remove('sun-open'); views.style.removeProperty('--sun-h'); }
      return;
    }
    views.classList.add('sun-open');
    const fit = () => views.style.setProperty('--sun-h', `${Math.ceil(this.el.offsetHeight)}px`);
    fit();
    if (!this.ro && typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(fit); this.ro.observe(this.el); }
  }

  run() {
    this.result = checkFengshui(store.project);
    if (this.focus && !this.result.findings.some((f) => f.id === this.focus)) this.focus = null;
    this.render();
    this.app.plan.invalidate?.();
  }

  render() {
    const { findings, score } = this.result;
    const warn = findings.filter((f) => f.level === 'warn').length, tip = findings.length - warn;
    const grade = score >= 90 ? '良好' : score >= 75 ? '尚可' : '需留意';
    this.el.innerHTML = `
      <div class="sun-bar">
        <b class="sun-title">☯ 風水檢查</b>
        <span class="fs-score fs-${score >= 90 ? 'good' : score >= 75 ? 'ok' : 'bad'}">${score} 分 · ${grade}</span>
        <span class="hint">${findings.length ? `需注意 ${warn} 項 · 建議 ${tip} 項，點項目可在平面圖上看位置` : '沒有發現常見的風水問題'}</span>
        <span class="sun-tools"><button type="button" class="icon-btn" data-fs="close" title="關閉風水檢查">✕</button></span>
      </div>
      ${findings.length ? `<div class="fs-list">${findings.map((f) => `
        <div class="fs-card ${f.level}${f.id === this.focus ? ' on' : ''}" data-fid="${esc(f.id)}" tabindex="0">
          <div class="fs-head"><span class="fs-tag">${f.level === 'warn' ? '需注意' : '建議'}</span><b>${esc(f.title)}</b></div>
          <p>${esc(f.detail)}</p>
          <p class="fs-fix"><b>化解：</b>${esc(f.fix)}</p>
        </div>`).join('')}</div>` : ''}
      <p class="hint">依台灣常見的居家風水說法，從平面圖的門窗、房間與家具位置判斷，僅供參考。已檢查：${CHECKS.join('、')}。</p>`;
  }

  // 點選項目：在平面圖上強調，並選取相關的家具
  select(id) {
    this.focus = this.focus === id ? null : id;
    for (const c of this.el.querySelectorAll('[data-fid]')) c.classList.toggle('on', c.dataset.fid === this.focus);
    const f = this.result.findings.find((x) => x.id === this.focus);
    if (f?.items?.[0]) store.select({ type: 'item', id: f.items[0] });
    this.app.plan.invalidate?.();
  }

  // 2D 平面圖標示：視線（虛線箭頭）、相關門窗（粗線）、家具與房間（外框）
  draw(ctx, lw) {
    if (!this.result) return;
    const P = store.project;
    const ops = new Map(openingInfo(P).map((o) => [o.op.id, o]));
    ctx.save();
    for (const f of this.result.findings) {
      const on = !this.focus || this.focus === f.id;
      ctx.globalAlpha = on ? 1 : 0.25;
      const col = COLOR[f.level];
      const k = this.focus === f.id ? 1.6 : 1;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      for (const rid of f.rooms || []) {
        const r = P.rooms.find((x) => x.id === rid);
        if (!r) continue;
        ctx.beginPath(); r.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        ctx.lineWidth = lw * 3 * k; ctx.setLineDash([lw * 10, lw * 6]); ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha *= 0.12; ctx.fill(); ctx.globalAlpha = on ? 1 : 0.25;
      }
      for (const iid of f.items || []) {
        const it = P.items.find((x) => x.id === iid);
        if (!it) continue;
        ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(((it.rot || 0) * Math.PI) / 180);
        ctx.lineWidth = lw * 3 * k; ctx.strokeRect(-it.w / 2 - 6, -it.d / 2 - 6, it.w + 12, it.d + 12);
        ctx.restore();
      }
      for (const oid of f.ops || []) {
        const o = ops.get(oid);
        if (!o) continue;
        ctx.lineWidth = lw * 7 * k; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(o.a[0], o.a[1]); ctx.lineTo(o.b[0], o.b[1]); ctx.stroke();
      }
      for (const [a, b] of f.lines || []) {
        ctx.lineWidth = lw * 2.5 * k; ctx.setLineDash([lw * 8, lw * 5]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
        // 箭頭
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), s = lw * 12 * k;
        ctx.beginPath(); ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - Math.cos(ang - 0.45) * s, b[1] - Math.sin(ang - 0.45) * s);
        ctx.lineTo(b[0] - Math.cos(ang + 0.45) * s, b[1] - Math.sin(ang + 0.45) * s);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }
}
