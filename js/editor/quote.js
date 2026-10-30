// 報價單：把預算清單排成可列印的報價單（報價總表、各房間或各工程類別明細、稅金、條款與簽章欄）。
// 報價單資訊存在 project.settings.budget.quote = { company, contact, client, site, phone, terms, tax, pageBreak, photos, validDays }。
import { TIERS } from './budget.js';

export const QUOTE_DEFAULTS = {
  company: '', contact: '', client: '', site: '', phone: '',
  terms: '1. 本報價單有效期限依上方日期計算，逾期請重新報價。\n2. 付款方式：簽約 30%、進場施工 40%、完工驗收 30%。\n3. 未列於本報價單的項目另行報價；現場丈量後數量如有差異，依實際數量計價。\n4. 單價含材料與施工，實際以簽約內容為準。',
  tax: true, pageBreak: true, photos: true, validDays: 30,
};

export const quoteOptions = (P) => ({ ...QUOTE_DEFAULTS, ...(P.settings.budget?.quote || {}) });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('zh-TW');
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const cnIndex = (i) => (i < 10 ? CN_NUM[i] : i < 20 ? `十${i === 10 ? '' : CN_NUM[i - 11]}` : String(i + 1));

// 金額大寫（新台幣○○元整）
export function moneyUpper(n) {
  const D = '零壹貳參肆伍陸柒捌玖', U = ['', '拾', '佰', '仟'], B = ['', '萬', '億', '兆'];
  n = Math.round(Math.abs(n));
  if (!n) return '零元整';
  const groups = [];
  for (; n > 0; n = Math.floor(n / 10000)) groups.push(n % 10000);
  const four = (g) => {
    let s = '', zero = false;
    for (let i = 3; i >= 0; i--) {
      const d = Math.floor(g / 10 ** i) % 10;
      if (!d) { if (s) zero = true; continue; }
      s += `${zero ? '零' : ''}${D[d]}${U[i]}`;
      zero = false;
    }
    return s;
  };
  let out = '';
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (out && g < 1000 && !out.endsWith('零')) out += '零';
    if (g) out += four(g) + B[gi];
  }
  return `${out.replace(/零+$/, '')}元整`;
}

const dateText = (d) => `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;

// r：computeBudget 的結果；mode：'room' 或 'group'；notes：project.budgetNotes
export function quoteHTML(P, r, mode, notes = {}) {
  const o = quoteOptions(P);
  const today = new Date(), until = new Date(today.getTime() + (Number(o.validDays) || 30) * 86400000);
  const no = `Q${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}-${String(today.getHours()).padStart(2, '0')}${String(today.getMinutes()).padStart(2, '0')}`;
  const sections = (mode === 'room' ? r.rooms : r.groups)
    .map((g) => ({ ...g, lines: g.lines.filter((l) => l.on) }))
    .filter((g) => g.lines.length);
  const subtotal = sections.reduce((s, g) => s + g.subtotal, 0);
  const tax = o.tax ? Math.round(subtotal * 0.05) : 0;
  const total = subtotal + tax;
  const name = P.name || '室內設計';
  const qty = (q) => (Number.isInteger(q) ? q : q.toFixed(2));
  const note = (l) => {
    const n = notes[l.key];
    const sub = mode === 'room' ? l.group : '';
    return `${sub ? `<span class="sub">${esc(sub)}</span>` : ''}${n?.text ? `<div class="nt">${esc(n.text)}</div>` : ''}${o.photos && n?.photos?.length ? `<div class="ph">${n.photos.map((src) => `<img src="${src}" alt="">`).join('')}</div>` : ''}`;
  };
  const info = [['業主', o.client], ['案場地址', o.site], ['聯絡電話', o.phone], ['報價單位', o.company], ['報價人', o.contact]];

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(name)} 報價單 ${no}</title>
<style>
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif; color: #111; margin: 0; padding: 18px; font-size: 12px; }
@media print { body { padding: 0 2px 0 1px; } }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
header h1 { font-size: 24px; letter-spacing: 8px; margin: 0; }
header .co { font-size: 15px; font-weight: 700; }
header .meta { text-align: right; font-size: 11px; color: #333; line-height: 1.6; }
.info { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; margin-bottom: 14px; }
.info div { border-bottom: 1px solid #bbb; padding: 4px 0; display: flex; gap: 8px; }
.info b { width: 64px; flex: none; color: #444; font-weight: 600; }
h2 { font-size: 14px; margin: 16px 0 6px; padding-left: 8px; border-left: 4px solid #111; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
thead th { background: #eee; font-weight: 600; }
.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.c { text-align: center; white-space: nowrap; }
tr { break-inside: avoid; }
.sum td, .sum th { font-weight: 700; background: #f6f6f6; }
.sub { display: block; color: #666; font-size: 10px; }
.nt { color: #333; font-size: 11px; white-space: pre-wrap; }
.ph { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.ph img { height: 64px; border-radius: 2px; }
.sec { break-inside: auto; }
.brk { break-before: page; }
.total { margin-top: 14px; width: 60%; margin-left: auto; }
.total td { border: 0; border-bottom: 1px solid #999; padding: 5px 6px; }
.total tr.grand td { border-top: 2px solid #111; border-bottom: 2px solid #111; font-size: 15px; font-weight: 700; }
.upper { text-align: right; margin-top: 4px; font-size: 12px; }
.terms { margin-top: 16px; border: 1px solid #999; padding: 8px 10px; white-space: pre-wrap; line-height: 1.7; break-inside: avoid; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 22px; break-inside: avoid; }
.sign div { border-top: 1px solid #111; padding-top: 6px; height: 70px; }
.foot { margin-top: 10px; color: #666; font-size: 10px; }
</style></head><body>
<header>
  <div><div class="co">${esc(o.company || '')}</div><h1>報價單</h1></div>
  <div class="meta">報價單號：${no}<br>報價日期：${dateText(today)}<br>有效期限：${dateText(until)}</div>
</header>
<div class="info">
  <div><b>工程名稱</b><span>${esc(name)}</span></div>
  ${info.map(([k, v]) => `<div><b>${k}</b><span>${esc(v || '')}</span></div>`).join('')}
  <div><b>室內坪數</b><span>約 ${r.area.toFixed(1)} 坪 · ${TIERS[r.tier]?.name || ''}價位</span></div>
</div>

<h2>報價總表（${mode === 'room' ? '依房間' : '依工程類別'}）</h2>
<table>
  <thead><tr><th class="c" style="width:48px">項次</th><th>${mode === 'room' ? '房間' : '工程類別'}</th><th class="c" style="width:60px">項目數</th><th class="n" style="width:120px">金額（元）</th><th class="n" style="width:64px">比例</th></tr></thead>
  <tbody>${sections.map((g, i) => `<tr><td class="c">${cnIndex(i)}</td><td>${esc(g.name)}</td><td class="c">${g.lines.length}</td><td class="n">${fmt(g.subtotal)}</td><td class="n">${subtotal ? Math.round((g.subtotal / subtotal) * 100) : 0}%</td></tr>`).join('')}
  <tr class="sum"><td></td><td>合計</td><td class="c">${sections.reduce((s, g) => s + g.lines.length, 0)}</td><td class="n">${fmt(subtotal)}</td><td class="n">100%</td></tr></tbody>
</table>
<table class="total">
  <tr><td>工程合計</td><td class="n">${fmt(subtotal)} 元</td></tr>
  ${o.tax ? `<tr><td>營業稅 5%</td><td class="n">${fmt(tax)} 元</td></tr>` : ''}
  <tr class="grand"><td>總計${o.tax ? '（含稅）' : '（未稅）'}</td><td class="n">${fmt(total)} 元</td></tr>
</table>
<div class="upper">新台幣 ${moneyUpper(total)}</div>

${sections.map((g, i) => `<section class="sec ${o.pageBreak ? 'brk' : ''}">
<h2>${cnIndex(i)}、${esc(g.name)}</h2>
<table>
  <thead><tr><th class="c" style="width:36px">項次</th><th>項目名稱</th><th class="n" style="width:56px">數量</th><th class="c" style="width:36px">單位</th><th class="n" style="width:72px">單價</th><th class="n" style="width:84px">複價</th><th style="width:34%">說明 / 備註</th></tr></thead>
  <tbody>${g.lines.map((l, j) => `<tr><td class="c">${j + 1}</td><td>${esc(l.name)}${l.waste ? `<span class="sub">含損耗 ${Math.round(l.waste * 100)}%</span>` : ''}</td><td class="n">${qty(l.qty)}</td><td class="c">${esc(l.unit)}</td><td class="n">${fmt(l.price)}</td><td class="n">${fmt(l.amount)}</td><td>${note(l)}</td></tr>`).join('')}
  <tr class="sum"><td></td><td colspan="4">小計</td><td class="n">${fmt(g.subtotal)}</td><td></td></tr></tbody>
</table></section>`).join('')}

${o.terms ? `<div class="terms"><b>報價說明</b>\n${esc(o.terms)}</div>` : ''}
<div class="sign"><div>業主簽章：</div><div>報價單位簽章：</div></div>
<div class="foot">本報價單由 Interior Studio 依平面圖自動計算數量產生。</div>
</body></html>`;
}
