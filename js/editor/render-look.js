// 寫實渲染的外觀設定：物理材質（光澤、清漆、絨面、玻璃折射、凹凸）與天空（含太陽）
import * as THREE from 'three';
import { getMaterial } from '../data/materials.js';

// ---------------------------------------------------------------- 材質
// 結構材質（地板、牆面）依種類設定：粗糙度、清漆層、凹凸強度
const SURFACE = {
  planks: { rough: (r) => Math.max(0.32, r - 0.18), clearcoat: 0.35, ccRough: 0.22, bump: 1.4 },
  herringbone: { rough: (r) => Math.max(0.32, r - 0.18), clearcoat: 0.35, ccRough: 0.22, bump: 1.4 },
  tile: { rough: (r) => r, clearcoat: (r) => (r < 0.45 ? 0.8 : 0.2), ccRough: 0.06, bump: 3 },
  hex: { rough: (r) => r, clearcoat: 0.5, ccRough: 0.08, bump: 3 },
  marble: { rough: () => 0.12, clearcoat: 1, ccRough: 0.04, bump: 0.3 },
  terrazzo: { rough: () => 0.3, clearcoat: 0.7, ccRough: 0.06, bump: 0.6 },
  travertine: { rough: (r) => r, clearcoat: 0.15, ccRough: 0.3, bump: 2 },
  concrete: { rough: (r) => r, clearcoat: 0.05, ccRough: 0.5, bump: 1.2 },
  formwork: { rough: (r) => r, clearcoat: 0, ccRough: 0.5, bump: 1.6 },
  brick: { rough: () => 0.9, clearcoat: 0, ccRough: 0.5, bump: 3.5 },
  slats: { rough: (r) => r, clearcoat: 0.15, ccRough: 0.3, bump: 3 },
  stripe: { rough: () => 0.9, clearcoat: 0, ccRough: 0.5, bump: 0.4 },
  paint: { rough: () => 0.88, clearcoat: 0, ccRough: 0.5, bump: 0.5 },
  fabric: { rough: () => 1, clearcoat: 0, ccRough: 0.5, bump: 1.5, sheen: 1 },
  tatami: { rough: () => 0.85, clearcoat: 0, ccRough: 0.5, bump: 2 },
};

const normalCache = new Map();

// 由貼圖亮度產生法線貼圖：深色（磚縫、木紋）視為凹陷
function normalMapFrom(srcTex, strength) {
  const img = srcTex?.image;
  if (!img || !img.width) return null;
  const key = `${srcTex.uuid}|${strength}`;
  if (normalCache.has(key)) return normalCache.get(key);
  const w = Math.min(512, img.width), h = Math.min(512, img.height);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const src = g.getImageData(0, 0, w, h).data;
  const hgt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) hgt[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  const out = g.createImageData(w, h);
  const at = (x, y) => hgt[((y + h) % h) * w + ((x + w) % w)]; // 貼圖會重複平鋪，邊緣取另一側
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength; // 圖片列往下 = 貼圖 v 往下
    const len = Math.hypot(dx, dy, 1);
    const i = (y * w + x) * 4;
    out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
    out.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
    out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
    out.data[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = srcTex.wrapS; t.wrapT = srcTex.wrapT;
  t.repeat.copy(srcTex.repeat); t.offset.copy(srcTex.offset); t.rotation = srcTex.rotation; t.center.copy(srcTex.center);
  normalCache.set(key, t);
  return t;
}

function physical(src) {
  const p = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(p, src);
  p.defines = { STANDARD: '', PHYSICAL: '' };
  p.userData = { ...src.userData };
  return p;
}

// 將場景材質換成寫實版本（複製後替換，不影響編輯畫面）
export function realisticMaterials(root, { lights = false, normalMaps = true } = {}) {
  const map = new Map();
  const made = [];
  const convert = (m) => {
    if (!m || !m.isMeshStandardMaterial) return m;
    if (map.has(m.uuid)) return map.get(m.uuid);
    let r = m;
    const kind = m.userData?.kind;
    if (m.userData?.matId) {
      const def = getMaterial(m.userData.matId);
      const s = SURFACE[def.kind] || SURFACE.paint;
      r = physical(m);
      const rough = def.rough ?? 0.8;
      r.roughness = s.rough(rough);
      r.clearcoat = typeof s.clearcoat === 'function' ? s.clearcoat(rough) : s.clearcoat;
      r.clearcoatRoughness = s.ccRough;
      if (s.sheen) { r.sheen = 1; r.sheenRoughness = 0.7; r.sheenColor = new THREE.Color(def.base).lerp(new THREE.Color('#ffffff'), 0.3); }
      if (normalMaps) {
        const n = normalMapFrom(m.map, s.bump);
        if (n) { r.normalMap = n; r.normalScale = new THREE.Vector2(0.6, 0.6); made.push(n); }
      }
    } else if (kind) {
      switch (kind) {
        case 'glass':
          r = new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 0, roughness: 0.02, transmission: 1, ior: 1.5, thickness: 0.006, transparent: false });
          r.attenuationColor = new THREE.Color('#e6f2ef'); r.attenuationDistance = 0.4;
          break;
        case 'gloss': r = physical(m); r.roughness = 0.3; r.clearcoat = 1; r.clearcoatRoughness = 0.04; break;
        case 'ceramic': r = physical(m); r.roughness = 0.12; r.clearcoat = 1; r.clearcoatRoughness = 0.03; break;
        case 'stone': r = physical(m); r.roughness = 0.18; r.clearcoat = 0.7; r.clearcoatRoughness = 0.05; break;
        case 'wood': r = physical(m); r.roughness = 0.5; r.clearcoat = 0.25; r.clearcoatRoughness = 0.25; break;
        case 'matte': r = physical(m); r.roughness = Math.min(m.roughness, 0.6); r.clearcoat = 0.15; r.clearcoatRoughness = 0.3; break;
        case 'fabric': case 'boucle': case 'velvet':
          r = physical(m); r.roughness = 0.95; r.sheen = 1; r.sheenRoughness = kind === 'velvet' ? 0.35 : 0.7;
          r.sheenColor = m.color.clone().lerp(new THREE.Color('#ffffff'), 0.25);
          break;
        case 'sheer': r = physical(m); r.sheen = 0.6; r.sheenRoughness = 0.8; r.sheenColor = new THREE.Color('#ffffff'); break;
        case 'emissive':
          r = m.clone();
          // 開燈時燈罩、燈管真的發光；關燈時只保留些微亮度
          r.emissiveIntensity = (m.emissiveIntensity || 1) * (lights ? 1.2 : 0.12);
          break;
        default: break;
      }
    }
    if (r !== m) made.push(r);
    map.set(m.uuid, r);
    return r;
  };
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
  });
  return made;
}

// ---------------------------------------------------------------- 天空
// 等距柱狀天空貼圖（HDR）：天頂到地平線漸層、太陽光暈與太陽圓盤
// 太陽圓盤的亮度依實際涵蓋的立體角換算，讓正對太陽的照度等於 sunIrradiance，陰影邊緣會自然柔和
export function makeSky({ zenith, horizon, ground, env = 1, sun = null, sunIrradiance = 0, sunRadiusDeg = 1.4, width = 1024 }) {
  const W = width, H = width / 2;
  const data = new Float32Array(W * H * 4);
  const cz = new THREE.Color(zenith).multiplyScalar(env);
  const ch = new THREE.Color(horizon).multiplyScalar(env);
  const cg = new THREE.Color(ground);
  const sunDir = sun ? sun.dir.clone().normalize() : null;
  const sunCol = sun ? new THREE.Color(sun.color) : null;
  const cosR = Math.cos(THREE.MathUtils.degToRad(sunRadiusDeg));
  const dTheta = (2 * Math.PI) / W, dPhi = Math.PI / H;
  // 地面亮度：天空與太陽照在地面後的反射
  const groundLum = 0.25 * env + (sun ? (sunIrradiance * Math.max(0, sunDir.y)) / Math.PI * 0.35 : 0);
  const d = new THREE.Vector3(), sph = new THREE.Spherical(), c = new THREE.Color();
  const disk = [];
  let diskSolid = 0;
  for (let y = 0; y < H; y++) {
    const phi = (1 - y / H) * Math.PI; // 與 three-gpu-pathtracer 的等距柱狀座標一致
    for (let x = 0; x < W; x++) {
      sph.set(1, phi, (x / W - 0.5) * 2 * Math.PI);
      d.setFromSpherical(sph);
      const i = (y * W + x) * 4;
      if (d.y >= 0) {
        const t = Math.pow(d.y, 0.45);
        c.copy(ch).lerp(cz, t);
        if (sunDir) {
          const ca = Math.max(0, d.dot(sunDir));
          const glow = Math.pow(ca, 12) * 0.35 + Math.pow(ca, 160) * 2.2;
          c.r += sunCol.r * glow * env; c.g += sunCol.g * glow * env; c.b += sunCol.b * glow * env;
          if (ca > cosR) { disk.push(i); diskSolid += dTheta * dPhi * Math.sin(phi); }
        }
        // 地平線附近略為霧化
        const haze = Math.exp(-d.y * 18) * 0.25;
        c.lerp(ch, haze);
      } else {
        const t = Math.min(1, -d.y * 6);
        c.copy(ch).multiplyScalar(0.6).lerp(cg.clone().multiplyScalar(groundLum), t);
      }
      data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b; data[i + 3] = 1;
    }
  }
  if (disk.length && diskSolid > 0) {
    const L = sunIrradiance / diskSolid;
    for (const i of disk) { data[i] += sunCol.r * L; data[i + 1] += sunCol.g * L; data[i + 2] += sunCol.b * L; }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType, THREE.EquirectangularReflectionMapping,
    THREE.RepeatWrapping, THREE.ClampToEdgeWrapping, THREE.LinearFilter, THREE.LinearFilter);
  tex.needsUpdate = true;
  return tex;
}
