// AR 擺放家具（ar.html）：讀取網址中的家具資料，顯示 3D 預覽，並依手機支援的方式進入 AR：
// - Android Chrome（ARCore）：WebXR immersive-ar，偵測地板後點一下擺放，可移動與旋轉。
// - iPhone / iPad Safari：轉成 USDZ 以 AR 快速查看（AR Quick Look）開啟，可拖曳、旋轉。
// 家具以實際尺寸呈現（1 公分 = 0.01 公尺）。
import * as THREE from 'three';
import { OrbitControls } from '../../vendor/three/addons/OrbitControls.js';
import { RoomEnvironment } from '../../vendor/three/addons/RoomEnvironment.js';
import { CATALOG_MAP, buildItemObject } from '../data/catalog.js';
import { paletteFor } from '../data/styles.js';
import { pointInPolygon } from '../core/geometry.js';
import { makeLook } from '../editor/render-look.js';
import { readArLink } from './ar-link.js';

const S = 0.01;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const itemName = (it) => it.name || CATALOG_MAP[it.kind]?.name || '家具';

const state = { data: null, pick: 0, model: null, usdz: new Map(), outline: true, wallIdx: 0, walls: null };

// ---------------------------------------------------------------- 模型
// 房間地板範圍：半透明地板、邊線與牆角的矮柱，方便在 AR 中對齊自己家的牆角（都用網格，USDZ 也能匯出）
const OUTLINE = { fill: new THREE.MeshStandardMaterial({ color: 0x2563eb, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, roughness: 1 }),
  edge: new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.8 }), post: new THREE.MeshStandardMaterial({ color: 0x2563eb, transparent: true, opacity: 0.55, roughness: 0.8 }) };
function roomOutline(polys) {
  const g = new THREE.Group();
  for (const pts of polys) {
    if (pts.length < 3) continue;
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x * S, y * S)));
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2), OUTLINE.fill);
    fill.position.y = 0.003;
    fill.receiveShadow = true;
    g.add(fill);
    pts.forEach(([x1, y1], i) => {
      const [x2, y2] = pts[(i + 1) % pts.length];
      const L = Math.hypot(x2 - x1, y2 - y1) * S;
      if (L < 0.01) return;
      const e = new THREE.Mesh(new THREE.BoxGeometry(L, 0.012, 0.03), OUTLINE.edge);
      e.position.set(((x1 + x2) / 2) * S, 0.006, ((y1 + y2) / 2) * S);
      e.rotation.y = -Math.atan2(y2 - y1, x2 - x1);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 0.04), OUTLINE.post);
      post.position.set(x1 * S, 0.2, y1 * S);
      g.add(e, post);
    });
  }
  g.userData.outline = true;
  return g;
}

// ---------------------------------------------------------------- 兩個牆角對齊
// 可用來對齊的牆：房間輪廓的每一邊（50 cm 以上），依長度由長到短。
// A、B 為站在房間內面對這面牆時左邊、右邊的牆角（平面座標，公分）
function alignWalls() {
  if (state.walls) return state.walls;
  const out = [];
  for (const pts of state.data.r) {
    if (pts.length < 3) continue;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 50) return;
      let nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len; // 法線，調整為朝向房間內
      if (!pointInPolygon((p[0] + q[0]) / 2 + nx * 10, (p[1] + q[1]) / 2 + ny * 10, pts)) { nx = -nx; ny = -ny; }
      const rx = ny, ry = -nx; // 面向牆時的右方
      const [A, B] = p[0] * rx + p[1] * ry < q[0] * rx + q[1] * ry ? [p, q] : [q, p];
      out.push({ A, B, len });
    });
  }
  out.sort((a, b) => b.len - a.len);
  return (state.walls = out);
}

const MARK = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 });
function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const x = c.getContext('2d');
  x.fillStyle = '#dc2626'; x.beginPath(); x.arc(48, 48, 44, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff'; x.font = '700 60px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 48, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  sp.scale.setScalar(0.26);
  sp.renderOrder = 10;
  return sp;
}
// 牆角標記：紅色細柱與 A / B 字樣（pos 為 3D 座標，公尺）
function cornerPin(text, pos) {
  const g = new THREE.Group();
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 8), MARK);
  rod.position.y = 0.25;
  const sp = labelSprite(text);
  sp.position.y = 0.62;
  g.add(rod, sp);
  g.position.copy(pos);
  return g;
}
// 要對齊的牆：紅色邊線與兩端的 A、B 標記（加在家具群組內，與房間輪廓同一座標）
function wallMarker() {
  const w = alignWalls()[state.wallIdx];
  const g = new THREE.Group();
  g.userData.wallMarker = true;
  if (!w) return g;
  const [ax, ay] = w.A, [bx, by] = w.B;
  const strip = new THREE.Mesh(new THREE.BoxGeometry(w.len * S, 0.02, 0.05), MARK);
  strip.position.set(((ax + bx) / 2) * S, 0.012, ((ay + by) / 2) * S);
  strip.rotation.y = -Math.atan2(by - ay, bx - ax);
  g.add(strip, cornerPin('A', new THREE.Vector3(ax * S, 0, ay * S)), cornerPin('B', new THREE.Vector3(bx * S, 0, by * S)));
  return g;
}
function refreshMarker(model) {
  const g = model?.children[0];
  if (!g) return;
  const old = g.children.find((o) => o.userData.wallMarker);
  if (old) { g.remove(old); disposeTree(old); }
  if (showOutline()) g.add(wallMarker());
}

// raw：保留原始材質（匯出 USDZ 用）；否則套用寫實材質（預覽與 WebXR）；outline：房間地板範圍
function buildModel(items, { raw = false, outline = showOutline() } = {}) {
  const pal = paletteFor(state.data.s);
  const look = raw ? null : makeLook({ normalMaps: true });
  const g = new THREE.Group();
  for (const it of items) {
    const inner = buildItemObject(it, pal, { noContents: true });
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
  if (outline) g.add(roomOutline(state.data.r));
  // 底部中心放在原點：AR 擺放時對齊地板（對齊用的牆標記在量完範圍後才加入，不影響中心）
  const box = new THREE.Box3().setFromObject(g);
  const c = box.getCenter(new THREE.Vector3());
  const wrap = new THREE.Group();
  g.position.set(-c.x, -box.min.y, -c.z);
  wrap.add(g);
  wrap.userData.size = box.getSize(new THREE.Vector3());
  if (outline && !raw) g.add(wallMarker());
  return wrap;
}

// 整組保留相對位置與方向；單件時正面朝向使用者（不沿用平面圖中的旋轉與位置）
const showOutline = () => state.pick < 0 && state.outline && state.data.r.length > 0;
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
  faceWall();
  controls.update();
}

// 整個房間時，預覽視角從房間內面向對齊用的牆（A 在左、B 在右，和實際站的方向相同）
function faceWall() {
  const w = showOutline() && alignWalls()[state.wallIdx];
  if (!w) return;
  const g = state.model.children[0], size = state.model.userData.size;
  const a = new THREE.Vector3(w.A[0] * S + g.position.x, 0, w.A[1] * S + g.position.z);
  const b = new THREE.Vector3(w.B[0] * S + g.position.x, 0, w.B[1] * S + g.position.z);
  const r = b.clone().sub(a).normalize(), n = new THREE.Vector3(-r.z, 0, r.x); // 由牆指向房間內
  const mid = a.clone().add(b).multiplyScalar(0.5), R = Math.max(size.x, size.z);
  controls.target.copy(mid).addScaledVector(n, R * 0.45).setY(size.y * 0.3);
  const far = camera.aspect < 1 ? 2.4 : 1.7; // 直式手機畫面較窄，鏡頭拉遠一些
  camera.position.copy(mid).addScaledVector(n, R * far).setY(size.y * 0.9 + R * 0.6);
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
  $('#arOutlineRow').hidden = !(i < 0 && state.data.r.length);
  syncWallRow();
}

function syncWallRow() {
  const ws = state.data.r.length ? alignWalls() : [];
  const row = $('#arWallRow');
  row.hidden = !showOutline() || !ws.length;
  if (row.hidden) return;
  const w = ws[state.wallIdx];
  $('#arWallInfo').textContent = `對齊用的牆：紅色標示（長 ${(w.len / 100).toFixed(2)} m，左 A、右 B）`;
  $('#arWallNext').hidden = ws.length < 2;
}

function nextWall() {
  const ws = alignWalls();
  if (ws.length < 2) return;
  state.wallIdx = (state.wallIdx + 1) % ws.length;
  refreshMarker(state.model);
  syncWallRow();
  faceWall();
  controls.update();
}

function disposeTree(root) {
  root.traverse((o) => o.geometry?.dispose());
}

function renderList() {
  const items = state.data.i;
  const card = (i, title, sub) => `<button type="button" class="ar-item" data-i="${i}"><b>${esc(title)}</b><span>${esc(sub)}</span></button>`;
  const whole = items.length > 1 || state.data.r.length;
  $('#arList').innerHTML = (whole ? card(-1, state.data.r.length ? `整個房間（${items.length} 件）` : `整組（${items.length} 件）`, '保持設計中的相對位置') : '')
    + items.map((it, i) => card(i, itemName(it), `${Math.round(it.w)} × ${Math.round(it.d)} × ${Math.round(it.h)} cm`)).join('');
  $('#arList').addEventListener('click', (e) => {
    const b = e.target.closest('.ar-item');
    if (b) setPick(Number(b.dataset.i));
  });
}

// ---------------------------------------------------------------- WebXR（Android）
const xr = { session: null, hitSource: null, ref: null, reticle: null, placed: false, follow: true, model: null, shadow: null, align: false, points: [], pins: [] };

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
  // 整個房間：點兩個牆角自動對齊，旋轉只用來微調（1°）
  xr.align = showOutline() && alignWalls().length > 0;
  xr.step = xr.align ? 1 : 15;
  for (const b of document.querySelectorAll('[data-xr="left"], [data-xr="right"]')) b.textContent = `${b.dataset.xr === 'left' ? '↺' : '↻'} ${xr.step}°`;
  for (const b of document.querySelectorAll('[data-xr="wall"], [data-xr="realign"]')) b.hidden = !xr.align;
  document.querySelector('[data-xr="wall"]').hidden = !xr.align || alignWalls().length < 2;
  document.querySelector('[data-xr="move"]').hidden = xr.align;
  if (xr.align) restartAlign();
  else setTip('慢慢移動手機掃描地板，出現圓圈後點一下畫面擺放');
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

// ---- 兩個牆角對齊（WebXR）
function restartAlign() {
  for (const p of xr.pins) { xr.scene.remove(p); disposeTree(p); }
  xr.pins = []; xr.points = [];
  xr.placed = false; xr.follow = true;
  xr.model.visible = false;
  const w = alignWalls()[state.wallIdx];
  setTip(`第 1 步：面對設計中紅色標示的牆（長 ${(w.len / 100).toFixed(2)} m），把圓圈移到左邊牆角 A 的地板上，點一下`);
}

function alignCorner(pos) {
  xr.points.push(pos.clone());
  const pin = cornerPin(xr.points.length === 1 ? 'A' : 'B', pos);
  xr.scene.add(pin);
  xr.pins.push(pin);
  if (xr.points.length === 1) { setTip('第 2 步：沿著同一面牆，把圓圈移到右邊牆角 B 的地板上，點一下'); return; }
  const [RA, RB] = xr.points;
  const real = Math.hypot(RB.x - RA.x, RB.z - RA.z);
  if (real < 0.3) { restartAlign(); setTip('兩個點太近了，請重新點：先點左邊牆角 A，再點右邊牆角 B'); return; }
  // 設計中 A、B 在家具群組內的位置（公尺）
  const w = alignWalls()[state.wallIdx], g = xr.model.children[0];
  const a = new THREE.Vector3(w.A[0] * S + g.position.x, 0, w.A[1] * S + g.position.z);
  const b = new THREE.Vector3(w.B[0] * S + g.position.x, 0, w.B[1] * S + g.position.z);
  // 讓設計的 A→B 方向轉到實際的 A→B 方向，兩邊的中點重合（長度誤差平均分到兩端）
  const th = Math.atan2(b.z - a.z, b.x - a.x) - Math.atan2(RB.z - RA.z, RB.x - RA.x);
  xr.model.rotation.y = th;
  const midD = a.add(b).multiplyScalar(0.5).applyAxisAngle(UP, th);
  xr.pivot = RA.clone().add(RB).multiplyScalar(0.5);
  xr.model.position.set(xr.pivot.x - midD.x, (RA.y + RB.y) / 2, xr.pivot.z - midD.z);
  xr.placed = true; xr.follow = false; xr.model.visible = true;
  const diff = Math.round((real - w.len * S) * 100);
  setTip(`已對齊。設計牆長 ${(w.len / 100).toFixed(2)} m，實際 ${real.toFixed(2)} m（${diff === 0 ? '相同' : `${diff > 0 ? '長' : '短'} ${Math.abs(diff)} cm`}）`
    + (Math.abs(diff) > 15 ? '。相差較大，請確認兩點是同一面牆的兩端，可按「重新對齊」' : ''));
}

const UP = new THREE.Vector3(0, 1, 0);
// 旋轉：對齊後以兩個牆角的中點為軸微調，否則以家具中心旋轉
function rotateModel(deg) {
  const d = THREE.MathUtils.degToRad(deg);
  if (xr.align && xr.placed && xr.pivot) {
    const off = xr.model.position.clone().sub(xr.pivot).applyAxisAngle(UP, d);
    xr.model.position.copy(xr.pivot).add(off);
  }
  xr.model.rotation.y += d;
}

// 點畫面：第一次在圓圈位置擺放並轉向使用者；移動模式下再點一次固定（整個房間時改為依序點兩個牆角）
function onSelect() {
  if (xr.align) {
    if (xr.placed) { setTip('已對齊。要重新點牆角請按「重新對齊」，要換一面牆請按「換一面牆」'); return; }
    if (!xr.reticle.visible) { setTip('還沒偵測到地板，請對著牆角的地板慢慢移動手機'); return; }
    xr.reticle.matrix.decompose(tmpPos, tmpQuat, tmpScale);
    alignCorner(tmpPos);
    return;
  }
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
  setTip(showOutline() ? '已擺放。用 ↺ ↻ 讓藍色範圍的邊對齊牆面，按「移動」可換位置' : '已擺放。按「移動」可換位置，↺ ↻ 旋轉方向');
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
  else if (a === 'left' || a === 'right') rotateModel(a === 'left' ? xr.step : -xr.step);
  else if (a === 'realign' && xr.align) restartAlign();
  else if (a === 'wall' && xr.align) { nextWall(); refreshMarker(xr.model); restartAlign(); }
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
  const key = `${state.pick}:${showOutline()}`;
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
  if (!state.data || (!state.data.i.length && !state.data.r.length)) {
    showError('沒有家具資料。請在 Interior Studio 選取家具後按「手機 AR 擺放」，再用手機掃描 QR code。');
    $('#arStart').textContent = '沒有可擺放的家具';
    return;
  }
  $('#arProject').textContent = state.data.n ? `來自設計「${state.data.n}」` : '';
  renderList();
  $('#arOutline').addEventListener('change', (e) => { state.outline = e.target.checked; setPick(state.pick); });
  $('#arWallNext').addEventListener('click', nextWall);
  resize();
  setPick(state.data.i.length > 1 || state.data.r.length ? -1 : 0);
  renderer.setAnimationLoop(previewLoop);

  mode = await detect();
  const btn = $('#arStart');
  btn.textContent = startLabel();
  btn.disabled = mode === 'none';
  $('#arHint').innerHTML = mode === 'webxr'
    ? '按下後允許使用相機，對著地板慢慢移動手機，出現白色圓圈後點一下畫面即可擺放；之後可以移動位置或旋轉方向。整個房間擺放時，面對上方紅色標示的牆，依序點左邊牆角 A、右邊牆角 B 的地板，就會自動對齊。'
    : mode === 'quicklook'
      ? '會以「AR 快速查看」開啟：對著地板移動手機，家具出現後用一指拖曳移動、兩指旋轉。家具以實際尺寸顯示；整個房間擺放時，可用藍色範圍對齊牆角（iPhone 的 AR 快速查看無法點牆角自動對齊，需手動移動）。'
      : '需要支援 AR 的手機：Android 請用 Chrome（需支援 Google Play 的 AR 服務），iPhone、iPad 請用 Safari 開啟這個網址。上方仍可旋轉預覽家具。';
  btn.addEventListener('click', () => (mode === 'webxr' ? startWebXR() : mode === 'quicklook' ? startQuickLook() : null));
}

window.arApp = { state, xr, makeUSDZ, detect, startWebXR };
main();
