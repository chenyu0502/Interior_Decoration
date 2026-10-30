// AR 擺放家具（ar.html）：讀取網址中的家具資料，顯示 3D 預覽，並依手機支援的方式進入 AR：
// - Android Chrome（ARCore）：WebXR immersive-ar，偵測地板後點一下擺放，可移動與旋轉。
// - iPhone / iPad Safari：轉成 USDZ 以 AR 快速查看（AR Quick Look）開啟，可拖曳、旋轉。
// 家具以實際尺寸呈現（1 公分 = 0.01 公尺）。
import * as THREE from 'three';
import { OrbitControls } from '../../vendor/three/addons/OrbitControls.js';
import { RoomEnvironment } from '../../vendor/three/addons/RoomEnvironment.js';
import { CATALOG_MAP, buildItemObject } from '../data/catalog.js';
import { paletteFor } from '../data/styles.js';
import { makeLook } from '../editor/render-look.js';
import { readArLink } from './ar-link.js';

const S = 0.01;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const itemName = (it) => it.name || CATALOG_MAP[it.kind]?.name || '家具';

const state = { data: null, pick: 0, model: null, usdz: new Map() };

// ---------------------------------------------------------------- 模型
// raw：保留原始材質（匯出 USDZ 用）；否則套用寫實材質（預覽與 WebXR）
function buildModel(items, { raw = false } = {}) {
  const pal = paletteFor(state.data.s);
  const look = raw ? null : makeLook({ normalMaps: true });
  const g = new THREE.Group();
  for (const it of items) {
    const inner = buildItemObject(it, pal, {});
    inner.scale.set(it.mirror ? -S : S, S, S);
    const o = new THREE.Group();
    o.add(inner);
    o.position.set(it.x * S, (it.elev || 0) * S, it.y * S);
    o.rotation.y = -THREE.MathUtils.degToRad(it.rot || 0);
    g.add(o);
  }
  g.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    if (look) o.material = Array.isArray(o.material) ? o.material.map(look) : look(o.material);
  });
  // 底部中心放在原點：AR 擺放時對齊地板
  const box = new THREE.Box3().setFromObject(g);
  const c = box.getCenter(new THREE.Vector3());
  const wrap = new THREE.Group();
  g.position.set(-c.x, -box.min.y, -c.z);
  wrap.add(g);
  wrap.userData.size = box.getSize(new THREE.Vector3());
  return wrap;
}

// 整組保留相對位置與方向；單件時正面朝向使用者（不沿用平面圖中的旋轉與位置）
const picked = () => (state.pick < 0 ? state.data.i : [{ ...state.data.i[state.pick], x: 0, y: 0, rot: 0 }]);

// ---------------------------------------------------------------- 預覽
const canvas = $('#arCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 4, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun, sun.target, new THREE.HemisphereLight(0xffffff, 0xd8d4cc, 0.6));
const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.ShadowMaterial({ opacity: 0.22 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;

function fitPreview() {
  const size = state.model.userData.size;
  const R = Math.max(size.x, size.y, size.z, 0.3);
  floor.scale.setScalar(Math.max(size.x, size.z) * 0.9 + 0.4);
  const sc = sun.shadow.camera, e = R * 1.5;
  sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 0.1; sc.far = R * 10 + 10;
  sun.position.set(R * 1.2, R * 3 + 1, R * 1.8);
  sc.updateProjectionMatrix();
  controls.target.set(0, size.y * 0.45, 0);
  camera.position.set(R * 1.3, size.y * 0.9 + R * 0.7, R * 1.9);
  camera.near = R / 50; camera.far = R * 50;
  camera.updateProjectionMatrix();
  controls.update();
}

function resize() {
  if (renderer.xr.isPresenting) return;
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

function previewLoop() {
  controls.update();
  renderer.render(scene, camera);
}

function setPick(i) {
  state.pick = i;
  if (state.model) { scene.remove(state.model); disposeTree(state.model); }
  state.model = buildModel(picked());
  scene.add(state.model);
  fitPreview();
  const s = state.model.userData.size;
  $('#arSize').textContent = `寬 ${Math.round(s.x * 100)} × 深 ${Math.round(s.z * 100)} × 高 ${Math.round(s.y * 100)} cm`;
  for (const b of document.querySelectorAll('.ar-item')) b.classList.toggle('on', Number(b.dataset.i) === i);
}

function disposeTree(root) {
  root.traverse((o) => o.geometry?.dispose());
}

function renderList() {
  const items = state.data.i;
  const card = (i, title, sub) => `<button type="button" class="ar-item" data-i="${i}"><b>${esc(title)}</b><span>${esc(sub)}</span></button>`;
  $('#arList').innerHTML = (items.length > 1 ? card(-1, `整組（${items.length} 件）`, '保持設計中的相對位置') : '')
    + items.map((it, i) => card(i, itemName(it), `${Math.round(it.w)} × ${Math.round(it.d)} × ${Math.round(it.h)} cm`)).join('');
  $('#arList').addEventListener('click', (e) => {
    const b = e.target.closest('.ar-item');
    if (b) setPick(Number(b.dataset.i));
  });
}

// ---------------------------------------------------------------- WebXR（Android）
const xr = { session: null, hitSource: null, ref: null, reticle: null, placed: false, follow: true, model: null, shadow: null };

function makeReticle() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.12, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.015, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  g.add(ring, dot);
  g.matrixAutoUpdate = false;
  g.visible = false;
  return g;
}

async function startWebXR() {
  const overlay = $('#arOverlay');
  overlay.hidden = false;
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local-floor'],
      domOverlay: { root: overlay },
    });
  } catch (err) {
    overlay.hidden = true;
    showError(`無法啟動 AR：${err.message || err}`);
    return;
  }
  xr.session = session;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);
  xr.ref = renderer.xr.getReferenceSpace();
  const viewer = await session.requestReferenceSpace('viewer');
  xr.hitSource = await session.requestHitTestSource({ space: viewer });

  // AR 場景：家具、陰影與定位圓圈（不顯示預覽用的地板與背景）
  xr.scene = new THREE.Scene();
  xr.scene.environment = scene.environment;
  const light = new THREE.DirectionalLight(0xffffff, 1.4);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  xr.scene.add(new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 0.9), light, light.target);
  xr.light = light;
  xr.model = buildModel(picked());
  xr.model.visible = false;
  const size = xr.model.userData.size;
  xr.shadow = new THREE.Mesh(new THREE.PlaneGeometry(size.x + 1, size.z + 1).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.3 }));
  xr.shadow.receiveShadow = true;
  xr.model.add(xr.shadow);
  const e = Math.max(size.x, size.z, size.y) + 0.5, sc = light.shadow.camera;
  sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 0.05; sc.far = 20;
  xr.reticle = makeReticle();
  xr.scene.add(xr.model, xr.reticle);
  xr.placed = false; xr.follow = true;
  setTip('慢慢移動手機掃描地板，出現圓圈後點一下畫面擺放');
  syncMoveBtn();

  session.addEventListener('select', onSelect);
  session.addEventListener('end', onEnd);
  renderer.setAnimationLoop(xrLoop);
}

const tmpPos = new THREE.Vector3(), tmpQuat = new THREE.Quaternion(), tmpScale = new THREE.Vector3();

function xrLoop(t, frame) {
  if (!frame) return;
  const hits = frame.getHitTestResults(xr.hitSource);
  const pose = hits.length ? hits[0].getPose(xr.ref) : null;
  xr.reticle.visible = !!pose && xr.follow;
  if (pose) xr.reticle.matrix.fromArray(pose.transform.matrix);
  if (pose && xr.follow && xr.placed) {
    xr.reticle.matrix.decompose(tmpPos, tmpQuat, tmpScale);
    xr.model.position.copy(tmpPos);
  }
  const m = xr.model;
  xr.light.position.set(m.position.x + 1.5, m.position.y + 4, m.position.z + 1);
  xr.light.target.position.copy(m.position);
  renderer.render(xr.scene, camera);
}

// 點畫面：第一次在圓圈位置擺放並轉向使用者；移動模式下再點一次固定
function onSelect() {
  if (!xr.reticle.visible) { if (!xr.placed) setTip('還沒偵測到地板，請對著地板慢慢移動手機'); return; }
  xr.reticle.matrix.decompose(tmpPos, tmpQuat, tmpScale);
  xr.model.position.copy(tmpPos);
  if (!xr.placed) {
    const cam = renderer.xr.getCamera();
    const cp = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    xr.model.rotation.y = Math.atan2(cp.x - tmpPos.x, cp.z - tmpPos.z);
    xr.placed = true;
    xr.model.visible = true;
  }
  xr.follow = false;
  setTip('已擺放。按「移動」可換位置，↺ ↻ 旋轉方向');
  syncMoveBtn();
}

function onEnd() {
  renderer.setAnimationLoop(null);
  xr.hitSource?.cancel?.();
  xr.hitSource = null;
  if (xr.model) disposeTree(xr.model);
  xr.session = null;
  renderer.xr.enabled = false;
  $('#arOverlay').hidden = true;
  resize();
  renderer.setAnimationLoop(previewLoop);
}

function setTip(t) { $('#arTip').textContent = t; }
function syncMoveBtn() { document.querySelector('[data-xr="move"]').classList.toggle('on', xr.follow && xr.placed); }

$('#arOverlay').addEventListener('beforexrselect', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('#arOverlay').addEventListener('click', (e) => {
  const a = e.target.closest('[data-xr]')?.dataset.xr;
  if (!a || !xr.session) return;
  if (a === 'end') xr.session.end();
  else if (a === 'left' || a === 'right') xr.model.rotation.y += THREE.MathUtils.degToRad(a === 'left' ? 15 : -15);
  else if (a === 'move' && xr.placed) {
    xr.follow = !xr.follow;
    setTip(xr.follow ? '對準新位置後點一下畫面固定' : '已擺放。按「移動」可換位置，↺ ↻ 旋轉方向');
    syncMoveBtn();
  }
});

// ---------------------------------------------------------------- AR 快速查看（iPhone / iPad）
// USDZ 不支援負縮放（左右翻轉的家具），匯出前把每個網格的世界座標直接寫進幾何
function bakeForExport(root) {
  const out = new THREE.Scene();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (o.matrixWorld.determinant() < 0 && g.index) {
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      g.index.needsUpdate = true;
    }
    const m = new THREE.Mesh(g, o.material);
    out.add(m);
  });
  out.updateMatrixWorld(true);
  return out;
}

export async function makeUSDZ(items) {
  const { USDZExporter } = await import('../../vendor/three/addons/USDZExporter.js');
  const model = buildModel(items, { raw: true });
  const exp = new USDZExporter();
  const data = await exp.parseAsync(bakeForExport(model), {
    quickLookCompatible: true,
    maxTextureSize: 512, // 材質細節圖縮小，檔案較小、手機開啟較快
    ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'horizontal' } },
  });
  disposeTree(model);
  return new Blob([data], { type: 'model/vnd.usdz+zip' });
}

async function startQuickLook() {
  const btn = $('#arStart');
  const key = state.pick;
  let url = state.usdz.get(key);
  if (!url) {
    btn.disabled = true; btn.textContent = '正在產生 AR 模型…';
    try {
      url = URL.createObjectURL(await makeUSDZ(picked()));
      state.usdz.set(key, url);
    } catch (err) {
      showError(`無法產生 AR 模型：${err.message || err}`);
      return;
    } finally { btn.disabled = false; btn.textContent = startLabel(); }
  }
  const a = document.createElement('a');
  a.rel = 'ar';
  a.href = `${url}#allowsContentScaling=0`;
  a.appendChild(document.createElement('img'));
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------- 啟動
let mode = 'none';
const startLabel = () => (mode === 'webxr' ? '在我家擺放（AR）' : mode === 'quicklook' ? '用 AR 擺放到我家' : '這個裝置不支援 AR');

function showError(msg) {
  const el = $('#arError');
  el.textContent = msg;
  el.hidden = false;
}

async function detect() {
  try { if (navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')) return 'webxr'; } catch { /* 不支援 */ }
  const a = document.createElement('a');
  if (a.relList?.supports?.('ar')) return 'quicklook';
  return 'none';
}

async function main() {
  try {
    state.data = await readArLink();
  } catch (err) {
    showError(err.message);
    return;
  }
  if (!state.data || !state.data.i.length) {
    showError('沒有家具資料。請在 Interior Studio 選取家具後按「手機 AR 擺放」，再用手機掃描 QR code。');
    $('#arStart').textContent = '沒有可擺放的家具';
    return;
  }
  $('#arProject').textContent = state.data.n ? `來自設計「${state.data.n}」` : '';
  renderList();
  resize();
  setPick(state.data.i.length > 1 ? -1 : 0);
  renderer.setAnimationLoop(previewLoop);

  mode = await detect();
  const btn = $('#arStart');
  btn.textContent = startLabel();
  btn.disabled = mode === 'none';
  $('#arHint').innerHTML = mode === 'webxr'
    ? '按下後允許使用相機，對著地板慢慢移動手機，出現白色圓圈後點一下畫面即可擺放；之後可以移動位置或旋轉方向。'
    : mode === 'quicklook'
      ? '會以「AR 快速查看」開啟：對著地板移動手機，家具出現後用一指拖曳移動、兩指旋轉。家具以實際尺寸顯示。'
      : '需要支援 AR 的手機：Android 請用 Chrome（需支援 Google Play 的 AR 服務），iPhone、iPad 請用 Safari 開啟這個網址。上方仍可旋轉預覽家具。';
  btn.addEventListener('click', () => (mode === 'webxr' ? startWebXR() : mode === 'quicklook' ? startQuickLook() : null));
}

window.arApp = { state, xr, makeUSDZ, detect, startWebXR };
main();
