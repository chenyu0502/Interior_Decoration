// 燈光情境：決定天色（白天 / 傍晚 / 夜晚）、色溫、整體亮度，以及每盞燈具開多亮。
// 存在 project.settings.lighting = { scene, temp, dim, lamps: { 燈具編號: 0 到 1 } }；
// settings.night 仍代表「是否為非白天」，讓舊專案、渲染與一句話改設計照常運作。
import { CATALOG_MAP } from '../data/catalog.js';

const CEILING = new Set(['ceiling_light']);
const PENDANT = new Set(['pendant_dome', 'pendant_paper', 'pendant_linear', 'chandelier']);
const LOW = new Set(['table_lamp', 'floor_lamp']);

// rule：依燈具種類回傳亮度比例；fill：沒有燈具的房間是否自動補一盞主燈
export const SCENES = {
  day: { name: '白天自然光', short: '白天', time: 'day', temp: 4500, dim: 1, fill: false, rule: () => 0, tip: '關燈，只有窗外的自然光' },
  dusk: { name: '傍晚溫馨', short: '傍晚', time: 'dusk', temp: 2700, dim: 0.8, fill: true, rule: () => 1, tip: '夕陽餘暉加上暖色燈光' },
  night: { name: '夜晚全亮', short: '夜晚', time: 'night', temp: 4000, dim: 1, fill: true, rule: () => 1, tip: '所有燈具全開' },
  dinner: { name: '用餐聚會', short: '用餐', time: 'night', temp: 2700, dim: 1, fill: false, rule: (k) => (PENDANT.has(k) ? 1 : LOW.has(k) ? 0.6 : CEILING.has(k) ? 0.3 : 0.5), tip: '吊燈為主、主燈調暗，氣氛溫暖' },
  movie: { name: '電影模式', short: '電影', time: 'night', temp: 2700, dim: 1, fill: false, rule: (k) => (LOW.has(k) ? 0.3 : 0), tip: '關掉主燈與吊燈，只留低處微光' },
  reading: { name: '閱讀工作', short: '閱讀', time: 'night', temp: 5000, dim: 1, fill: true, rule: () => 1, tip: '明亮的白光，適合看書工作' },
  sleep: { name: '睡前夜燈', short: '睡前', time: 'night', temp: 2200, dim: 1, fill: false, rule: (k) => (k === 'table_lamp' ? 0.3 : k === 'floor_lamp' ? 0.15 : 0), tip: '只留床頭與立燈的微弱暖光' },
};

export const isLamp = (it) => !!CATALOG_MAP[it.kind]?.light;

// 色溫（K）轉 RGB（Tanner Helland 近似公式）
export function kelvinToHex(k) {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// 目前的燈光狀態：{ scene, def, time, temp, color, dim, lamps: Map(燈具編號 → 亮度 0 到 1), anyOn, fill }
export function lightingState(P) {
  const L = P.settings.lighting || {};
  let id = SCENES[L.scene] ? L.scene : (P.settings.night ? 'night' : 'day');
  // settings.night 被其他功能切換時（例如一句話改設計「晚上開燈」），情境跟著調整
  if (P.settings.night && SCENES[id].time === 'day') id = 'night';
  if (!P.settings.night && SCENES[id].time !== 'day') id = 'day';
  const def = SCENES[id];
  const custom = L.scene === id;
  const temp = custom && Number.isFinite(L.temp) ? L.temp : def.temp;
  const dim = custom && Number.isFinite(L.dim) ? L.dim : def.dim;
  const lamps = new Map();
  for (const it of P.items) {
    if (!isLamp(it)) continue;
    const own = custom ? L.lamps?.[it.id] : undefined;
    const f = Number.isFinite(own) ? own : def.rule(it.kind);
    lamps.set(it.id, Math.max(0, Math.min(1, f)) * dim);
  }
  const anyOn = def.time !== 'day' && ([...lamps.values()].some((f) => f > 0) || def.fill);
  return { scene: id, def, time: def.time, temp, color: kelvinToHex(temp), dim, lamps, anyOn, fill: def.fill && dim > 0 };
}

// 切換情境：色溫、亮度與個別燈具恢復該情境的預設
export function applyScene(P, id) {
  const def = SCENES[id];
  if (!def) return;
  P.settings.lighting = { scene: id };
  P.settings.night = def.time !== 'day';
}

// 調整目前情境的色溫、亮度或單一燈具
export function tweakLighting(P, patch) {
  const st = lightingState(P);
  const L = P.settings.lighting?.scene === st.scene ? P.settings.lighting : { scene: st.scene };
  P.settings.lighting = { ...L, ...patch, lamps: { ...(L.lamps || {}), ...(patch.lamps || {}) } };
  P.settings.night = st.def.time !== 'day';
}
