// 家具檢查截圖：把指定的家具擺在房子外面，從正面、斜角拍 3D 畫面，打開所有門片與抽屜再拍一次，
// 並輸出選單縮圖（關閉狀態）。用法：
//   node .claude/skills/furniture/shoot.mjs <家具 id，可用逗號分隔> [風格 id] [輸出資料夾]
// 需先啟動本機伺服器：npx http-server -p 8765 -c-1
import fs from 'fs';
import path from 'path';

async function loadPlaywright() {
  for (const p of ['playwright', '@playwright/test', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try { const m = await import(p); return m.chromium ? m : m.default; } catch { /* 試下一個 */ }
  }
  throw new Error('找不到 Playwright，請先詢問使用者是否同意安裝（npm i -D playwright）');
}

const [kindsArg, style = 'nordic', outArg = 'shots'] = process.argv.slice(2);
if (!kindsArg) { console.error('用法：node shoot.mjs <家具 id[,id...]> [風格 id] [輸出資料夾]'); process.exit(1); }
const KINDS = kindsArg.split(',');
const OUT = path.resolve(outArg);
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = await loadPlaywright();
const args = process.platform === 'linux' ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('KHR')) errors.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:8765/');
await page.waitForTimeout(2000);

const save = (name, url) => { const f = path.join(OUT, `${name}.png`); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); return f; };
const files = [];

// 擺放家具（房子外面一列，間隔依寬度）
const info = await page.evaluate(async ({ KINDS, style }) => {
  window.app.thumbRun = 1e9; // 停止背景的選單縮圖，避免爭用
  window.app.view3d.live.setEnabled(false);
  const { store } = await import('/js/core/state.js');
  const { CATALOG_MAP } = await import('/js/data/catalog.js');
  const missing = KINDS.filter((k) => !CATALOG_MAP[k]);
  if (missing.length) return { missing };
  if (style) store.update((p) => { p.design.styleId = style; }, 'settings');
  window.app.setView('3d');
  let x = 0;
  store.commit(() => { for (const k of KINDS) { const def = CATALOG_MAP[k]; x += def.w / 2 + 120; store.addItem(k, x, -700); x += def.w / 2; } }, 'add');
  await new Promise((r) => setTimeout(r, 1500));
  return { missing: [] };
}, { KINDS, style });
if (info.missing.length) { console.error('目錄中找不到：', info.missing.join(', ')); await browser.close(); process.exit(1); }

const shoot = (kind, view) => page.evaluate(async ({ kind, view }) => {
  const v = window.app.view3d;
  const { store } = await import('/js/core/state.js');
  const it = store.project.items.find((i) => i.kind === kind && i.y === -700);
  const S = 0.01, x = it.x * S, z = it.y * S, elev = (it.elev || 0) * S;
  const R = Math.max(it.w, it.d, it.h) * S;
  v.controls.target.set(x, elev + it.h * S * 0.5, z);
  const dir = view === 'front' ? [0, 0.25, 1] : [0.75, 0.55, 1];
  const len = Math.hypot(...dir), dist = R * 1.9 + 0.6;
  v.camera.position.set(x + (dir[0] / len) * dist, elev + it.h * S * 0.5 + (dir[1] / len) * dist, z + (dir[2] / len) * dist);
  v.controls.update();
  await new Promise((r) => setTimeout(r, 500));
  return v.canvas.toDataURL('image/png');
}, { kind, view });

for (const kind of KINDS) {
  files.push(save(`${kind}-front`, await shoot(kind, 'front')));
  files.push(save(`${kind}-angle`, await shoot(kind, 'angle')));
}
// 打開所有可動部件（門片、抽屜、蓋子）
const parts = await page.evaluate(async () => {
  const v = window.app.view3d;
  const { store } = await import('/js/core/state.js');
  const out = {};
  for (const k of v.doors?.keys() || []) {
    if (!k.includes('#')) continue;
    const it = store.project.items.find((i) => i.id === k.split('#')[0]);
    if (!it || it.y !== -700) continue;
    out[it.kind] = (out[it.kind] || 0) + 1;
    v.toggleDoor(k);
  }
  return out;
});
await page.waitForTimeout(6000);
for (const kind of KINDS) if (parts[kind]) files.push(save(`${kind}-open`, await shoot(kind, 'angle')));

// 選單縮圖（快速渲染，關閉狀態）
for (const kind of KINDS) {
  const url = await page.evaluate(async ({ kind, style }) => {
    const { ThumbStudio } = await import('/js/ui/thumbs.js');
    const { CATALOG_MAP } = await import('/js/data/catalog.js');
    const { paletteFor } = await import('/js/data/styles.js');
    const st = new ThumbStudio({});
    const c = st.item(CATALOG_MAP[kind], paletteFor(style));
    const u = c.toDataURL('image/png');
    st.dispose();
    return u;
  }, { kind, style });
  files.push(save(`${kind}-thumb`, url));
}

console.log('可動部件數：', JSON.stringify(parts));
console.log('截圖：\n' + files.join('\n'));
console.log('錯誤訊息：', errors.length ? '\n' + errors.join('\n') : '無');
await browser.close();
process.exit(errors.length ? 2 : 0);
