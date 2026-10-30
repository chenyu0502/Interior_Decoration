// 設計方案：同一個專案保存多個方案（格局、家具、材質、風格、燈光與預算設定各自獨立），
// 可切換與對照。存在 project.variants = [{ id, name, created, thumb, data }] 與 project.activeVariant；
// 目前方案的內容就是專案本身，切換時先把目前內容存回方案，再載入目標方案。
import { store } from './state.js';
import { uid } from './geometry.js';

const KEYS = ['settings', 'walls', 'rooms', 'openings', 'items', 'dims', 'design'];
const clone = (o) => JSON.parse(JSON.stringify(o));

export function snapshot(P = store.project) {
  const d = {};
  for (const k of KEYS) d[k] = clone(P[k]);
  return d;
}

// 套用方案內容到專案（不含方案清單、名稱與底圖）
function apply(P, data) {
  for (const k of KEYS) if (data[k] !== undefined) P[k] = clone(data[k]);
}

export const variantNames = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 第一次使用時，把目前設計當作「方案 A」
export function ensureVariants(P = store.project) {
  if (Array.isArray(P.variants) && P.variants.length) {
    if (!P.variants.some((v) => v.id === P.activeVariant)) P.activeVariant = P.variants[0].id;
    return;
  }
  const id = uid('v');
  P.variants = [{ id, name: '方案 A', created: Date.now(), thumb: null, data: snapshot(P) }];
  P.activeVariant = id;
}

export const activeVariant = (P = store.project) => P.variants?.find((v) => v.id === P.activeVariant) || null;

// 目前方案（專案本身）的完整內容；其他方案用存下的內容
export function variantData(v, P = store.project) {
  return v.id === P.activeVariant ? snapshot(P) : v.data;
}

// 把目前內容存回目前方案
export function saveActive(P = store.project, thumb) {
  const v = activeVariant(P);
  if (!v) return;
  v.data = snapshot(P);
  if (thumb) v.thumb = thumb;
}

// 以目前設計複製出新方案並切換過去
export function addVariant(name, thumb) {
  store.commit((P) => {
    ensureVariants(P);
    saveActive(P, thumb);
    const used = new Set(P.variants.map((v) => v.name));
    let n = name;
    for (let i = 0; !n || used.has(n); i++) n = `方案 ${variantNames[i % 26]}${i >= 26 ? Math.floor(i / 26) + 1 : ''}`;
    const v = { id: uid('v'), name: n, created: Date.now(), thumb: thumb || null, data: snapshot(P) };
    P.variants.push(v);
    P.activeVariant = v.id;
  }, 'design');
}

export function switchVariant(id, thumb) {
  const P = store.project;
  if (id === P.activeVariant) return;
  const target = P.variants?.find((v) => v.id === id);
  if (!target) return;
  store.commit((p) => {
    saveActive(p, thumb);
    apply(p, target.data);
    p.activeVariant = id;
  }, 'design');
}

export function renameVariant(id, name) {
  store.update((P) => { const v = P.variants?.find((x) => x.id === id); if (v && name.trim()) v.name = name.trim().slice(0, 20); }, 'settings');
}

export function deleteVariant(id) {
  const P = store.project;
  if (!P.variants || P.variants.length <= 1) return false;
  store.commit((p) => {
    const i = p.variants.findIndex((v) => v.id === id);
    if (i < 0) return;
    if (p.activeVariant === id) {
      const next = p.variants[i === 0 ? 1 : i - 1];
      apply(p, next.data);
      p.activeVariant = next.id;
    }
    p.variants.splice(i, 1);
  }, 'design');
  return true;
}

// 暫時把方案內容套到專案上執行 fn（例如算圖），結束後還原；不觸發存檔與復原紀錄
export function withVariant(data, fn) {
  const P = store.project;
  const saved = {};
  for (const k of KEYS) saved[k] = P[k];
  try {
    for (const k of KEYS) if (data[k] !== undefined) P[k] = data[k];
    return fn(P);
  } finally {
    for (const k of KEYS) P[k] = saved[k];
  }
}
