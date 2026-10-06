// 家具、門窗目錄：每個物件包含 2D 平面符號（plan）與 3D 程序化模型（build）。
// 3D 建模單位為公分，原點在物件底面中心，正面朝 +Z（平面圖 +y 方向），背面靠 -Z。
import * as THREE from 'three';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { detailCanvas } from './materials.js';
import { mulberry32, hashStr } from '../core/geometry.js';

// ---------------------------------------------------------------- 3D 工具
const matCache = new Map();
const texCache = new Map();

function detailTexture(kind) {
  if (texCache.has(kind)) return texCache.get(kind);
  const t = new THREE.CanvasTexture(detailCanvas(kind));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(kind === 'wood' ? 1 : 3, kind === 'wood' ? 1 : 3);
  texCache.set(kind, t);
  return t;
}

export function mat(color, kind = 'matte', extra = {}) {
  const key = `${color}|${kind}|${JSON.stringify(extra)}`;
  if (matCache.has(key)) return matCache.get(key);
  const p = { color: new THREE.Color(color), roughness: 0.8, metalness: 0 };
  switch (kind) {
    case 'fabric': Object.assign(p, { roughness: 0.95, map: detailTexture('fabric') }); break;
    case 'boucle': Object.assign(p, { roughness: 1, map: detailTexture('boucle') }); break;
    case 'velvet': Object.assign(p, { roughness: 0.55, map: detailTexture('velvet'), metalness: 0.05 }); break;
    case 'wood': Object.assign(p, { roughness: 0.6, map: detailTexture('wood') }); break;
    case 'metal': Object.assign(p, { roughness: 0.35, metalness: 0.85 }); break;
    case 'gold': Object.assign(p, { roughness: 0.25, metalness: 1 }); break;
    case 'chrome': Object.assign(p, { roughness: 0.08, metalness: 1 }); break;
    case 'stone': Object.assign(p, { roughness: 0.3, map: detailTexture('stone') }); break;
    case 'gloss': Object.assign(p, { roughness: 0.15 }); break;
    case 'ceramic': Object.assign(p, { roughness: 0.12 }); break;
    case 'glass': Object.assign(p, { roughness: 0.05, transparent: true, opacity: 0.22, depthWrite: false }); break;
    case 'mirror': Object.assign(p, { roughness: 0.02, metalness: 1 }); break;
    case 'emissive': Object.assign(p, { emissive: new THREE.Color(color), emissiveIntensity: 1.2, roughness: 0.6 }); break;
    case 'sheer': Object.assign(p, { roughness: 1, transparent: true, opacity: 0.78, side: THREE.DoubleSide, map: detailTexture('fabric') }); break;
    default: break;
  }
  Object.assign(p, extra);
  const m = new THREE.MeshStandardMaterial(p);
  matCache.set(key, m);
  return m;
}

class Kit {
  constructor(pal, opts = {}) {
    this.g = new THREE.Group();
    this.pal = pal;
    this.opts = opts;
  }
  fabricMat(color) { return mat(color || this.pal.fabric, this.pal.fabricKind || 'fabric'); }
  woodMat(color) { return mat(color || this.pal.wood, 'wood'); }
  metalMat(color) { const c = color || this.pal.metal; return mat(c, this.pal.legs === 'gold' ? 'gold' : 'metal'); }
  add(mesh) { mesh.castShadow = true; mesh.receiveShadow = true; this.g.add(mesh); return mesh; }
  // y 為底面高度
  box(w, h, d, x, y, z, m, r = 0) {
    w = Math.max(w, 0.1); h = Math.max(h, 0.1); d = Math.max(d, 0.1);
    const rr = Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
    const geo = rr > 0.3 ? new RoundedBoxGeometry(w, h, d, 3, rr) : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y + h / 2, z);
    return this.add(mesh);
  }
  cyl(rt, rb, h, x, y, z, m, seg = 28) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
    mesh.position.set(x, y + h / 2, z);
    return this.add(mesh);
  }
  sphere(r, x, y, z, m, sy = 1) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), m);
    mesh.scale.y = sy;
    mesh.position.set(x, y, z);
    return this.add(mesh);
  }
  // 依風格產生四支腳
  legs(w, d, h, inset = 4, style = this.pal.legs, color) {
    const p = this.pal;
    if (style === 'plinth') {
      this.box(w - inset * 2, h, d - inset * 2, 0, 0, 0, mat(color || p.wood2, 'wood'));
      return;
    }
    const pos = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sz] of pos) {
      const x = sx * (w / 2 - inset), z = sz * (d / 2 - inset);
      if (style === 'metal' || style === 'gold') this.box(2, h, 2, x, 0, z, this.metalMat(color));
      else if (style === 'taper') this.cyl(2.4, 1.4, h, x, 0, z, this.woodMat(color), 12);
      else this.box(4, h, 4, x, 0, z, this.woodMat(color));
    }
  }
  handle(x, y, z, len = 12, vertical = true) {
    const m = this.pal.legs === 'gold' ? mat(this.pal.metal, 'gold') : mat('#8c8c8c', 'metal');
    if (vertical) this.box(1.2, len, 1.5, x, y, z, m);
    else this.box(len, 1.2, 1.5, x, y, z, m);
  }
}

function softR(pal, base = 1) { return (pal.soft || 2) * base; }

// 抽象畫貼圖
function artTexture(seed, pal) {
  const key = `art|${seed}|${pal.accent}|${pal.fabric2}`;
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 192;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  ctx.fillStyle = '#f3efe7'; ctx.fillRect(0, 0, 256, 192);
  const cols = [pal.accent, pal.fabric2, pal.wood, pal.fabric, '#2d2d2d', pal.leaf];
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = cols[Math.floor(rnd() * cols.length)];
    ctx.globalAlpha = 0.6 + rnd() * 0.4;
    if (rnd() < 0.5) { ctx.beginPath(); ctx.arc(rnd() * 256, rnd() * 192, 15 + rnd() * 50, 0, Math.PI * 2); ctx.fill(); }
    else ctx.fillRect(rnd() * 200, rnd() * 150, 20 + rnd() * 90, 10 + rnd() * 70);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#2d2d2d'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(rnd() * 256, 0); ctx.bezierCurveTo(rnd() * 256, 80, rnd() * 256, 120, rnd() * 256, 192); ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

// ---------------------------------------------------------------- 2D 工具
const STROKE = '#3a3a3a';
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}
function fillStroke(ctx, fill, lw) {
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = lw; ctx.strokeStyle = STROKE; ctx.stroke();
}
const P = {
  rect(ctx, w, d, lw, fill = '#fff', r = 2) { rr(ctx, -w / 2, -d / 2, w, d, r); fillStroke(ctx, fill, lw); },
  line(ctx, x1, y1, x2, y2, lw) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineWidth = lw; ctx.strokeStyle = STROKE; ctx.stroke(); },
  circle(ctx, x, y, r, lw, fill = '#fff') { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); fillStroke(ctx, fill, lw); },
  label(ctx, text, w, d) {
    const fs = Math.max(6, Math.min(w, d) * 0.22, 0);
    ctx.fillStyle = '#555'; ctx.font = `${Math.min(fs, 18)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // 物件左右翻轉時，文字維持正向
    const m = ctx.getTransform();
    ctx.save();
    if (m.a * m.d - m.b * m.c < 0) ctx.scale(-1, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  },
};
function tint(hex, a = 0.35) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function planSofa(ctx, w, d, lw, pal) {
  const f = tint(pal.fabric, 0.45);
  P.rect(ctx, w, d, lw, '#fff', 6);
  rr(ctx, -w / 2, -d / 2, w, 20, 6); fillStroke(ctx, f, lw);
  rr(ctx, -w / 2, -d / 2, 15, d, 6); fillStroke(ctx, f, lw);
  rr(ctx, w / 2 - 15, -d / 2, 15, d, 6); fillStroke(ctx, f, lw);
  const n = w > 180 ? 3 : w > 110 ? 2 : 1, cw = (w - 30) / n;
  for (let i = 0; i < n; i++) { rr(ctx, -w / 2 + 15 + i * cw + 1, -d / 2 + 21, cw - 2, d - 23, 4); fillStroke(ctx, tint(pal.fabric, 0.25), lw); }
}
function planChair(ctx, w, d, lw, pal) {
  P.rect(ctx, w, d, lw, tint(pal.wood, 0.3), 3);
  rr(ctx, -w / 2, -d / 2, w, Math.min(8, d * 0.2), 2); fillStroke(ctx, tint(pal.fabric, 0.6), lw);
}
function planTable(ctx, w, d, lw, pal) { P.rect(ctx, w, d, lw, tint(pal.wood, 0.35), 2); }
function planRound(ctx, w, d, lw, pal, key = 'wood') {
  ctx.beginPath(); ctx.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2); fillStroke(ctx, tint(pal[key], 0.35), lw);
}
function planCabinet(ctx, w, d, lw, pal) {
  P.rect(ctx, w, d, lw, tint(pal.lacquer === '#f2f0ec' ? pal.wood : pal.lacquer, 0.5), 1);
  P.line(ctx, -w / 2, d / 2 - 3, w / 2, d / 2 - 3, lw);
}
function planWardrobe(ctx, w, d, lw, pal) {
  P.rect(ctx, w, d, lw, tint(pal.wood, 0.25), 1);
  ctx.setLineDash([4, 3]); P.line(ctx, -w / 2 + 3, 0, w / 2 - 3, 0, lw); ctx.setLineDash([]);
  const n = Math.max(1, Math.round(w / 50));
  for (let i = 1; i < n; i++) P.line(ctx, -w / 2 + (i * w) / n, d / 2 - 4, -w / 2 + (i * w) / n, d / 2, lw);
}
function planBed(ctx, w, d, lw, pal) {
  P.rect(ctx, w, d, lw, '#fff', 3);
  rr(ctx, -w / 2, -d / 2, w, 8, 2); fillStroke(ctx, tint(pal.wood, 0.6), lw);
  const pw = w > 120 ? (w - 30) / 2 : w - 20;
  for (let i = 0; i < (w > 120 ? 2 : 1); i++) { rr(ctx, -w / 2 + 10 + i * (pw + 10), -d / 2 + 14, pw, 28, 6); fillStroke(ctx, '#fafafa', lw); }
  rr(ctx, -w / 2 + 2, -d / 2 + d * 0.33, w - 4, d * 0.67 - 2, 3); fillStroke(ctx, tint(pal.fabric2, 0.45), lw);
  P.line(ctx, -w / 2 + 2, -d / 2 + d * 0.33, w / 2 - 2, -d / 2 + d * 0.45, lw);
}
function planLamp(ctx, w, d, lw) {
  P.circle(ctx, 0, 0, Math.min(w, d) / 2, lw, '#fffbe8');
  P.line(ctx, -w / 3, 0, w / 3, 0, lw); P.line(ctx, 0, -d / 3, 0, d / 3, lw);
}
function planCeiling(ctx, w, d, lw) {
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2); ctx.lineWidth = lw; ctx.strokeStyle = '#b58a2a'; ctx.stroke();
  ctx.setLineDash([]);
  P.line(ctx, -w / 4, 0, w / 4, 0, lw); P.line(ctx, 0, -d / 4, 0, d / 4, lw);
}
function planPlant(ctx, w, d, lw, pal) {
  const r = Math.min(w, d) / 2;
  P.circle(ctx, 0, 0, r * 0.45, lw, '#d9cbb6');
  ctx.fillStyle = tint(pal.leaf, 0.5);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    ctx.beginPath(); ctx.ellipse(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * 0.45, r * 0.22, a, 0, Math.PI * 2);
    ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = STROKE; ctx.stroke();
  }
}
function planRug(ctx, w, d, lw, pal, round = false) {
  ctx.beginPath();
  if (round) ctx.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2); else ctx.rect(-w / 2, -d / 2, w, d);
  ctx.fillStyle = tint(pal.rug, 0.55); ctx.fill();
  ctx.setLineDash([3, 3]); ctx.lineWidth = lw; ctx.strokeStyle = '#8a8172';
  ctx.beginPath();
  if (round) ctx.ellipse(0, 0, w / 2 - 6, d / 2 - 6, 0, 0, Math.PI * 2); else ctx.rect(-w / 2 + 6, -d / 2 + 6, w - 12, d - 12);
  ctx.stroke(); ctx.setLineDash([]);
}
function planCurtain(ctx, w, d, lw) {
  ctx.beginPath();
  for (let x = -w / 2; x <= w / 2; x += 2) ctx.lineTo(x, Math.sin(x * 0.4) * d * 0.35);
  ctx.lineWidth = lw * 1.5; ctx.strokeStyle = '#8a7b66'; ctx.stroke();
}

// ---------------------------------------------------------------- 家具 3D 建模
function buildSofa(k, w, d, h, { arms = true, chaise = 0, curve = false } = {}) {
  const p = k.pal;
  const low = p.low;
  const legH = p.legs === 'plinth' ? 6 : low ? 8 : 14;
  const seatTop = low ? 38 : 44;
  const fab = k.fabricMat();
  const cush = k.fabricMat(p.fabric);
  const r = softR(p, curve ? 4 : 1.5);
  const backT = curve ? 26 : 18;
  const armW = arms ? (curve ? 22 : 14) : 0;
  const mainD = chaise ? Math.min(d, 95) : d;
  const zBack = -d / 2;
  k.legs(w - 6, mainD - 6, legH, 6);
  if (chaise) k.legs(armW + 80, d - mainD, legH, 6);
  const baseH = seatTop - legH - 12;
  // 主座框
  k.box(w, baseH, mainD, 0, legH, zBack + mainD / 2, fab, r);
  // 背
  k.box(w - (curve ? 0 : 2 * armW), h - legH, backT, 0, legH, zBack + backT / 2, fab, curve ? r * 1.5 : r);
  // 扶手
  if (arms && !curve) {
    k.box(armW, seatTop - legH + 16, mainD, -w / 2 + armW / 2, legH, zBack + mainD / 2, fab, r);
    if (!chaise) k.box(armW, seatTop - legH + 16, mainD, w / 2 - armW / 2, legH, zBack + mainD / 2, fab, r);
  } else if (curve) {
    k.box(armW, seatTop - legH + 18, mainD - 10, -w / 2 + armW / 2, legH, zBack + mainD / 2 + 5, fab, r * 1.4);
    k.box(armW, seatTop - legH + 18, mainD - 10, w / 2 - armW / 2, legH, zBack + mainD / 2 + 5, fab, r * 1.4);
  }
  // 座墊
  const innerW = w - 2 * armW;
  const n = curve ? 1 : innerW > 170 ? 3 : innerW > 100 ? 2 : 1;
  const cw = innerW / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + armW + cw * (i + 0.5);
    k.box(cw - 1.5, 12, mainD - backT - 2, x, seatTop - 12, zBack + backT + (mainD - backT) / 2, cush, r + 2);
    if (!curve) k.box(cw - 4, h - seatTop - 6, 16, x, seatTop, zBack + backT + 6, cush, r + 3);
  }
  // 貴妃椅
  if (chaise) {
    const cx = w / 2 - 45;
    k.box(90, baseH, d - mainD + 2, cx, legH, zBack + mainD + (d - mainD) / 2 - 1, fab, r);
    k.box(88, 12, d - backT - 2, cx, seatTop - 12, zBack + backT + (d - backT) / 2, cush, r + 2);
    k.box(armW, seatTop - legH + 16, d, w / 2 - armW / 2, legH, 0, fab, r);
  }
  // 抱枕
  const pc = mat(p.fabric2, 'fabric');
  if (w > 120) {
    k.box(40, 38, 12, -w / 2 + armW + 26, seatTop, zBack + backT + 14, pc, 6).rotation.z = 0.12;
    k.box(40, 38, 12, w / 2 - armW - 26 - (chaise ? 0 : 0), seatTop, zBack + backT + 14, pc, 6).rotation.z = -0.12;
  }
}

function buildArmchair(k, w, d, h) {
  const p = k.pal;
  const legH = p.legs === 'plinth' ? 6 : p.low ? 10 : 16;
  const seat = p.low ? 38 : 44;
  const fab = k.fabricMat(p.fabric2 && p.legs !== 'gold' ? undefined : undefined);
  const r = softR(p, 2);
  k.legs(w - 10, d - 10, legH, 5);
  k.box(w, seat - legH - 10, d, 0, legH, 0, fab, r);
  k.box(w - 4, 10, d - 20, 0, seat - 10, 8, k.fabricMat(), r + 2);
  k.box(w, h - legH, 16, 0, legH, -d / 2 + 8, fab, r + 2);
  k.box(12, 22 + seat - legH - 10, d, -w / 2 + 6, legH, 0, fab, r);
  k.box(12, 22 + seat - legH - 10, d, w / 2 - 6, legH, 0, fab, r);
}

function buildTable(k, w, d, h, { top = 'wood', round = false, pedestal = false } = {}) {
  const p = k.pal;
  const topMat = top === 'stone' ? mat(p.stone, 'stone') : k.woodMat();
  const t = 4;
  if (round) {
    const r = Math.min(w, d) / 2;
    const m = k.cyl(r, r, t, 0, h - t, 0, topMat, 48);
    m.scale.set(w / (2 * r), 1, d / (2 * r));
    if (p.legs === 'plinth' || pedestal) {
      k.cyl(r * 0.28, r * 0.42, h - t, 0, 0, 0, top === 'stone' ? topMat : k.woodMat(p.wood2), 32);
    } else {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const leg = p.legs === 'taper' || p.legs === 'wood' ? k.cyl(2.5, 1.6, h - t, Math.cos(a) * r * 0.6, 0, Math.sin(a) * r * 0.6, k.woodMat(), 12) : k.box(2, h - t, 2, Math.cos(a) * r * 0.6, 0, Math.sin(a) * r * 0.6, k.metalMat());
        void leg;
      }
    }
  } else {
    k.box(w, t, d, 0, h - t, 0, topMat, Math.min(2, softR(p, 0.5)));
    if (p.legs === 'plinth') {
      k.box(Math.max(10, w * 0.12), h - t, d * 0.75, -w * 0.32, 0, 0, top === 'stone' ? topMat : k.woodMat(p.wood2));
      k.box(Math.max(10, w * 0.12), h - t, d * 0.75, w * 0.32, 0, 0, top === 'stone' ? topMat : k.woodMat(p.wood2));
    } else if (p.legs === 'metal' || p.legs === 'gold') {
      const m = k.metalMat();
      for (const sx of [-1, 1]) {
        const x = sx * (w / 2 - 8);
        k.box(2, h - t, 2, x, 0, -d / 2 + 6, m); k.box(2, h - t, 2, x, 0, d / 2 - 6, m);
        k.box(2, 2, d - 12, x, h - t - 2, 0, m);
      }
    } else {
      k.legs(w, d, h - t, 6);
    }
  }
}

function buildCabinet(k, w, d, h, { doors = 0, drawers = 0, legH = null, body = null, open = false, glass = false, books = false } = {}) {
  const p = k.pal;
  const lh = legH !== null ? legH : p.legs === 'plinth' ? 6 : p.low ? 6 : 12;
  const bodyMat = body || (p.legs === 'gold' ? k.woodMat(p.wood) : mat(p.lacquer, 'matte'));
  const r = softR(p, 0.3);
  if (lh > 0) {
    if (p.legs === 'plinth' || lh <= 6) k.box(w - 6, lh, d - 6, 0, 0, 0, mat(p.wood2, 'wood'));
    else k.legs(w, d, lh, 5);
  }
  const bh = h - lh;
  if (open) {
    const side = 2.5;
    k.box(side, bh, d, -w / 2 + side / 2, lh, 0, bodyMat);
    k.box(side, bh, d, w / 2 - side / 2, lh, 0, bodyMat);
    k.box(w, side, d, 0, lh, 0, bodyMat);
    k.box(w, side, d, 0, h - side, 0, bodyMat);
    k.box(w - 2 * side, bh, 1, 0, lh, -d / 2 + 0.5, bodyMat);
    const shelves = Math.max(2, Math.round(bh / 38));
    const rnd = mulberry32(hashStr(`${w}${h}${d}`));
    const bookCols = ['#8b5e3c', '#2f4858', '#c8b8a2', '#9c3d2e', '#e6dfd3', '#55624a', '#d9a441', '#3a3a3a'];
    for (let i = 1; i < shelves; i++) {
      const y = lh + (bh * i) / shelves;
      k.box(w - 2 * side, side, d - 2, 0, y - side / 2, 1, bodyMat);
    }
    if (books) {
      for (let i = 0; i < shelves; i++) {
        const y0 = lh + (bh * i) / shelves + side;
        const sh = bh / shelves - side - 4;
        let x = -w / 2 + side + 2;
        while (x < w / 2 - side - 6) {
          if (rnd() < 0.18) { x += 6 + rnd() * 14; continue; }
          const bw = 2 + rnd() * 3.5, bhh = sh * (0.65 + rnd() * 0.3);
          k.box(bw, bhh, d * 0.75, x + bw / 2, y0, 0, mat(bookCols[Math.floor(rnd() * bookCols.length)], 'matte'));
          x += bw + 0.4;
          if (rnd() < 0.08) { k.cyl(4, 3, 12, x + 6, y0, 0, mat(p.ceramic || '#eee', 'ceramic')); x += 14; }
        }
      }
    }
    return;
  }
  k.box(w, bh, d, 0, lh, 0, bodyMat, r);
  const fz = d / 2 + 0.3;
  const lineMat = mat('#000000', 'matte', { transparent: true, opacity: 0.25 });
  if (glass) {
    const n = Math.max(1, Math.round(w / 50));
    for (let i = 0; i < n; i++) {
      const cw = w / n, x = -w / 2 + cw * (i + 0.5);
      k.box(cw - 4, bh - 6, 0.6, x, lh + 3, fz, mat('#cfdde4', 'glass'));
      k.box(cw - 2, 1.4, 1.2, x, lh + 2, fz, k.metalMat());
      k.box(cw - 2, 1.4, 1.2, x, h - 3.4, fz, k.metalMat());
    }
    k.box(w - 8, 0.5, 0.5, 0, h - 5, fz - 2, mat('#fff4d6', 'emissive'));
  }
  if (doors) {
    const cw = w / doors;
    for (let i = 1; i < doors; i++) k.box(0.4, bh - 2, 0.6, -w / 2 + cw * i, lh + 1, fz, lineMat);
    for (let i = 0; i < doors; i++) {
      const x = -w / 2 + cw * (i + 0.5) + (i % 2 ? -cw * 0.38 : cw * 0.38);
      if (p.legs === 'metal' && !k.opts.forceHandles) continue; // 現代風：無把手
      k.handle(x, lh + bh * 0.45, fz + 0.6, Math.min(16, bh * 0.25));
    }
  }
  if (drawers) {
    const dh = bh / drawers;
    for (let i = 1; i < drawers; i++) k.box(w - 2, 0.4, 0.6, 0, lh + dh * i, fz, lineMat);
    for (let i = 0; i < drawers; i++) k.handle(0, lh + dh * (i + 0.5), fz + 0.6, Math.min(18, w * 0.3), false);
  }
}

function buildBed(k, w, d, h) {
  const p = k.pal;
  const low = p.low;
  const frameH = low ? 18 : 30;
  const legH = low ? 0 : p.legs === 'plinth' ? 0 : 10;
  const frameMat = p.legs === 'gold' ? k.fabricMat(p.fabric) : k.woodMat();
  if (legH) k.legs(w - 6, d - 6, legH, 4);
  k.box(w, frameH - legH, d, 0, legH, 0, frameMat, softR(p, 0.6));
  // 床墊
  const mattH = 22;
  k.box(w - 6, mattH, d - 14, 0, frameH - 4, 5, mat('#f4f2ee', 'fabric'), 5);
  // 床頭板
  const hbH = Math.max(h, frameH + mattH + 30);
  const hbMat = p.legs === 'gold' || p.legs === 'metal' ? k.fabricMat(p.fabric) : k.woodMat();
  k.box(w + (p.legs === 'gold' ? 10 : 0), hbH, 8, 0, 0, -d / 2 + 4, hbMat, softR(p, 1.5));
  if (p.legs === 'gold') k.box(w + 12, 1.5, 9, 0, hbH - 1, -d / 2 + 4, mat(p.metal, 'gold'));
  // 枕頭
  const top = frameH - 4 + mattH;
  const np = w > 120 ? 2 : 1;
  const pw = np === 2 ? (w - 30) / 2 : w - 30;
  for (let i = 0; i < np; i++) {
    const x = np === 2 ? (i ? 1 : -1) * (pw / 2 + 5) : 0;
    k.box(pw, 12, 32, x, top - 1, -d / 2 + 28, mat('#fbfaf7', 'fabric'), 6);
  }
  // 被子
  k.box(w - 2, 6, d * 0.62, 0, top - 2, d / 2 - d * 0.31 - 2, k.fabricMat(p.fabric2), 3);
  k.box(w - 2, 1.5, 24, 0, top + 3.5, d / 2 - d * 0.62 + 10, mat('#fbfaf7', 'fabric'), 0.5);
}

function buildPlant(k, w, d, h, kind = 'leafy') {
  const p = k.pal;
  const r = Math.min(w, d) / 2;
  const potH = Math.min(h * 0.3, 40);
  const potMat = mat(p.legs === 'plinth' ? '#b9a88f' : p.legs === 'gold' ? '#2b2b2d' : '#e9e4dc', 'ceramic');
  k.cyl(r * 0.5, r * 0.4, potH, 0, 0, 0, potMat, 24);
  const leaf = mat(p.leaf || '#5c8a4a', 'matte', { roughness: 0.7 });
  const rnd = mulberry32(hashStr(`${w}${h}${kind}`));
  if (kind === 'branch') {
    const br = mat('#6b5a48', 'wood');
    for (let i = 0; i < 6; i++) {
      const len = (h - potH) * (0.6 + rnd() * 0.4);
      const m = k.cyl(0.4, 0.8, len, 0, potH, 0, br, 6);
      m.geometry.translate(0, 0, 0);
      m.position.y = potH + len / 2;
      m.rotation.z = (rnd() - 0.5) * 0.7; m.rotation.x = (rnd() - 0.5) * 0.7;
      m.position.x += Math.sin(m.rotation.z) * -len / 2; m.position.z += Math.sin(m.rotation.x) * len / 2;
      for (let j = 0; j < 4; j++) k.sphere(1.6 + rnd() * 1.6, m.position.x * 2 * (0.4 + rnd() * 0.6), potH + len * (0.6 + rnd() * 0.4), m.position.z * 2 * (0.4 + rnd() * 0.6), mat('#a08c6a', 'matte'));
    }
    return;
  }
  k.cyl(1, 1.5, (h - potH) * 0.5, 0, potH, 0, mat('#6b5a48', 'wood'), 8);
  const n = kind === 'small' ? 5 : 11;
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, rad = r * (0.2 + rnd() * 0.7);
    const y = potH + (h - potH) * (0.35 + rnd() * 0.6);
    const s = k.sphere(r * (0.28 + rnd() * 0.22), Math.cos(a) * rad * 0.8, y, Math.sin(a) * rad * 0.8, leaf, 0.6 + rnd() * 0.5);
    s.rotation.set(rnd(), rnd(), rnd());
  }
}

function buildLampShade(k, x, y, z, r, h, kind) {
  const p = k.pal;
  const shadeMat = kind === 'paper' ? mat('#fbf4e4', 'emissive', { emissiveIntensity: 0.9 }) : mat(p.legs === 'gold' ? p.metal : kind === 'dome' ? p.accent : '#f2ede2', kind === 'dome' && p.legs !== 'gold' ? 'matte' : p.legs === 'gold' ? 'gold' : 'matte', { side: THREE.DoubleSide });
  if (kind === 'paper') { k.sphere(r, x, y + r, z, shadeMat, 0.9); return; }
  const m = new THREE.Mesh(new THREE.CylinderGeometry(kind === 'dome' ? r * 0.25 : r * 0.7, r, h, 32, 1, true), shadeMat);
  m.position.set(x, y + h / 2, z);
  k.add(m);
  k.sphere(r * 0.22, x, y + h * 0.3, z, mat('#fff6dc', 'emissive', { emissiveIntensity: 2 }));
}

// ---------------------------------------------------------------- 目錄
const CATS = {
  living: '客廳', dining: '餐廳', bedroom: '臥室', study: '書房', kitchen: '廚房', bath: '衛浴', storage: '收納', light: '燈具', decor: '裝飾', door: '門', window: '窗',
};
export const CATEGORIES = CATS;

export const CATALOG = [
  // ---- 客廳
  { id: 'sofa3', name: '三人沙發', cat: 'living', w: 220, d: 92, h: 80, roles: ['fabric', 'fabric2'], plan: planSofa, build: (k, w, d, h) => buildSofa(k, w, d, h) },
  { id: 'sofa2', name: '雙人沙發', cat: 'living', w: 165, d: 88, h: 80, roles: ['fabric', 'fabric2'], plan: planSofa, build: (k, w, d, h) => buildSofa(k, w, d, h) },
  {
    id: 'sofa_l', name: 'L 型沙發', cat: 'living', w: 270, d: 165, h: 80, roles: ['fabric', 'fabric2'],
    plan: (ctx, w, d, lw, pal) => {
      ctx.beginPath(); ctx.moveTo(-w / 2, -d / 2); ctx.lineTo(w / 2, -d / 2); ctx.lineTo(w / 2, d / 2); ctx.lineTo(w / 2 - 92, d / 2); ctx.lineTo(w / 2 - 92, -d / 2 + 95); ctx.lineTo(-w / 2, -d / 2 + 95); ctx.closePath();
      fillStroke(ctx, tint(pal.fabric, 0.3), lw);
      rr(ctx, -w / 2, -d / 2, w, 20, 5); fillStroke(ctx, tint(pal.fabric, 0.55), lw);
      rr(ctx, -w / 2, -d / 2, 14, 95, 5); fillStroke(ctx, tint(pal.fabric, 0.55), lw);
      rr(ctx, w / 2 - 14, -d / 2, 14, d, 5); fillStroke(ctx, tint(pal.fabric, 0.55), lw);
    },
    build: (k, w, d, h) => buildSofa(k, w, d, h, { chaise: 1 }),
  },
  { id: 'sofa_curve', name: '圓弧沙發', cat: 'living', w: 230, d: 100, h: 74, roles: ['fabric', 'fabric2'], plan: (ctx, w, d, lw, pal) => { rr(ctx, -w / 2, -d / 2, w, d, 35); fillStroke(ctx, tint(pal.fabric, 0.45), lw); rr(ctx, -w / 2 + 20, -d / 2 + 26, w - 40, d - 30, 20); fillStroke(ctx, tint(pal.fabric, 0.2), lw); }, build: (k, w, d, h) => buildSofa(k, w, d, h, { curve: true }) },
  { id: 'armchair', name: '單人沙發椅', cat: 'living', w: 80, d: 82, h: 78, roles: ['fabric', 'wood'], plan: planSofa, build: buildArmchair },
  { id: 'lounge_chair', name: '休閒躺椅', cat: 'living', w: 75, d: 90, h: 85, roles: ['fabric', 'wood'], plan: planChair, build: (k, w, d, h) => {
    const p = k.pal; const wm = k.woodMat();
    k.box(4, 30, d - 10, -w / 2 + 4, 0, 0, wm, 1.5); k.box(4, 30, d - 10, w / 2 - 4, 0, 0, wm, 1.5);
    const seat = k.box(w - 8, 10, d * 0.6, 0, 28, 8, k.fabricMat(), 4); seat.rotation.x = -0.1;
    const back = k.box(w - 8, h - 30, 10, 0, 32, -d / 2 + 14, k.fabricMat(), 4); back.rotation.x = -0.25;
    k.box(6, 3, d * 0.7, -w / 2 + 4, 52, 0, wm, 1.5); k.box(6, 3, d * 0.7, w / 2 - 4, 52, 0, wm, 1.5); void p;
  } },
  { id: 'ottoman', name: '圓凳 / 腳凳', cat: 'living', w: 50, d: 50, h: 42, roles: ['fabric2'], plan: (c, w, d, lw, p) => planRound(c, w, d, lw, p, 'fabric2'), build: (k, w, d, h) => { const m = k.cyl(w / 2, w / 2, h, 0, 0, 0, k.fabricMat(k.pal.fabric2), 32); m.scale.z = d / w; } },
  { id: 'coffee_table', name: '茶几', cat: 'living', w: 120, d: 60, h: 40, roles: ['wood', 'metal'], plan: planTable, build: (k, w, d, h) => buildTable(k, w, d, h, { top: k.pal.legs === 'gold' || k.pal.legs === 'plinth' ? 'stone' : 'wood' }) },
  { id: 'coffee_round', name: '圓茶几', cat: 'living', w: 85, d: 85, h: 38, roles: ['wood', 'metal'], plan: planRound, build: (k, w, d, h) => buildTable(k, w, d, h, { round: true, top: k.pal.legs === 'gold' || k.pal.legs === 'plinth' ? 'stone' : 'wood' }) },
  { id: 'side_table', name: '邊几', cat: 'living', w: 45, d: 45, h: 55, roles: ['wood', 'metal'], plan: planRound, build: (k, w, d, h) => buildTable(k, w, d, h, { round: true, pedestal: true, top: k.pal.legs === 'gold' ? 'stone' : 'wood' }) },
  { id: 'tv_cabinet', name: '電視櫃', cat: 'living', w: 200, d: 42, h: 48, roles: ['lacquer', 'wood2'], plan: planCabinet, build: (k, w, d, h) => buildCabinet(k, w, d, h, { drawers: 0, doors: Math.max(2, Math.round(w / 50)), legH: k.pal.legs === 'metal' ? 18 : null }) },
  { id: 'tv', name: '電視 65 吋', cat: 'living', w: 146, d: 6, h: 84, elev: 70, roles: [], plan: (ctx, w, d, lw) => P.rect(ctx, w, d, lw, '#333', 1), build: (k, w, d, h) => { k.box(w, h, 3, 0, 0, 0, mat('#111214', 'gloss')); k.box(w - 2, h - 2, 0.2, 0, 1, 1.6, mat('#1a1d22', 'gloss', { roughness: 0.05 })); } },
  { id: 'bookshelf', name: '開放書櫃', cat: 'living', w: 100, d: 35, h: 200, roles: ['lacquer', 'wood2'], plan: planCabinet, build: (k, w, d, h) => buildCabinet(k, w, d, h, { open: true, books: true, legH: 0, body: k.pal.legs === 'metal' || k.pal.legs === 'gold' ? k.woodMat(k.pal.wood2) : k.woodMat() }) },
  { id: 'display_cabinet', name: '玻璃展示櫃', cat: 'living', w: 120, d: 40, h: 200, roles: ['wood', 'metal'], plan: planCabinet, build: (k, w, d, h) => buildCabinet(k, w, d, h, { glass: true, legH: 0, body: k.woodMat(k.pal.wood2) }) },
  { id: 'rug', name: '地毯（方）', cat: 'living', w: 200, d: 140, h: 1, roles: ['rug'], flat: true, plan: (c, w, d, lw, p) => planRug(c, w, d, lw, p), build: (k, w, d) => { k.box(w, 0.8, d, 0, 0, 0, mat(k.pal.rug, 'fabric')); k.box(w - 16, 0.9, d - 16, 0, 0.05, 0, mat(k.pal.rug === '#4b4d50' ? '#5a5c60' : k.pal.fabric2, 'fabric', { transparent: true, opacity: 0.35 })); } },
  { id: 'rug_round', name: '地毯（圓）', cat: 'living', w: 160, d: 160, h: 1, roles: ['rug'], flat: true, plan: (c, w, d, lw, p) => planRug(c, w, d, lw, p, true), build: (k, w, d) => { const m = k.cyl(w / 2, w / 2, 0.8, 0, 0, 0, mat(k.pal.rug, 'fabric'), 48); m.scale.z = d / w; } },
  // ---- 餐廳
  { id: 'dining_table', name: '長餐桌', cat: 'dining', w: 160, d: 90, h: 75, roles: ['wood', 'metal'], plan: planTable, build: (k, w, d, h) => buildTable(k, w, d, h, { top: k.pal.legs === 'gold' || k.pal.legs === 'metal' ? 'stone' : 'wood' }) },
  { id: 'dining_round', name: '圓餐桌', cat: 'dining', w: 120, d: 120, h: 75, roles: ['wood', 'metal'], plan: planRound, build: (k, w, d, h) => buildTable(k, w, d, h, { round: true, pedestal: true }) },
  {
    id: 'dining_chair', name: '餐椅', cat: 'dining', w: 46, d: 52, h: 82, roles: ['fabric', 'wood'], plan: planChair,
    build: (k, w, d, h) => {
      const p = k.pal;
      const seatH = 45;
      const frame = p.legs === 'metal' || p.legs === 'gold' ? k.metalMat() : k.woodMat();
      if (p.legs === 'plinth') {
        k.box(w, seatH - 4, d - 6, 0, 0, 2, k.woodMat(p.wood2), 2);
        k.box(w, h - seatH + 4, 5, 0, seatH - 4, -d / 2 + 3, k.woodMat(p.wood2), 2);
        k.box(w - 2, 4, d - 8, 0, seatH - 4, 3, k.fabricMat(), 2);
        return;
      }
      const lt = p.legs === 'taper' ? 'taper' : p.legs === 'wood' ? 'wood' : p.legs;
      k.legs(w - 2, d - 2, seatH - 5, 3, lt);
      k.box(w, 5, d - 4, 0, seatH - 5, 1, p.legs === 'gold' ? k.fabricMat(p.fabric2) : k.fabricMat(), softR(p, 0.8));
      if (p.legs === 'taper') {
        // 溫莎 / 叉骨椅背
        k.box(w - 2, 4, 3, 0, h - 8, -d / 2 + 3, frame, 1.5);
        for (let i = -2; i <= 2; i++) k.cyl(0.7, 0.7, h - seatH - 4, i * (w / 6), seatH, -d / 2 + 3, frame, 6);
      } else {
        k.box(2.5, h - seatH, 2.5, -w / 2 + 2, seatH, -d / 2 + 3, frame);
        k.box(2.5, h - seatH, 2.5, w / 2 - 2, seatH, -d / 2 + 3, frame);
        k.box(w - 2, h - seatH - 12, 4, 0, seatH + 10, -d / 2 + 3, p.legs === 'gold' ? k.fabricMat(p.fabric2) : p.legs === 'metal' ? k.fabricMat() : frame, softR(p, 0.8));
      }
    },
  },
  { id: 'bar_stool', name: '吧台椅', cat: 'dining', w: 40, d: 40, h: 75, roles: ['fabric', 'metal'], plan: planRound, build: (k, w, d, h) => { k.cyl(w / 2, w / 2, 5, 0, h - 5, 0, k.fabricMat(), 24); k.cyl(1.5, 1.5, h - 5, 0, 0, 0, k.metalMat(), 10); k.cyl(w / 2 - 4, w / 2 - 2, 2, 0, 0, 0, k.metalMat(), 24); const ring = new THREE.Mesh(new THREE.TorusGeometry(w / 2 - 6, 0.8, 8, 24), k.metalMat()); ring.rotation.x = Math.PI / 2; ring.position.y = 28; k.add(ring); } },
  { id: 'sideboard', name: '餐邊櫃', cat: 'dining', w: 160, d: 45, h: 85, roles: ['lacquer', 'wood2'], plan: planCabinet, build: (k, w, d, h) => buildCabinet(k, w, d, h, { doors: Math.max(2, Math.round(w / 45)) }) },
  // ---- 臥室
  { id: 'bed_double', name: '雙人床 6×7 尺', cat: 'bedroom', w: 186, d: 216, h: 105, roles: ['wood', 'fabric2'], plan: planBed, build: buildBed },
  { id: 'bed_queen', name: '雙人床 5×6.2 尺', cat: 'bedroom', w: 156, d: 200, h: 100, roles: ['wood', 'fabric2'], plan: planBed, build: buildBed },
  { id: 'bed_single', name: '單人床 3.5 尺', cat: 'bedroom', w: 110, d: 196, h: 95, roles: ['wood', 'fabric2'], plan: planBed, build: buildBed },
  { id: 'nightstand', name: '床頭櫃', cat: 'bedroom', w: 48, d: 40, h: 50, roles: ['lacquer', 'wood2'], plan: planCabinet, build: (k, w, d, h) => buildCabinet(k, w, d, h, { drawers: 2 }) },
  { id: 'wardrobe', name: '衣櫃', cat: 'bedroom', w: 180, d: 60, h: 230, roles: ['lacquer', 'wood2'], plan: planWardrobe, build: (k, w, d, h) => buildCabinet(k, w, d, h, { doors: Math.max(2, Math.round(w / 45)), legH: 6 }) },
  { id: 'dresser', name: '化妝台', cat: 'bedroom', w: 100, d: 45, h: 76, roles: ['wood', 'metal'], plan: planTable, build: (k, w, d, h) => { buildTable(k, w, d, h); k.box(w * 0.3, 10, d - 4, w * 0.3, h - 14, 0, k.woodMat()); const m = k.box(w * 0.5, 70, 2, 0, h, -d / 2 + 2, mat('#dfe7ea', 'mirror'), 1); void m; k.box(w * 0.5 + 3, 73, 1.5, 0, h - 1.5, -d / 2 + 0.8, k.woodMat(), 1); } },
  { id: 'chest', name: '斗櫃', cat: 'bedroom', w: 90, d: 45, h: 100, roles: ['lacquer', 'wood2'], plan: planCabinet, build: (k, w, d, h) => buildCabinet(k, w, d, h, { drawers: 4 }) },
  { id: 'table_lamp', name: '檯燈', cat: 'light', w: 30, d: 30, h: 48, elev: 50, roles: ['accent'], light: { intensity: 0.6, dist: 3 }, plan: planLamp, build: (k, w, d, h) => { k.cyl(6, 7, 3, 0, 0, 0, k.metalMat(), 16); k.cyl(0.8, 0.8, h - 20, 0, 3, 0, k.metalMat(), 8); buildLampShade(k, 0, h - 20, 0, w / 2, 20, 'drum'); } },
  // ---- 書房
  { id: 'desk', name: '書桌', cat: 'study', w: 120, d: 60, h: 75, roles: ['wood', 'metal'], plan: planTable, build: (k, w, d, h) => { buildTable(k, w, d, h); if (w > 100) k.box(40, 14, d - 6, w / 2 - 26, h - 18, 0, k.woodMat()); } },
  { id: 'office_chair', name: '辦公椅', cat: 'study', w: 62, d: 62, h: 100, roles: ['fabric', 'metal'], plan: (c, w, d, lw, p) => { planRound(c, w, d, lw, p, 'fabric'); rr(c, -w / 2 + 8, -d / 2, w - 16, 10, 4); fillStroke(c, tint(p.fabric, 0.6), lw); }, build: (k, w, d, h) => {
    const m = mat('#2b2b2b', 'metal');
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; const leg = k.box(3, 2.5, w / 2 - 4, Math.cos(a) * (w / 4 - 2), 4, Math.sin(a) * (w / 4 - 2), m); leg.rotation.y = -a + Math.PI / 2; k.sphere(2.5, Math.cos(a) * (w / 2 - 5), 2.5, Math.sin(a) * (w / 2 - 5), m); }
    k.cyl(2.5, 2.5, 38, 0, 5, 0, mat('#888', 'chrome'), 12);
    k.box(w - 12, 8, d - 14, 0, 43, 3, k.fabricMat(), 4);
    const b = k.box(w - 14, h - 55, 6, 0, 55, -d / 2 + 8, k.fabricMat(), 4); b.rotation.x = -0.08;
  } },
  // ---- 廚房
  {
    id: 'kitchen_counter', name: '流理台（含水槽爐具）', cat: 'kitchen', w: 240, d: 62, h: 88, roles: ['lacquer', 'stone'], plan: (ctx, w, d, lw, pal) => {
      P.rect(ctx, w, d, lw, tint(pal.stone, 0.5), 1);
      rr(ctx, -w / 2 + w * 0.22, -d / 2 + 10, Math.min(70, w * 0.3), d - 20, 4); fillStroke(ctx, '#e7eef2', lw);
      if (w >= 150) for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P.circle(ctx, w / 2 - 45 + x * 14, y * 12, 8, lw, '#ddd');
    },
    build: (k, w, d, h) => {
      const p = k.pal;
      k.box(w - 4, 10, d - 8, 0, 0, -2, mat('#333', 'matte'));
      k.opts.forceHandles = p.legs !== 'metal';
      const doors = Math.max(1, Math.round(w / 60));
      const body = mat(p.legs === 'plinth' ? p.stone : p.lacquer, 'matte');
      k.box(w, h - 14, d - 4, 0, 10, -2, body, 0.3);
      const cw = w / doors;
      for (let i = 1; i < doors; i++) k.box(0.4, h - 16, 0.4, -w / 2 + cw * i, 11, d / 2 - 3.8, mat('#000000', 'matte', { transparent: true, opacity: 0.3 }));
      if (p.legs !== 'metal') for (let i = 0; i < doors; i++) k.handle(-w / 2 + cw * (i + 0.5), h - 16, d / 2 - 3, 16, false);
      const top = mat(p.stone, 'stone');
      k.box(w, 4, d, 0, h - 4, 0, top);
      // 水槽
      const sx = -w / 2 + w * 0.22 + Math.min(35, w * 0.15);
      k.box(Math.min(70, w * 0.3), 0.6, d - 22, sx, h - 0.2, 0, mat('#b9c0c4', 'chrome'));
      k.cyl(1.2, 1.2, 28, sx, h, -d / 2 + 6, mat('#cfcfcf', 'chrome'), 10);
      k.box(2.4, 2.4, 18, sx, h + 25, -d / 2 + 14, mat('#cfcfcf', 'chrome'));
      if (w >= 150) {
        k.box(70, 0.8, 50, w / 2 - 45, h, 0, mat('#121212', 'gloss'));
        for (const [x, z] of [[-14, -12], [14, -12], [-14, 12], [14, 12]]) { const r = new THREE.Mesh(new THREE.TorusGeometry(7, 0.5, 6, 24), mat('#555', 'metal')); r.rotation.x = Math.PI / 2; r.position.set(w / 2 - 45 + x, h + 1.2, z); k.add(r); }
      }
    },
  },
  { id: 'kitchen_base', name: '廚房下櫃', cat: 'kitchen', w: 90, d: 62, h: 88, roles: ['lacquer', 'stone'], plan: planCabinet, build: (k, w, d, h) => { k.box(w - 4, 10, d - 8, 0, 0, -2, mat('#333', 'matte')); k.box(w, h - 14, d - 4, 0, 10, -2, mat(k.pal.lacquer, 'matte')); k.box(w, 4, d, 0, h - 4, 0, mat(k.pal.stone, 'stone')); k.handle(0, h - 16, d / 2 - 3, 16, false); } },
  { id: 'wall_cabinet', name: '廚房吊櫃', cat: 'kitchen', w: 180, d: 35, h: 70, elev: 150, roles: ['lacquer', 'wood2'], plan: (ctx, w, d, lw) => { ctx.setLineDash([6, 4]); P.rect(ctx, w, d, lw, 'rgba(255,255,255,0.4)', 1); ctx.setLineDash([]); P.line(ctx, -w / 2, -d / 2, w / 2, d / 2, lw); }, build: (k, w, d, h) => buildCabinet(k, w, d, h, { doors: Math.max(1, Math.round(w / 45)), legH: 0 }) },
  { id: 'fridge', name: '冰箱', cat: 'kitchen', w: 75, d: 72, h: 180, roles: ['metal'], plan: (ctx, w, d, lw) => { P.rect(ctx, w, d, lw, '#eef1f3', 2); P.label(ctx, '冰箱', w, d); }, build: (k, w, d, h) => { const m = mat(k.pal.legs === 'metal' ? '#3a3b3d' : '#d9dcdf', 'metal', { metalness: 0.6, roughness: 0.3 }); k.box(w, h, d, 0, 0, 0, m, 2); k.box(w - 1, 0.6, 1, 0, h * 0.62, d / 2, mat('#222', 'matte')); k.box(1.5, 40, 2, -w / 2 + 6, h * 0.66, d / 2 + 1, mat('#bbb', 'chrome')); k.box(1.5, 40, 2, -w / 2 + 6, h * 0.62 - 44, d / 2 + 1, mat('#bbb', 'chrome')); } },
  { id: 'kitchen_island', name: '中島', cat: 'kitchen', w: 180, d: 90, h: 90, roles: ['lacquer', 'stone'], plan: (ctx, w, d, lw, pal) => { P.rect(ctx, w, d, lw, tint(pal.stone, 0.5), 1); P.line(ctx, -w / 2, d / 2 - 25, w / 2, d / 2 - 25, lw); }, build: (k, w, d, h) => { k.box(w - 4, 10, d - 30, 0, 0, -12, mat('#333', 'matte')); k.box(w, h - 14, d - 28, 0, 10, -13, mat(k.pal.legs === 'gold' ? k.pal.wood2 : k.pal.lacquer, k.pal.legs === 'gold' ? 'wood' : 'matte')); k.box(w + 4, 5, d, 0, h - 5, 0, mat(k.pal.stone, 'stone')); } },
  { id: 'washer', name: '洗衣機', cat: 'kitchen', w: 60, d: 62, h: 85, roles: [], plan: (ctx, w, d, lw) => { P.rect(ctx, w, d, lw, '#f5f5f5', 2); P.circle(ctx, 0, 6, Math.min(w, d) * 0.3, lw, '#e0e6ea'); }, build: (k, w, d, h) => { k.box(w, h, d, 0, 0, 0, mat('#f3f3f3', 'gloss'), 2); const door = new THREE.Mesh(new THREE.TorusGeometry(16, 2.5, 10, 32), mat('#bfc5c9', 'chrome')); door.position.set(0, h * 0.45, d / 2 + 1); k.add(door); const g = new THREE.Mesh(new THREE.CircleGeometry(15, 32), mat('#4a5a66', 'gloss')); g.position.set(0, h * 0.45, d / 2 + 0.6); k.add(g); } },
  // ---- 衛浴
  { id: 'toilet', name: '馬桶', cat: 'bath', w: 40, d: 70, h: 78, roles: ['ceramic'], plan: (ctx, w, d, lw) => { rr(ctx, -w / 2, -d / 2, w, 18, 3); fillStroke(ctx, '#fff', lw); ctx.beginPath(); ctx.ellipse(0, 8, w / 2 - 2, d / 2 - 12, 0, 0, Math.PI * 2); fillStroke(ctx, '#fff', lw); }, build: (k, w, d, h) => { const c = mat(k.pal.ceramic, 'ceramic'); k.box(w, h - 30, 18, 0, 30, -d / 2 + 9, c, 3); const b = k.cyl(w / 2 - 1, w / 2 - 6, 40, 0, 0, 6, c, 32); b.scale.z = 1.35; const s = k.cyl(w / 2, w / 2, 3, 0, 40, 6, c, 32); s.scale.z = 1.3; } },
  { id: 'vanity', name: '浴櫃洗手台', cat: 'bath', w: 80, d: 50, h: 85, roles: ['wood', 'stone'], plan: (ctx, w, d, lw, pal) => { P.rect(ctx, w, d, lw, tint(pal.wood, 0.3), 1); ctx.beginPath(); ctx.ellipse(0, 2, w * 0.3, d * 0.3, 0, 0, Math.PI * 2); fillStroke(ctx, '#fff', lw); }, build: (k, w, d, h) => { const p = k.pal; k.box(w, h - 30, d - 2, 0, 20, -1, k.woodMat(), 0.5); k.box(w, 3, d, 0, h - 3, 0, mat(p.stone, 'stone')); const b = k.cyl(w * 0.22, w * 0.18, 12, 0, h, 2, mat(p.ceramic, 'ceramic'), 32); b.scale.z = 0.8; k.cyl(1, 1, 22, 0, h, -d / 2 + 6, mat(p.legs === 'gold' || p.legs === 'plinth' ? '#b8954f' : '#cfcfcf', p.legs === 'gold' || p.legs === 'plinth' ? 'gold' : 'chrome'), 10); k.box(2, 2, 12, 0, h + 20, -d / 2 + 11, mat(p.legs === 'gold' || p.legs === 'plinth' ? '#b8954f' : '#cfcfcf', p.legs === 'gold' || p.legs === 'plinth' ? 'gold' : 'chrome')); } },
  { id: 'bathtub', name: '浴缸', cat: 'bath', w: 170, d: 75, h: 58, roles: ['ceramic'], plan: (ctx, w, d, lw) => { rr(ctx, -w / 2, -d / 2, w, d, 8); fillStroke(ctx, '#fff', lw); rr(ctx, -w / 2 + 8, -d / 2 + 8, w - 16, d - 16, 25); fillStroke(ctx, '#eef5f8', lw); P.circle(ctx, w / 2 - 22, 0, 2.5, lw, '#999'); }, build: (k, w, d, h) => { const c = mat(k.pal.ceramic, 'ceramic'); k.box(w, h, 7, 0, 0, -d / 2 + 3.5, c, 2); k.box(w, h, 7, 0, 0, d / 2 - 3.5, c, 2); k.box(7, h, d, -w / 2 + 3.5, 0, 0, c, 2); k.box(7, h, d, w / 2 - 3.5, 0, 0, c, 2); k.box(w - 10, 8, d - 10, 0, 0, 0, c); k.box(w - 14, 1, d - 14, 0, h - 16, 0, mat('#bfe0ea', 'glass', { opacity: 0.45 })); } },
  { id: 'shower', name: '淋浴間', cat: 'bath', w: 90, d: 90, h: 200, roles: ['metal'], plan: (ctx, w, d, lw) => { P.rect(ctx, w, d, lw, '#eef5f8', 1); P.line(ctx, -w / 2, -d / 2, w / 2, d / 2, lw); P.line(ctx, w / 2, -d / 2, -w / 2, d / 2, lw); P.circle(ctx, 0, 0, 3, lw, '#999'); }, build: (k, w, d, h) => { k.box(w, 4, d, 0, 0, 0, mat('#ececec', 'ceramic')); const g = mat('#cfe3ea', 'glass'); k.box(w, h - 4, 0.8, 0, 4, d / 2 - 0.5, g); k.box(0.8, h - 4, d, w / 2 - 0.5, 4, 0, g); const f = mat(k.pal.legs === 'gold' ? k.pal.metal : '#2b2b2b', k.pal.legs === 'gold' ? 'gold' : 'metal'); k.box(w, 2, 2, 0, h - 2, d / 2 - 0.5, f); k.box(2, 2, d, w / 2 - 0.5, h - 2, 0, f); k.cyl(1, 1, 60, -w / 2 + 6, h - 70, -d / 2 + 4, f, 8); k.cyl(10, 10, 1.5, -w / 2 + 20, h - 12, -d / 2 + 18, f, 24); } },
  { id: 'mirror', name: '鏡子 / 鏡櫃', cat: 'bath', w: 70, d: 4, h: 80, elev: 105, roles: ['metal'], plan: (ctx, w, d, lw) => P.rect(ctx, w, Math.max(d, 3), lw, '#dbe7ee', 1), build: (k, w, d, h) => { const p = k.pal; const round = p.soft >= 4; if (round) { const fr = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, h) / 2, Math.min(w, h) / 2, 2, 48), p.legs === 'gold' ? mat(p.metal, 'gold') : k.woodMat()); fr.rotation.x = Math.PI / 2; fr.position.set(0, h / 2, -d / 2 + 1); k.add(fr); const mi = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, h) / 2 - 2, 48), mat('#e6eef2', 'mirror')); mi.position.set(0, h / 2, -d / 2 + 2.1); k.add(mi); } else { k.box(w, h, 2, 0, 0, -d / 2 + 1, p.legs === 'gold' ? mat(p.metal, 'gold') : mat('#2b2b2b', 'metal')); k.box(w - 3, h - 3, 0.4, 0, 1.5, -d / 2 + 2.2, mat('#e6eef2', 'mirror')); } } },
  // ---- 收納
  { id: 'shoe_cabinet', name: '鞋櫃', cat: 'storage', w: 120, d: 40, h: 110, roles: ['lacquer', 'wood2'], plan: planCabinet, build: (k, w, d, h) => buildCabinet(k, w, d, h, { doors: Math.max(2, Math.round(w / 45)) }) },
  { id: 'tall_cabinet', name: '高櫃', cat: 'storage', w: 90, d: 45, h: 220, roles: ['lacquer', 'wood2'], plan: planWardrobe, build: (k, w, d, h) => buildCabinet(k, w, d, h, { doors: Math.max(1, Math.round(w / 45)), legH: 6 }) },
  { id: 'wall_shelf', name: '壁掛層板', cat: 'storage', w: 100, d: 22, h: 3, elev: 150, roles: ['wood'], plan: (ctx, w, d, lw) => { ctx.setLineDash([4, 3]); P.rect(ctx, w, d, lw, 'rgba(255,255,255,0.4)', 1); ctx.setLineDash([]); }, build: (k, w, d, h) => { k.box(w, h, d, 0, 0, 0, k.woodMat()); k.cyl(5, 4, 16, -w / 3, h, 0, mat(k.pal.ceramic, 'ceramic'), 16); k.box(18, 22, 12, w / 4, h, 0, mat(k.pal.fabric2, 'matte')); } },
  // ---- 燈具
  { id: 'floor_lamp', name: '立燈', cat: 'light', w: 40, d: 40, h: 160, roles: ['accent', 'metal'], light: { intensity: 1.2, dist: 4.5 }, plan: planLamp, build: (k, w, d, h) => { k.cyl(w / 2 - 6, w / 2 - 4, 2.5, 0, 0, 0, k.metalMat(), 24); k.cyl(1, 1, h - 30, 0, 2.5, 0, k.metalMat(), 8); buildLampShade(k, 0, h - 30, 0, w / 2, 30, 'drum'); } },
  { id: 'pendant_dome', name: '穹頂吊燈', cat: 'light', w: 45, d: 45, h: 30, elev: 175, roles: ['accent'], ceiling: true, light: { intensity: 1.6, dist: 5 }, plan: planCeiling, build: (k, w, d, h) => { const c = k.opts.ceiling - k.opts.elev - h; if (c > 0) k.cyl(0.3, 0.3, c, 0, h, 0, mat('#222', 'matte'), 6); buildLampShade(k, 0, 0, 0, w / 2, h, 'dome'); } },
  { id: 'pendant_paper', name: '和紙吊燈', cat: 'light', w: 55, d: 55, h: 50, elev: 175, roles: ['accent'], ceiling: true, light: { intensity: 1.5, dist: 5 }, plan: planCeiling, build: (k, w, d, h) => { const c = k.opts.ceiling - k.opts.elev - h; if (c > 0) k.cyl(0.3, 0.3, c, 0, h, 0, mat('#222', 'matte'), 6); buildLampShade(k, 0, 0, 0, Math.min(w, h) / 2, h, 'paper'); } },
  { id: 'pendant_linear', name: '線型吊燈', cat: 'light', w: 120, d: 8, h: 6, elev: 180, roles: ['metal'], ceiling: true, light: { intensity: 1.6, dist: 5 }, plan: planCeiling, build: (k, w, d, h) => { const c = k.opts.ceiling - k.opts.elev - h; if (c > 0) { k.cyl(0.2, 0.2, c, -w / 2 + 8, h, 0, mat('#222', 'matte'), 4); k.cyl(0.2, 0.2, c, w / 2 - 8, h, 0, mat('#222', 'matte'), 4); } k.box(w, h, d, 0, 0, 0, k.metalMat()); k.box(w - 4, 0.5, d - 3, 0, -0.3, 0, mat('#fff4dc', 'emissive', { emissiveIntensity: 2 })); } },
  { id: 'chandelier', name: '金屬水晶吊燈', cat: 'light', w: 80, d: 80, h: 45, elev: 190, roles: ['metal'], ceiling: true, light: { intensity: 2, dist: 6 }, plan: planCeiling, build: (k, w, d, h) => { const m = mat(k.pal.metal, 'gold'); const c = k.opts.ceiling - k.opts.elev - h; if (c > 0) k.cyl(0.4, 0.4, c, 0, h, 0, m, 6); for (const [r, y] of [[w / 2, h * 0.2], [w / 3, h * 0.6]]) { const t = new THREE.Mesh(new THREE.TorusGeometry(r, 0.7, 8, 48), m); t.rotation.x = Math.PI / 2; t.position.y = y; k.add(t); for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; k.sphere(1.8, Math.cos(a) * r, y + 2, Math.sin(a) * r, mat('#fff4dc', 'emissive', { emissiveIntensity: 2 })); } } k.cyl(0.6, 0.6, h, 0, 0, 0, m, 6); } },
  { id: 'ceiling_light', name: '吸頂燈', cat: 'light', w: 50, d: 50, h: 8, elev: 272, roles: [], ceiling: true, light: { intensity: 1.6, dist: 6 }, plan: planCeiling, build: (k, w, d, h) => { k.cyl(w / 2, w / 2 - 3, h, 0, 0, 0, mat('#fffaf0', 'emissive', { emissiveIntensity: 1.1 }), 40); } },
  // ---- 裝飾
  { id: 'plant', name: '大型盆栽', cat: 'decor', w: 55, d: 55, h: 140, roles: ['leaf'], plan: planPlant, build: (k, w, d, h) => buildPlant(k, w, d, h, 'leafy') },
  { id: 'plant_small', name: '小盆栽', cat: 'decor', w: 35, d: 35, h: 60, roles: ['leaf'], plan: planPlant, build: (k, w, d, h) => buildPlant(k, w, d, h, 'small') },
  { id: 'plant_branch', name: '枯枝花器', cat: 'decor', w: 40, d: 40, h: 120, roles: [], plan: planPlant, build: (k, w, d, h) => buildPlant(k, w, d, h, 'branch') },
  { id: 'artwork', name: '掛畫', cat: 'decor', w: 90, d: 3, h: 65, elev: 135, roles: ['accent'], plan: (ctx, w, d, lw) => P.rect(ctx, w, Math.max(d, 3), lw, '#e9d9b8', 0), build: (k, w, d, h) => { const p = k.pal; k.box(w, h, 2.5, 0, 0, -d / 2 + 1.25, p.legs === 'gold' ? mat(p.metal, 'gold') : p.legs === 'taper' || p.legs === 'metal' ? mat('#1e1e1e', 'matte') : k.woodMat()); const pic = new THREE.Mesh(new THREE.PlaneGeometry(w - 6, h - 6), new THREE.MeshStandardMaterial({ map: artTexture(hashStr(k.opts.id || 'a'), p), roughness: 0.9 })); pic.position.set(0, h / 2, -d / 2 + 2.6); k.add(pic); } },
  { id: 'curtain', name: '窗簾', cat: 'decor', w: 200, d: 14, h: 260, roles: ['fabric2'], plan: planCurtain, build: (k, w, d, h) => {
    const p = k.pal;
    const sheer = mat('#f6f3ec', 'sheer');
    const heavy = mat(p.legs === 'gold' ? p.fabric : p.legs === 'metal' ? '#8d8f93' : '#e9e1d2', 'fabric', { side: THREE.DoubleSide });
    const geo = (pw, z0) => {
      const g = new THREE.PlaneGeometry(pw, h - 4, Math.max(8, Math.round(pw / 4)), 1);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, z0 + Math.sin(pos.getX(i) * 0.45) * 2.2);
      g.computeVertexNormals();
      return g;
    };
    const s = new THREE.Mesh(geo(w, 0), sheer); s.position.set(0, (h - 4) / 2, -d / 2 + 4); k.add(s);
    const pw = w * 0.22;
    for (const sx of [-1, 1]) { const c = new THREE.Mesh(geo(pw, 0), heavy); c.position.set(sx * (w / 2 - pw / 2), (h - 4) / 2, -d / 2 + 9); k.add(c); }
    k.cyl(1, 1, w + 10, 0, h - 3, -d / 2 + 6, k.metalMat(), 8).rotation.z = Math.PI / 2;
    k.g.children[k.g.children.length - 1].position.y = h - 3;
  } },
  { id: 'vase', name: '花瓶擺飾', cat: 'decor', w: 25, d: 25, h: 40, roles: ['ceramic'], plan: (c, w, d, lw, p) => planRound(c, w, d, lw, p, 'ceramic'), build: (k, w, d, h) => { const pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(new THREE.Vector2((w / 2) * (0.35 + Math.sin(t * Math.PI) * 0.65) * (t > 0.85 ? 0.6 : 1), t * h)); } const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 32), mat(k.pal.legs === 'plinth' ? '#b9a88f' : k.pal.accent, 'ceramic')); k.add(m); } },
];

// ---------------------------------------------------------------- 門窗
export const OPENINGS = [
  { id: 'door_single', name: '單開門', cat: 'door', type: 'door', width: 90, height: 210, sill: 0 },
  { id: 'door_double', name: '雙開門', cat: 'door', type: 'double', width: 150, height: 210, sill: 0 },
  { id: 'door_sliding', name: '推拉門', cat: 'door', type: 'sliding', width: 160, height: 220, sill: 0 },
  { id: 'door_entry', name: '玄關大門', cat: 'door', type: 'door', width: 105, height: 215, sill: 0, entry: true },
  { id: 'door_opening', name: '門洞（無門）', cat: 'door', type: 'opening', width: 100, height: 220, sill: 0 },
  { id: 'window_std', name: '一般窗', cat: 'window', type: 'window', width: 120, height: 120, sill: 90 },
  { id: 'window_wide', name: '橫拉長窗', cat: 'window', type: 'window', width: 200, height: 130, sill: 85 },
  { id: 'window_french', name: '落地窗', cat: 'window', type: 'french', width: 240, height: 230, sill: 0 },
  { id: 'window_high', name: '高窗（浴室）', cat: 'window', type: 'window', width: 70, height: 50, sill: 170 },
  { id: 'window_fixed', name: '景觀固定窗', cat: 'window', type: 'fixed', width: 150, height: 160, sill: 60 },
];

export const CATALOG_MAP = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
export const OPENING_MAP = Object.fromEntries(OPENINGS.map((c) => [c.id, c]));

export function buildItemObject(item, pal, opts = {}) {
  const def = CATALOG_MAP[item.kind];
  const p = { ...pal };
  if (def && def.roles) {
    if (item.color && def.roles[0]) p[def.roles[0]] = item.color;
    if (item.color2 && def.roles[1]) p[def.roles[1]] = item.color2;
  }
  const k = new Kit(p, { ...opts, id: item.id, elev: item.elev || 0 });
  if (def) def.build(k, item.w, item.d, item.h);
  else k.box(item.w, item.h, item.d, 0, 0, 0, mat('#cccccc'));
  return k.g;
}

// 門窗 3D：原點在開口中心（沿牆方向）、底部 = 窗台高度，z 為牆厚方向
export function buildOpeningObject(op, wallT, pal) {
  const def = OPENING_MAP[op.kind] || OPENINGS[0];
  const k = new Kit(pal);
  const w = op.width, h = op.height, t = wallT;
  const frameMat = def.type === 'window' || def.type === 'french' || def.type === 'fixed' || def.type === 'sliding'
    ? mat(pal.legs === 'gold' ? '#3b3b3d' : pal.legs === 'metal' ? '#2a2a2a' : '#e9e7e2', 'metal', { metalness: 0.4, roughness: 0.5 })
    : mat(pal.legs === 'metal' || pal.legs === 'gold' ? pal.lacquer : pal.wood, pal.legs === 'metal' || pal.legs === 'gold' ? 'matte' : 'wood');
  const glass = mat('#cfe3ee', 'glass');
  const fw = 5; // 框寬
  if (def.type === 'door' || def.type === 'double' || def.type === 'opening') {
    // 門框（兩側皆有）
    for (const side of [-1, 1]) {
      const z = side * (t / 2 + 0.6);
      k.box(fw, h + fw, 1.2, -w / 2 - fw / 2, 0, z, frameMat);
      k.box(fw, h + fw, 1.2, w / 2 + fw / 2, 0, z, frameMat);
      k.box(w + fw * 2, fw, 1.2, 0, h, z, frameMat);
    }
    k.box(2, h, t, -w / 2 - 1, 0, 0, frameMat); k.box(2, h, t, w / 2 + 1, 0, 0, frameMat); k.box(w + 4, 2, t, 0, h - 2, 0, frameMat);
    if (def.type === 'opening') return k.g;
    const leafMat = def.entry ? mat(pal.legs === 'gold' ? '#2b2b2d' : pal.wood2, def.entry && pal.legs === 'gold' ? 'metal' : 'wood') : mat(pal.legs === 'metal' || pal.legs === 'gold' ? pal.lacquer : pal.wood, pal.legs === 'metal' || pal.legs === 'gold' ? 'matte' : 'wood');
    const leaves = def.type === 'double' ? 2 : 1;
    const lw = (w - 4) / leaves;
    const zLeaf = (op.flipV ? -1 : 1) * (t / 2 - 3);
    for (let i = 0; i < leaves; i++) {
      const x = -w / 2 + 2 + lw * (i + 0.5);
      k.box(lw - 0.6, h - 3, 4, x, 0.5, zLeaf, leafMat, 0.4);
      const hx = leaves === 2 ? (i === 0 ? x + lw / 2 - 6 : x - lw / 2 + 6) : (op.flipH ? x - lw / 2 + 7 : x + lw / 2 - 7);
      const hm = mat(pal.legs === 'gold' ? pal.metal : '#9a9a9a', pal.legs === 'gold' ? 'gold' : 'metal');
      if (def.entry) { k.box(2, 60, 3, hx, 75, zLeaf + 3.5, hm); k.box(2, 60, 3, hx, 75, zLeaf - 3.5, hm); }
      else { k.box(12, 2, 2, hx + (op.flipH ? 4 : -4), 100, zLeaf + 3, hm); k.box(12, 2, 2, hx + (op.flipH ? 4 : -4), 100, zLeaf - 3, hm); }
    }
    return k.g;
  }
  if (def.type === 'sliding') {
    k.box(w, 3, t, 0, 0, 0, frameMat); k.box(w, 4, t, 0, h - 4, 0, frameMat);
    const pw = w / 2 + 3;
    for (let i = 0; i < 2; i++) {
      const x = (i ? 1 : -1) * (w / 4 - 1.5), z = (i ? 1 : -1) * 2.5;
      k.box(pw, h - 7, 0.8, x, 3, z, glass);
      k.box(3, h - 7, 3, x - pw / 2 + 1.5, 3, z, frameMat); k.box(3, h - 7, 3, x + pw / 2 - 1.5, 3, z, frameMat);
      k.box(pw, 3, 3, x, 3, z, frameMat); k.box(pw, 3, 3, x, h - 7, z, frameMat);
    }
    return k.g;
  }
  // 窗戶
  k.box(w, fw, t + 2, 0, 0, 0, frameMat); k.box(w, fw, t, 0, h - fw, 0, frameMat);
  k.box(fw, h, t, -w / 2 + fw / 2, 0, 0, frameMat); k.box(fw, h, t, w / 2 - fw / 2, 0, 0, frameMat);
  const panes = def.type === 'french' ? Math.max(2, Math.round(w / 70)) : def.type === 'fixed' ? 1 : Math.max(2, Math.round(w / 80));
  const pw = (w - fw * 2) / panes;
  for (let i = 0; i < panes; i++) {
    const x = -w / 2 + fw + pw * (i + 0.5);
    const z = def.type === 'window' ? (i % 2 ? 1.5 : -1.5) : 0;
    k.box(pw + (def.type === 'window' ? 3 : 0), h - fw * 2, 0.6, x, fw, z, glass);
    if (i > 0) k.box(3, h - fw * 2, 4, -w / 2 + fw + pw * i, fw, 0, frameMat);
  }
  if (op.sill > 30) k.box(w + 10, 2.5, 6, 0, -2.5, t / 2 + 2, mat(pal.stone, 'stone'));
  return k.g;
}

export function catalogEntry(kind) { return CATALOG_MAP[kind] || OPENING_MAP[kind]; }
