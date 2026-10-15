// 選單縮圖攝影棚：把家具、門窗與材質擺進真實房間的一角（地板、牆面、踢腳板、窗外日光），
// 先以一般即時渲染快速產生，再以光線追蹤（光線多次反彈、柔和陰影、反射與透光）重新拍攝成接近實景照片的縮圖。
// 完成的縮圖存在瀏覽器（IndexedDB），之後開啟網頁直接使用。
import * as THREE from 'three';
import { RoomEnvironment } from '../../vendor/three/addons/RoomEnvironment.js';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { buildItemObject, buildOpeningObject } from '../data/catalog.js';
import { getMaterial, materialCanvas } from '../data/materials.js';
import { realisticMaterials, makeSky } from '../editor/render-look.js';

const S = 0.01;
export const THUMB_SIZE = 256; // 渲染解析度（卡片以 2 倍密度顯示）
const SIZE = THUMB_SIZE;
const THUMB_REV = 2; // 攝影棚外觀變更時遞增，讓舊的快取失效

// 光線方向（物件座標）：像側窗的日光從右側照入，影子落在左側地板與牆上
const SUN = new THREE.Vector3(1.5, 1.15, 0.45).normalize();

let ptModule = null;
async function loadPathTracer() {
  if (!ptModule) ptModule = await import('../../vendor/pathtracer/three-gpu-pathtracer.min.js');
  return ptModule;
}

// 牆面、地板用的平面：貼圖座標以公尺計，與 3D 檢視相同（重複次數 = 1 / 材質尺寸）
function plane(w, h) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}

function surfaceMat(matId) {
  const m = getMaterial(matId);
  const t = new THREE.CanvasTexture(materialCanvas(matId));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.repeat.set(1 / m.size, 1 / m.size);
  const mat = new THREE.MeshStandardMaterial({ map: t, roughness: m.rough ?? 0.8 });
  mat.userData.matId = matId;
  return mat;
}

export class ThumbStudio {
  // floorId、wallId：房間一角使用的地板與牆面材質（依目前風格）
  constructor({ floorId = 'wood_oak', wallId = 'paint_warm' } = {}) {
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(SIZE, SIZE, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = r;

    // 天空：窗外的背景，光線追蹤時同時是日光來源（太陽放大成柔光，陰影邊緣柔和）
    this.sky = makeSky({ zenith: '#7eaee6', horizon: '#e6edf2', ground: '#b9b4a6', env: 1, width: 512 });
    this.skySun = null;
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    pmrem.dispose();
    scene.environment = this.envTex;
    scene.environmentIntensity = 0.55;
    scene.background = this.sky;
    const key = new THREE.DirectionalLight('#fff4e4', 2.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 5;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    const fill = new THREE.HemisphereLight('#f4f7ff', '#bfb2a0', 0.55);
    this.lights = [key, key.target, fill];
    this.scene = scene; this.key = key;
    this.cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);

    // 房間一角的材質：先轉成寫實材質（凹凸、清漆），每次拍攝共用
    const set = new THREE.Group();
    const floorM = surfaceMat(floorId), wallM = surfaceMat(wallId);
    const skirt = new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 0.45 });
    skirt.userData.kind = 'gloss';
    const jamb = new THREE.MeshStandardMaterial({ color: new THREE.Color(getMaterial(wallId).base), roughness: 0.9 });
    const lawn = new THREE.MeshStandardMaterial({ color: '#8d9a78', roughness: 1 });
    const table = new THREE.MeshStandardMaterial({ color: '#e9e5de', roughness: 0.55 });
    const backdrop = new THREE.MeshStandardMaterial({ color: '#f2f0eb', roughness: 0.92 });
    for (const m of [floorM, wallM, skirt, jamb, lawn, table, backdrop]) set.add(new THREE.Mesh(new THREE.BufferGeometry(), m));
    this.setMade = realisticMaterials(set, { normalMaps: true, raster: true });
    const [fm, wm, sm, jm, lm, tm, bm] = set.children.map((o) => o.material);
    this.mats = { floor: fm, wall: wm, skirt: sm, jamb: jm, lawn: lm, table: tm, backdrop: bm };
    this.srcMats = [floorM, wallM, skirt, jamb, lawn, table, backdrop];
  }

  // ------------------------------------------------------------ 場景佈置
  // 建立房間一角：地板、後牆（貼齊物件背面）、左牆與踢腳板
  corner(box, { floorY = 0, gap = 0.1, left = true, walls = true, floorM = this.mats.floor, wallM = this.mats.wall, skirt = true } = {}) {
    const g = new THREE.Group();
    const add = (geo, m, x, y, z, ry = 0, rx = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx, ry, 0); g.add(o); return o; };
    const c = box.getCenter(new THREE.Vector3());
    const zb = box.min.z - gap;
    const xl = box.min.x - Math.max(0.45, (box.max.x - box.min.x) * 0.35);
    const F = 14, H = 4.5;
    // 沒有牆時（戶外）地面延伸到遠方
    if (!walls) { add(plane(60, 60), floorM, c.x, floorY, c.z, 0, -Math.PI / 2); return g; }
    // 沒有左牆時，地板與後牆以物件為中心向兩側延伸
    const x0 = left ? xl : c.x - F / 2;
    add(plane(F, F), floorM, x0 + F / 2, floorY, zb + F / 2, 0, -Math.PI / 2);
    add(plane(F, H), wallM, x0 + F / 2, floorY + H / 2, zb);
    if (left) add(plane(F, H), wallM, xl, floorY + H / 2, zb + F / 2, Math.PI / 2);
    if (skirt) {
      const sh = 0.08, st = 0.012;
      add(new THREE.BoxGeometry(F, sh, st), this.mats.skirt, x0 + F / 2, floorY + sh / 2, zb + st / 2);
      if (left) add(new THREE.BoxGeometry(st, sh, F), this.mats.skirt, xl + st / 2, floorY + sh / 2, zb + F / 2);
    }
    return g;
  }

  // 依物件外框取景：view 為物件座標中相機所在方向
  frame(box, { view, fill = 1 }) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const c = sphere.center, R = Math.max(sphere.radius, 0.05);
    const dir = new THREE.Vector3(...view).normalize();
    const dist = (R / Math.sin(THREE.MathUtils.degToRad(this.cam.fov / 2))) * 1.0 / fill;
    this.cam.position.copy(c).addScaledVector(dir, dist);
    this.cam.near = dist / 60; this.cam.far = dist * 30;
    this.cam.aspect = 1;
    this.cam.updateProjectionMatrix();
    this.cam.lookAt(c);
    this.cam.updateMatrixWorld();
    // 主光陰影範圍貼合物件
    const k = this.key;
    k.position.copy(c).addScaledVector(SUN, R * 6);
    k.target.position.copy(c);
    const sc = k.shadow.camera;
    Object.assign(sc, { left: -R * 2.4, right: R * 2.4, top: R * 2.4, bottom: -R * 2.4, near: 0.01, far: R * 14 });
    sc.updateProjectionMatrix();
  }

  // 組合一張照片：物件 + 房間一角；traced 為 true 時物件使用光線追蹤用的材質（真實玻璃）
  compose(kind, traced) {
    const g = new THREE.Group();
    let made = [], set, frameOpts;
    if (kind.type === 'item') {
      const def = kind.def;
      const elev = def.elev || 0;
      // 吊燈先不含吊線取景，吊線另外往上延伸到畫面外
      const inner = buildItemObject({ kind: def.id, w: def.w, d: def.d, h: def.h, id: def.id, elev }, kind.pal, { ceiling: elev + def.h });
      inner.scale.setScalar(S);
      inner.position.y = elev * S;
      g.add(inner);
      made = realisticMaterials(g, { lights: def.cat === 'light', normalMaps: true, raster: !traced });
      g.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g);
      // 掛牆物件（電視、吊櫃、掛畫、鏡子）貼牆；放在桌面上的燈具以底部為地面；吊燈懸在牆前
      const onWall = !def.ceiling && elev > 0 && (elev >= 90 || def.d <= 12);
      const floorY = def.ceiling || onWall || !elev ? 0 : box.min.y;
      // 戶外柵欄放在草地上，背景是天空
      const outdoor = def.tab === 'openings';
      set = outdoor
        ? this.corner(box, { left: false, walls: false, floorM: this.mats.lawn })
        : this.corner(box, { floorY, gap: onWall ? 0 : def.ceiling ? 0.35 : Math.min(0.14, 0.04 + def.d * S * 0.1) });
      if (def.ceiling && def.h <= 10) {
        // 吸頂燈：補上天花板，從下方仰拍
        const c = box.getCenter(new THREE.Vector3());
        const ceil = new THREE.Mesh(plane(14, 14), this.mats.backdrop);
        ceil.rotation.x = Math.PI / 2;
        ceil.position.set(c.x, box.max.y + 0.001, c.z + 6);
        set.add(ceil);
      } else if (def.ceiling) {
        const cordMat = new THREE.MeshStandardMaterial({ color: '#222222', roughness: 0.6 });
        const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 3, 6), cordMat);
        const c = box.getCenter(new THREE.Vector3());
        cord.position.set(c.x, box.max.y + 1.5 - 0.005, c.z);
        set.add(cord);
        made.push(cordMat);
      }
      const low = def.ceiling ? (def.h <= 10 ? -0.45 : 0.12) : outdoor ? 0.1 : onWall ? 0.22 : 0.42;
      frameOpts = { box, view: [0.62, low, 1.0], fill: def.flat ? 1.05 : 0.92 };
    } else if (kind.type === 'opening') {
      const def = kind.def;
      const op = { kind: def.id, width: def.width, height: def.height, sill: def.sill || 0, offset: 0 };
      const T = 12;
      const o = buildOpeningObject(op, T, kind.pal);
      o.position.y = op.sill;
      const wrap = new THREE.Group();
      wrap.add(o);
      wrap.scale.setScalar(S);
      g.add(wrap);
      made = realisticMaterials(g, { normalMaps: true, raster: !traced });
      g.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g);
      set = this.openingWall(op, T * S);
      frameOpts = { box, view: [0.5, 0.2, 1.0], fill: 0.86 };
    } else {
      // 材質：圓角方塊放在淺色桌面上
      const mat = surfaceMat(kind.id);
      const edge = 0.5;
      const geo = new RoundedBoxGeometry(edge, edge, edge, 4, 0.03);
      const uv = geo.attributes.uv;
      // 紋理放大一些，讓每一面都看得到完整的花紋
      const k = edge * 1.8;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
      const box = new THREE.Mesh(geo, mat);
      box.position.y = edge / 2;
      box.rotation.y = Math.PI / 4.6;
      g.add(box);
      made = realisticMaterials(g, { normalMaps: true, raster: !traced });
      made.push(mat, mat.map);
      g.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(g);
      set = this.corner(bb, { gap: 0.35, left: false, floorM: this.mats.table, wallM: this.mats.backdrop, skirt: false });
      frameOpts = { box: bb, view: [0.55, 0.62, 1.0], fill: 1.05 };
    }
    g.add(set);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.frame(frameOpts.box, frameOpts);
    return { root: g, made };
  }

  // 門窗：整面牆中間開口，室內有地板，窗外是草地與天空
  openingWall(op, T) {
    const g = new THREE.Group();
    const wm = this.mats.wall, jm = this.mats.jamb;
    const w = op.width * S, h = op.height * S, sill = op.sill * S;
    const Wt = 9, Ht = 3.2, side = (Wt - w) / 2, top = Ht - sill - h;
    const z = T / 2;
    const piece = (pw, ph, x, y) => { if (pw <= 0 || ph <= 0) return; const m = new THREE.Mesh(plane(pw, ph), wm); m.position.set(x, y + ph / 2, z); g.add(m); };
    piece(side, Ht, -w / 2 - side / 2, 0);
    piece(side, Ht, w / 2 + side / 2, 0);
    piece(w, top, 0, sill + h);
    piece(w, sill, 0, 0);
    // 牆的厚度（開口側邊）與背面
    const box = (bw, bh, bd, x, y, zz) => { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), jm); m.position.set(x, y + bh / 2, zz); g.add(m); };
    box(0.02, Ht, T, -w / 2 - 0.01, 0, 0); box(0.02, Ht, T, w / 2 + 0.01, 0, 0);
    if (top > 0) box(w, 0.02, T, 0, sill + h, 0);
    if (sill > 0) box(w, 0.02, T, 0, sill - 0.02, 0);
    box(side, Ht, 0.02, -w / 2 - side / 2, 0, -z); box(side, Ht, 0.02, w / 2 + side / 2, 0, -z);
    if (top > 0) box(w, top, 0.02, 0, sill + h, -z);
    if (sill > 0) box(w, sill, 0.02, 0, 0, -z);
    const floor = new THREE.Mesh(plane(Wt, 8), this.mats.floor);
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, z + 4); g.add(floor);
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), this.mats.lawn);
    lawn.rotation.x = -Math.PI / 2; lawn.position.set(0, -0.02, -z - 15); g.add(lawn);
    // 踢腳板（門的開口處不加）
    const sh = 0.08, st = 0.012;
    const sk = (sw, x) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sw, sh, st), this.mats.skirt); m.position.set(x, sh / 2, z + st / 2); g.add(m); };
    if (sill > 0) sk(Wt, 0); else { sk(side, -w / 2 - side / 2); sk(side, w / 2 + side / 2); }
    return g;
  }

  // ------------------------------------------------------------ 一般即時渲染（快速預覽）
  shoot(kind) {
    const { root, made } = this.compose(kind, false);
    this.scene.add(root, ...this.lights);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.cam);
    this.scene.remove(root, ...this.lights);
    disposeTree(root, made);
    return this.renderer.domElement;
  }

  item(def, pal) { return this.shoot({ type: 'item', def, pal }); }
  opening(def, pal) { return this.shoot({ type: 'opening', def, pal }); }
  material(id) { return this.shoot({ type: 'material', id }); }

  // ------------------------------------------------------------ 光線追蹤（寫實照片）
  async initTracer() {
    const mod = await loadPathTracer();
    const r = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(SIZE, SIZE, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.05;
    this.tr = r;
    this.lost = false;
    r.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    const pt = new mod.WebGLPathTracer(r);
    pt.renderDelay = 0;
    pt.fadeDuration = 0;
    pt.minSamples = 1;
    pt.dynamicLowRes = false;
    pt.rasterizeScene = false;
    pt.bounces = 5;
    pt.filterGlossyFactor = 0.8;
    pt.textureSize.set(512, 512);
    pt.tiles.set(1, 1);
    this.pt = pt;
    // 窗外日光：太陽放大成柔和光源
    const sun = SUN.clone();
    this.skySun = makeSky({ zenith: '#7eaee6', horizon: '#e6edf2', ground: '#b9b4a6', env: 1, sun: { dir: sun, color: '#fff3e0' }, sunIrradiance: 3.4, sunRadiusDeg: 5, width: 1024 });
    const ts = new THREE.Scene();
    ts.environment = this.skySun;
    ts.background = this.skySun;
    ts.environmentIntensity = 1;
    this.tscene = ts;
    // 降噪：取樣少時平滑較強
    if (mod.DenoiseMaterial) {
      const dm = new mod.DenoiseMaterial({ blending: THREE.NoBlending });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dm);
      quad.frustumCulled = false;
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      cam.position.z = 0.5;
      this.denoise = { dm, quad };
      pt.renderToCanvasCallback = (target, renderer, q) => {
        const n = Math.max(1, pt.samples);
        dm.map = target.texture;
        dm.opacity = q.material.opacity;
        dm.sigma = Math.min(5, 2.2 + 8 / Math.sqrt(n));
        dm.kSigma = 1.2;
        dm.threshold = Math.min(0.25, Math.max(0.08, 0.9 / Math.sqrt(n)));
        const ac = renderer.autoClear;
        renderer.autoClear = false;
        renderer.render(quad, cam);
        renderer.autoClear = ac;
      };
    }
  }

  // 以光線追蹤拍攝；shouldStop() 回傳 true 時中止，paused() 回傳 true 時暫停（例如正在寫實渲染或 VR）
  async trace(kind, { samples = 128, shouldStop = () => false, paused = () => false } = {}) {
    const { root, made } = this.compose(kind, true);
    const pt = this.pt;
    try {
      this.tscene.add(root);
      this.tscene.updateMatrixWorld(true);
      pt.setScene(this.tscene, this.cam);
      let perFrame = 1, last = performance.now();
      while (pt.samples < samples) {
        await new Promise((res) => requestAnimationFrame(res));
        if (shouldStop() || this.lost) return null;
        if (paused()) { last = performance.now(); continue; }
        const now = performance.now(), dt = now - last;
        last = now;
        // 依畫面間隔調整每個畫面的取樣次數，避免拖慢編輯畫面
        if (dt < 20 && perFrame < 8) perFrame++;
        else if (dt > 40 && perFrame > 1) perFrame = Math.max(1, perFrame >> 1);
        for (let i = 0; i < perFrame && pt.samples < samples; i++) pt.renderSample();
      }
      return this.tr.domElement;
    } finally {
      this.tscene.remove(root);
      disposeTree(root, made);
    }
  }

  dispose() {
    this.envTex.dispose();
    this.sky.dispose();
    this.skySun?.dispose();
    for (const m of this.setMade) m.dispose?.();
    for (const m of this.srcMats) { m.map?.dispose(); m.dispose(); }
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    if (this.pt) {
      try { this.pt.dispose(); } catch { /* 部分資源未建立時忽略 */ }
      this.denoise?.dm.dispose();
      this.denoise?.quad.geometry.dispose();
      this.tr.dispose();
      this.tr.forceContextLoss?.();
    }
  }
}

// 只釋放物件本身的幾何與材質；房間一角的共用材質保留
function disposeTree(root, made) {
  root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  for (const m of made) m.dispose?.();
}

// 判斷畫面是否異常（全黑、全白或數值錯誤）：光線追蹤在部分顯示卡上無法正常運作
export function looksBroken(canvas) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let sum = 0, min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; min = Math.min(min, l); max = Math.max(max, l); }
  const avg = sum / (d.length / 4);
  return avg < 12 || avg > 250 || max - min < 6;
}

// ------------------------------------------------------------ 快取（IndexedDB）
const DB = 'interior-thumbs', STORE = 'thumbs';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      try {
        const q = indexedDB.open(DB, 1);
        q.onupgradeneeded = () => q.result.createObjectStore(STORE);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      } catch (e) { rej(e); }
    }).catch(() => null);
  }
  return dbp;
}

export function thumbKey(...parts) { return [THUMB_REV, SIZE, ...parts].join('|'); }

export async function thumbCacheGetAll(keys) {
  const out = new Map();
  try {
    const d = await db();
    if (!d) return out;
    await new Promise((res) => {
      const tx = d.transaction(STORE, 'readonly');
      const st = tx.objectStore(STORE);
      for (const k of keys) { const q = st.get(k); q.onsuccess = () => { if (q.result) out.set(k, q.result); }; }
      tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
    });
  } catch { /* 無法使用快取時照常產生 */ }
  return out;
}

export async function thumbCachePut(key, url) {
  try {
    const d = await db();
    if (!d) return;
    d.transaction(STORE, 'readwrite').objectStore(STORE).put(url, key);
  } catch { /* 忽略 */ }
}
