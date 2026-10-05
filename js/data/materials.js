// 材質庫：程序化產生貼圖（不需外部圖片），同一張畫布同時供 2D 平面圖與 3D 使用。
import { mulberry32, hashStr } from '../core/geometry.js';

// size：貼圖一個循環代表的實際尺寸（公尺）
export const MATERIALS = [
  // ---- 地板 ----
  { id: 'wood_oak', name: '淺橡木地板', cat: 'floor', kind: 'planks', base: '#c9a57a', dark: '#a9804f', size: 1.2, rough: 0.6 },
  { id: 'wood_ash', name: '白梣木地板', cat: 'floor', kind: 'planks', base: '#ddc9ab', dark: '#c3a983', size: 1.2, rough: 0.65 },
  { id: 'wood_walnut', name: '胡桃木地板', cat: 'floor', kind: 'planks', base: '#7a553a', dark: '#5a3b27', size: 1.2, rough: 0.55 },
  { id: 'wood_smoked', name: '煙燻橡木地板', cat: 'floor', kind: 'planks', base: '#8f7a64', dark: '#6c5946', size: 1.2, rough: 0.6 },
  { id: 'herringbone', name: '人字拼木地板', cat: 'floor', kind: 'herringbone', base: '#b98c5e', dark: '#93673f', size: 1.44, rough: 0.5 },
  { id: 'tile_white', name: '白色拋光石英磚', cat: 'floor', kind: 'tile', base: '#efede8', grout: '#d6d3cc', tile: 0.6, size: 1.2, rough: 0.2 },
  { id: 'tile_grey', name: '灰色霧面大板磚', cat: 'floor', kind: 'tile', base: '#9d9d9a', grout: '#86857f', tile: 0.6, tileH: 1.2, size: 1.2, rough: 0.55, noise: 0.08 },
  { id: 'tile_beige', name: '米色石紋磚', cat: 'floor', kind: 'tile', base: '#d8cdb9', grout: '#c4b8a2', tile: 0.6, size: 1.2, rough: 0.4, noise: 0.08 },
  { id: 'tile_bath', name: '浴室止滑磚', cat: 'floor', kind: 'tile', base: '#b9b7b1', grout: '#9e9b94', tile: 0.3, size: 0.6, rough: 0.8, noise: 0.06 },
  { id: 'tile_hex', name: '六角花磚', cat: 'floor', kind: 'hex', base: '#e9e4da', alt: '#3c4a56', grout: '#cfc8bb', size: 0.6, rough: 0.5 },
  { id: 'marble_white', name: '白色大理石', cat: 'both', kind: 'marble', base: '#f1efeb', vein: '#a9a6a1', size: 1.6, rough: 0.15 },
  { id: 'marble_dark', name: '黑金大理石', cat: 'both', kind: 'marble', base: '#2b2b2d', vein: '#b9975b', size: 1.6, rough: 0.15 },
  { id: 'travertine', name: '洞石', cat: 'both', kind: 'travertine', base: '#d9c9ad', dark: '#bfa983', size: 1.2, rough: 0.7 },
  { id: 'terrazzo', name: '磨石子', cat: 'both', kind: 'terrazzo', base: '#dcd8d0', size: 0.8, rough: 0.35 },
  { id: 'microcement', name: '微水泥（米灰）', cat: 'both', kind: 'concrete', base: '#c8c0b4', size: 2, rough: 0.75, noise: 0.06 },
  { id: 'microcement_dark', name: '微水泥（深灰）', cat: 'both', kind: 'concrete', base: '#8a857e', size: 2, rough: 0.75, noise: 0.07 },
  { id: 'concrete', name: '清水模', cat: 'both', kind: 'formwork', base: '#a8a6a2', size: 2.4, rough: 0.85 },
  { id: 'carpet_grey', name: '灰色地毯', cat: 'floor', kind: 'fabric', base: '#8d8f93', size: 0.5, rough: 1 },
  { id: 'tatami', name: '榻榻米', cat: 'floor', kind: 'tatami', base: '#c9c08a', size: 1.8, rough: 0.9 },
  // ---- 牆面 ----
  { id: 'paint_white', name: '白色乳膠漆', cat: 'wall', kind: 'paint', base: '#f4f3ef', size: 2, rough: 0.9 },
  { id: 'paint_warm', name: '米白乳膠漆', cat: 'wall', kind: 'paint', base: '#efe7da', size: 2, rough: 0.9 },
  { id: 'paint_greige', name: '奶茶灰', cat: 'wall', kind: 'paint', base: '#d9cfc2', size: 2, rough: 0.9 },
  { id: 'paint_grey', name: '淺灰色', cat: 'wall', kind: 'paint', base: '#c9cacb', size: 2, rough: 0.9 },
  { id: 'paint_charcoal', name: '炭灰色', cat: 'wall', kind: 'paint', base: '#4a4c4f', size: 2, rough: 0.9 },
  { id: 'paint_sage', name: '鼠尾草綠', cat: 'wall', kind: 'paint', base: '#b5bfa8', size: 2, rough: 0.9 },
  { id: 'paint_blue', name: '霧霾藍', cat: 'wall', kind: 'paint', base: '#a9b6c2', size: 2, rough: 0.9 },
  { id: 'paint_terracotta', name: '赤陶色', cat: 'wall', kind: 'paint', base: '#c58b6c', size: 2, rough: 0.9 },
  { id: 'paint_navy', name: '深海藍', cat: 'wall', kind: 'paint', base: '#2f3d52', size: 2, rough: 0.9 },
  { id: 'limewash', name: '礦物塗料（石灰）', cat: 'wall', kind: 'concrete', base: '#ddd3c4', size: 2.5, rough: 0.95, noise: 0.05 },
  { id: 'wood_panel', name: '木作格柵壁板', cat: 'wall', kind: 'slats', base: '#b38b62', dark: '#7e5d3d', size: 0.6, rough: 0.6 },
  { id: 'wood_panel_dark', name: '胡桃木壁板', cat: 'wall', kind: 'slats', base: '#6e4c33', dark: '#3f2a1b', size: 0.6, rough: 0.55 },
  { id: 'brick_white', name: '白色文化磚', cat: 'wall', kind: 'brick', base: '#ece8e1', grout: '#cfc9be', size: 1, rough: 0.9 },
  { id: 'wallpaper_stripe', name: '細紋壁紙', cat: 'wall', kind: 'stripe', base: '#e6ddcf', alt: '#d7cbb8', size: 0.5, rough: 0.9 },
  { id: 'tile_subway', name: '白色地鐵磚', cat: 'wall', kind: 'tile', base: '#f3f2ee', grout: '#c9c6bf', tile: 0.075, tileW: 0.15, size: 0.6, rough: 0.15, offsetRows: true },
];

export const MATERIAL_MAP = Object.fromEntries(MATERIALS.map((m) => [m.id, m]));
export function getMaterial(id) { return MATERIAL_MAP[id] || MATERIAL_MAP.paint_white; }

const canvasCache = new Map();
const RES = 512;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function shade(hex, f) {
  const [r, g, b] = hexToRgb(hex);
  const k = (c) => Math.max(0, Math.min(255, Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f))));
  return `rgb(${k(r)},${k(g)},${k(b)})`;
}
export function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}

function addNoise(ctx, amount, rnd, scale = 1) {
  const img = ctx.getImageData(0, 0, RES, RES);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 255 * amount * scale;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function blotches(ctx, base, rnd, count, alpha, sizeMax) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * RES, y = rnd() * RES, r = 10 + rnd() * sizeMax;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = shade(base, (rnd() - 0.5) * 0.25);
    g.addColorStop(0, c.replace('rgb', 'rgba').replace(')', `,${alpha})`));
    g.addColorStop(1, c.replace('rgb', 'rgba').replace(')', ',0)'));
    ctx.fillStyle = g;
    // 平鋪：在邊界處重複繪製
    for (const ox of [-RES, 0, RES]) for (const oy of [-RES, 0, RES]) {
      if (x + ox + r < 0 || x + ox - r > RES || y + oy + r < 0 || y + oy - r > RES) continue;
      ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function grain(ctx, x, y, w, h, base, dark, rnd, vertical = false) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = shade(base, (rnd() - 0.5) * 0.18);
  ctx.fillRect(x, y, w, h);
  const lines = 8 + Math.floor(rnd() * 8);
  for (let i = 0; i < lines; i++) {
    ctx.strokeStyle = mix(base, dark, 0.3 + rnd() * 0.5).replace('rgb', 'rgba').replace(')', `,${0.25 + rnd() * 0.35})`);
    ctx.lineWidth = 0.6 + rnd() * 1.6;
    ctx.beginPath();
    if (!vertical) {
      const yy = y + rnd() * h;
      ctx.moveTo(x, yy);
      for (let xx = x; xx <= x + w; xx += 16) ctx.lineTo(xx, yy + Math.sin(xx * 0.02 + i) * (1 + rnd() * 2));
    } else {
      const xx = x + rnd() * w;
      ctx.moveTo(xx, y);
      for (let yy = y; yy <= y + h; yy += 16) ctx.lineTo(xx + Math.sin(yy * 0.02 + i) * (1 + rnd() * 2), yy);
    }
    ctx.stroke();
  }
  // 木節
  if (rnd() < 0.3) {
    const kx = x + rnd() * w, ky = y + rnd() * h;
    ctx.fillStyle = mix(base, dark, 0.8).replace('rgb', 'rgba').replace(')', ',0.5)');
    ctx.beginPath(); ctx.ellipse(kx, ky, vertical ? 3 : 7, vertical ? 7 : 3, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function paintMaterial(ctx, m, rnd) {
  const px = RES / m.size; // 每公尺像素
  ctx.fillStyle = m.base;
  ctx.fillRect(0, 0, RES, RES);
  switch (m.kind) {
    case 'paint':
      blotches(ctx, m.base, rnd, 40, 0.08, 80);
      addNoise(ctx, 0.025, rnd);
      break;
    case 'planks': {
      const pw = 0.19 * px; // 板寬 19cm
      const rows = Math.round(RES / pw);
      const ph = RES / rows;
      for (let r = 0; r < rows; r++) {
        let x = -rnd() * RES * 0.6;
        while (x < RES) {
          const len = RES * (0.45 + rnd() * 0.5);
          grain(ctx, x, r * ph, len, ph, m.base, m.dark, rnd);
          if (x + len > RES) grain(ctx, x - RES, r * ph, len, ph, m.base, m.dark, mulberry32(Math.floor(rnd() * 1e9)));
          ctx.fillStyle = 'rgba(40,25,10,0.35)';
          ctx.fillRect(x + len - 1, r * ph, 1.5, ph);
          x += len;
        }
        ctx.fillStyle = 'rgba(40,25,10,0.35)';
        ctx.fillRect(0, r * ph, RES, 1.2);
      }
      addNoise(ctx, 0.03, rnd);
      break;
    }
    case 'herringbone': {
      // 人字拼：板長 = 4 × 板寬，晶格向量 (W,-W) 與 (4W,4W)，週期 8W
      const W = RES / 16;
      for (let i = -24; i < 40; i++) {
        for (let j = -12; j < 12; j++) {
          const ox = i * W + j * 4 * W, oy = -i * W + j * 4 * W;
          for (const [x, y, w, h] of [[ox, oy, 4 * W, W], [ox, oy + 4 * W, W, 4 * W]]) {
            if (x > RES || y > RES || x + w < 0 || y + h < 0) continue;
            grain(ctx, x, y, w, h, m.base, m.dark, rnd, h > w);
            ctx.strokeStyle = 'rgba(40,25,10,0.4)'; ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          }
        }
      }
      addNoise(ctx, 0.03, rnd);
      break;
    }
    case 'tile': {
      const tw = (m.tileW || m.tile) * px, th = (m.tileH || m.tile) * px;
      const cols = Math.round(RES / tw), rows = Math.round(RES / th);
      const cw = RES / cols, rh = RES / rows;
      for (let r = 0; r < rows; r++) {
        const off = m.offsetRows && r % 2 ? cw / 2 : 0;
        for (let c = -1; c < cols + 1; c++) {
          ctx.fillStyle = shade(m.base, (rnd() - 0.5) * (m.noise || 0.04));
          ctx.fillRect(c * cw + off, r * rh, cw, rh);
        }
      }
      if (m.noise) blotches(ctx, m.base, rnd, 30, 0.12, 60);
      ctx.fillStyle = m.grout;
      const g = Math.max(1, 0.004 * px);
      for (let r = 0; r <= rows; r++) ctx.fillRect(0, r * rh - g / 2, RES, g);
      for (let r = 0; r < rows; r++) {
        const off = m.offsetRows && r % 2 ? cw / 2 : 0;
        for (let c = 0; c <= cols; c++) ctx.fillRect(c * cw + off - g / 2, r * rh, g, rh);
      }
      addNoise(ctx, 0.02, rnd);
      break;
    }
    case 'hex': {
      const r = RES / 8;
      const h = Math.sqrt(3) * r;
      for (let row = -1; row < RES / h + 2; row++) {
        for (let col = -1; col < RES / (1.5 * r) + 2; col++) {
          const cx = col * 1.5 * r, cy = row * h + (col % 2 ? h / 2 : 0);
          ctx.beginPath();
          for (let k = 0; k < 6; k++) ctx.lineTo(cx + r * Math.cos((k * Math.PI) / 3), cy + r * Math.sin((k * Math.PI) / 3));
          ctx.closePath();
          ctx.fillStyle = (row + col) % 5 === 0 ? m.alt : shade(m.base, (rnd() - 0.5) * 0.05);
          ctx.fill();
          ctx.strokeStyle = m.grout; ctx.lineWidth = 2; ctx.stroke();
        }
      }
      break;
    }
    case 'marble': {
      blotches(ctx, m.base, rnd, 60, 0.15, 120);
      for (let v = 0; v < 7; v++) {
        let x = rnd() * RES, y = 0;
        const ang = (rnd() - 0.5) * 1.2;
        ctx.strokeStyle = m.vein;
        ctx.globalAlpha = 0.25 + rnd() * 0.45;
        ctx.lineWidth = 0.6 + rnd() * 2.2;
        ctx.beginPath(); ctx.moveTo(x, y);
        while (y < RES) {
          x += Math.sin(ang) * 6 + (rnd() - 0.5) * 9;
          y += 4 + rnd() * 4;
          ctx.lineTo(((x % RES) + RES) % RES === x ? x : x, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      addNoise(ctx, 0.02, rnd);
      break;
    }
    case 'travertine': {
      for (let i = 0; i < 220; i++) {
        const y = rnd() * RES;
        ctx.fillStyle = mix(m.base, m.dark, rnd()).replace('rgb', 'rgba').replace(')', ',0.35)');
        ctx.fillRect(0, y, RES, 0.5 + rnd() * 2.5);
      }
      for (let i = 0; i < 120; i++) {
        ctx.fillStyle = mix(m.base, m.dark, 0.7).replace('rgb', 'rgba').replace(')', ',0.5)');
        ctx.beginPath(); ctx.ellipse(rnd() * RES, rnd() * RES, 2 + rnd() * 8, 0.6 + rnd() * 1.5, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = 'rgba(120,100,70,0.25)';
      ctx.fillRect(0, RES / 2 - 1, RES, 2); ctx.fillRect(0, 0, RES, 1);
      ctx.fillRect(0, 0, 1, RES);
      addNoise(ctx, 0.03, rnd);
      break;
    }
    case 'terrazzo': {
      const cols = ['#9a958c', '#6f6a62', '#c9b79a', '#f7f5f1', '#8e9aa0', '#b9a58a'];
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = cols[Math.floor(rnd() * cols.length)];
        const x = rnd() * RES, y = rnd() * RES, s = 1.5 + rnd() * 6;
        ctx.beginPath();
        for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2 + rnd(); ctx.lineTo(x + Math.cos(a) * s * (0.6 + rnd() * 0.6), y + Math.sin(a) * s * (0.6 + rnd() * 0.6)); }
        ctx.fill();
      }
      addNoise(ctx, 0.02, rnd);
      break;
    }
    case 'concrete':
      blotches(ctx, m.base, rnd, 120, 0.22, 90);
      addNoise(ctx, m.noise || 0.06, rnd);
      break;
    case 'formwork': {
      blotches(ctx, m.base, rnd, 80, 0.2, 70);
      addNoise(ctx, 0.07, rnd);
      ctx.fillStyle = 'rgba(70,70,70,0.25)';
      const pw = RES / 2, ph = RES / 4;
      for (let y = 0; y < RES; y += ph) ctx.fillRect(0, y, RES, 1.5);
      for (let x = 0; x < RES; x += pw) ctx.fillRect(x, 0, 1.5, RES);
      ctx.fillStyle = 'rgba(60,60,60,0.45)';
      for (let y = ph / 2; y < RES; y += ph) for (let x = pw / 4; x < RES; x += pw / 2) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'fabric':
      for (let y = 0; y < RES; y += 2) { ctx.fillStyle = shade(m.base, (rnd() - 0.5) * 0.1); ctx.fillRect(0, y, RES, 1); }
      addNoise(ctx, 0.08, rnd);
      break;
    case 'tatami': {
      ctx.fillStyle = m.base; ctx.fillRect(0, 0, RES, RES);
      for (let x = 0; x < RES; x += 2) { ctx.fillStyle = shade(m.base, (rnd() - 0.5) * 0.12); ctx.fillRect(x, 0, 1, RES); }
      ctx.fillStyle = '#3d3a2c';
      ctx.fillRect(0, 0, RES, 6); ctx.fillRect(0, RES / 2 - 3, RES, 6);
      ctx.fillRect(0, 0, 6, RES / 2); ctx.fillRect(RES / 2 - 3, RES / 2, 6, RES / 2);
      break;
    }
    case 'slats': {
      const n = 12, sw = RES / n;
      ctx.fillStyle = m.dark; ctx.fillRect(0, 0, RES, RES);
      for (let i = 0; i < n; i++) grain(ctx, i * sw + 2, 0, sw - 5, RES, m.base, m.dark, rnd, true);
      break;
    }
    case 'brick': {
      const bw = 0.24 * px, bh = 0.06 * px;
      const rows = Math.round(RES / bh), cols = Math.round(RES / bw);
      const cw = RES / cols, rh = RES / rows;
      ctx.fillStyle = m.grout; ctx.fillRect(0, 0, RES, RES);
      for (let r = 0; r < rows; r++) {
        const off = r % 2 ? cw / 2 : 0;
        for (let c = -1; c <= cols; c++) {
          ctx.fillStyle = shade(m.base, (rnd() - 0.5) * 0.08);
          ctx.fillRect(c * cw + off + 1.5, r * rh + 1.5, cw - 3, rh - 3);
        }
      }
      addNoise(ctx, 0.04, rnd);
      break;
    }
    case 'stripe': {
      const n = 16, sw = RES / n;
      for (let i = 0; i < n; i += 2) { ctx.fillStyle = m.alt; ctx.fillRect(i * sw, 0, sw * 0.5, RES); }
      addNoise(ctx, 0.02, rnd);
      break;
    }
    default:
      addNoise(ctx, 0.03, rnd);
  }
}

export function materialCanvas(id) {
  if (canvasCache.has(id)) return canvasCache.get(id);
  const m = getMaterial(id);
  const c = document.createElement('canvas');
  c.width = c.height = RES;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  paintMaterial(ctx, m, mulberry32(hashStr(m.id)));
  canvasCache.set(id, c);
  return c;
}

export function materialSwatchURL(id) {
  const c = materialCanvas(id);
  const s = document.createElement('canvas');
  s.width = s.height = 96;
  s.getContext('2d').drawImage(c, 0, 0, RES / 2, RES / 2, 0, 0, 96, 96);
  return s.toDataURL('image/jpeg', 0.85);
}

// 家具用的細微紋理（灰階，乘上顏色使用）
const detailCache = new Map();
export function detailCanvas(kind) {
  if (detailCache.has(kind)) return detailCache.get(kind);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rnd = mulberry32(hashStr(kind));
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256);
  if (kind === 'wood') {
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = `rgba(0,0,0,${0.04 + rnd() * 0.12})`;
      ctx.lineWidth = 0.5 + rnd() * 2;
      const y = rnd() * 256;
      ctx.beginPath(); ctx.moveTo(0, y);
      for (let x = 0; x <= 256; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * 2);
      ctx.stroke();
    }
  } else if (kind === 'fabric' || kind === 'boucle' || kind === 'velvet') {
    const img = ctx.getImageData(0, 0, 256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const p = i / 4, x = p % 256, y = Math.floor(p / 256);
      const weave = kind === 'fabric' ? ((x + y) % 4 < 2 ? 10 : -10) : 0;
      const n = (rnd() - 0.5) * (kind === 'boucle' ? 90 : kind === 'velvet' ? 25 : 40) + weave;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 225 + n;
    }
    ctx.putImageData(img, 0, 0);
  } else if (kind === 'stone') {
    const img = ctx.getImageData(0, 0, 256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 30;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 230 + n;
    }
    ctx.putImageData(img, 0, 0);
  }
  detailCache.set(kind, c);
  return c;
}
