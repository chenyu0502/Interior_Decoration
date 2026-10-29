// 3D 檢視：由平面圖資料即時生成牆體、門窗、地板與家具
import * as THREE from 'three';
import { OrbitControls } from '../../vendor/three/addons/OrbitControls.js';
import { RoomEnvironment } from '../../vendor/three/addons/RoomEnvironment.js';
import { store } from '../core/state.js';
import { wallFrame, wallLength, polygonBBox, snap, clamp } from '../core/geometry.js';
import { wallJoins, projectBounds } from '../core/model.js';
import { CATALOG_MAP, buildItemObject, buildOpeningObject } from '../data/catalog.js';
import { materialCanvas, getMaterial } from '../data/materials.js';
import { paletteFor } from '../data/styles.js';
import { enableGyro } from './pano-viewer.js';
import { VRMode } from './vr.js';
import { LiveTrace } from './live-trace.js';
import { makeLook, makeSky } from './render-look.js';

const S = 0.01; // 公分 → 公尺

export class View3D {
  constructor(container, app) {
    this.container = container;
    this.app = app;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 與寫實渲染相同的色調（PBR Neutral），即時畫面與實景照片色彩一致
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.mobile = !!window.matchMedia?.('(pointer: coarse)').matches;
    this.looks = {};
    this.scene = new THREE.Scene();
    // 背景天空：從窗戶看出去是天空而不是單色
    this.skyDay = makeSky({ zenith: '#8db6e6', horizon: '#e8eef3', ground: '#cfc9bd', env: 1, width: 512 });
    this.skyNight = makeSky({ zenith: '#05080f', horizon: '#121829', ground: '#14161b', env: 1, width: 256 });
    this.scene.background = this.skyDay;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
    this.camera.position.set(8, 9, 12);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 60;

    // 燈光
    this.hemi = new THREE.HemisphereLight('#ffffff', '#b9a894', 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff3e0', 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    // 地面
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: '#dfe3e6', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.002;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;

    this.structure = new THREE.Group();
    this.itemsGroup = new THREE.Group();
    this.lightsGroup = new THREE.Group();
    this.scene.add(this.structure, this.itemsGroup, this.lightsGroup);
    this.itemCache = new Map();
    this.texCache = new Map();
    this.structKey = '';
    this.mode = 'orbit';
    this.walk = { yaw: 0, pitch: 0, keys: new Set(), pos: new THREE.Vector3(), joy: { x: 0, y: 0 }, gyro: null, gyroOffset: null };
    this.raycaster = new THREE.Raycaster();
    this.selectionBox = new THREE.BoxHelper(undefined, 0x2563eb);
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);
    this.dirty = true;
    this.firstBuild = true;

    this._bindEvents();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    store.on('change', (reason) => { this.needsSync = true; this._lastReason = reason; this.live.activity(true); });
    store.on('select', () => { this.updateSelection(); this.live.activity(); });
    this.vr = new VRMode(this);
    // 實景模式：停止操作後以光線追蹤把畫面算成照片
    this.live = new LiveTrace(this, { mobile: this.mobile });
    this._camSig = '';
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    if (this.tour) return; // 錄影期間維持影片解析度
    const r = this.container.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.live?.activity();
  }

  get visible() { return this.container.offsetParent !== null && this.container.clientWidth > 2; }

  tick() {
    // VR 進行中：不受頁面版面影響，持續以頭盔視角渲染
    if (this.vr.active) {
      if (this.live.covering || this.live.busy) this.live.cancel();
      const dt = Math.min(0.05, this.clock.getDelta());
      if (this.needsSync) { this.needsSync = false; this.sync(); this.renderer.shadowMap.needsUpdate = true; }
      this.vr.update(dt);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // 導覽影片錄製中：由導覽接手相機並以固定解析度輸出
    if (this.tour) {
      if (this.live.covering || this.live.busy) this.live.cancel();
      this.tour.frame(this.clock.getDelta());
      return;
    }
    if (!this.visible) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    let changed = false;
    if (this.needsSync) { this.needsSync = false; this.sync(); changed = true; }
    if (this.mode === 'walk') this._walkStep(dt);
    else this.controls.update();
    if (this.animateDoors(dt)) changed = true;
    if (this.selectionBox.visible && this.selectionBox.object) this.selectionBox.update();
    // 視角有變動就取消實景照片
    this.camera.updateMatrixWorld();
    const sig = this.camera.matrixWorld.elements.map((x) => x.toFixed(4)).join() + this.camera.projectionMatrix.elements[0].toFixed(4);
    if (sig !== this._camSig) { this._camSig = sig; this.live.activity(); changed = true; }
    // 照片蓋在畫面上且沒有變動時，不必重畫即時畫面
    if (changed || !this.live.covering) this.renderer.render(this.scene, this.camera);
    // 日照模擬的俯瞰畫面需要「看得穿、但擋得住陽光」的天花板，光線追蹤做不到，只在漫遊時計算實景
    this.live.tick(!!this.app.studio?.running || (!!this.sunSim && this.mode !== 'walk'));
  }

  // ---------------------------------------------------- 場景同步
  texture(matId) {
    if (this.texCache.has(matId)) return this.texCache.get(matId);
    const m = getMaterial(matId);
    const t = new THREE.CanvasTexture(materialCanvas(matId));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.repeat.set(1 / m.size, 1 / m.size);
    const mat = new THREE.MeshStandardMaterial({ map: t, roughness: m.rough ?? 0.8, metalness: 0, envMapIntensity: m.rough < 0.3 ? 1 : 0.5 });
    mat.userData.matId = matId; // 寫實渲染依材質種類調整反射與凹凸
    this.texCache.set(matId, mat);
    return mat;
  }

  sync() {
    const P = store.project;
    const pal = paletteFor(P.design.styleId);
    const palKey = JSON.stringify(pal);
    const sKey = JSON.stringify([P.walls, P.rooms, P.openings, P.settings.showCeiling, P.settings.wallHeight, P.settings.cutaway, palKey, this.mode, !!this.sunSim]);
    if (sKey !== this.structKey) {
      this.structKey = sKey;
      this.buildStructure(pal);
      this.applyLook(this.structure);
      this.collectDoors();
    }
    this.syncItems(pal, palKey);
    this.applyLighting();
    // 日夜切換時燈罩發光程度不同，重新套用寫實材質
    const night = !!P.settings.night;
    if (night !== this._lookNight) { this._lookNight = night; this.applyLook(this.structure); this.applyLook(this.itemsGroup); }
    if (this.firstBuild && (P.walls.length || P.items.length)) { this.firstBuild = false; this.resetView(); }
    this.updateSelection();
  }

  // ---------------------------------------------------- 門的開關（漫遊時點門）
  // 收集每扇門的門片；重建牆體後依目前開關狀態擺好
  // 門窗以整扇（所有門片 / 窗扇一起）開關；家具的每扇門、每個抽屜各自開關（鍵為「物件編號#序號」）
  collectDoors() {
    this.doors = this.doors || new Map();
    for (const k of [...this.doors.keys()]) if (!k.includes('#')) this.doors.delete(k);
    this.doorRoots = new Map(); // 門窗的整體（含門框），用來判斷點在門口範圍
    this.structure.traverse((o) => {
      const oid = o.userData.openingId;
      if (oid && o.parent?.userData.openingId !== oid && !this.doorRoots.has(oid)) this.doorRoots.set(oid, o);
      const d = o.userData.door;
      if (!d) return;
      o.userData.partKey = oid;
      if (!this.doors.has(oid)) this.doors.set(oid, []);
      this.doors.get(oid).push({ obj: o, door: d, x0: o.position.x, z0: o.position.z });
    });
    this.doorState = this.doorState || new Map();
    for (const [id] of this.doors) if (!id.includes('#')) this.poseDoor(id);
  }

  collectItemParts(obj, itemId) {
    this.doors = this.doors || new Map();
    this.doorState = this.doorState || new Map();
    for (const k of [...this.doors.keys()]) if (k.startsWith(`${itemId}#`)) this.doors.delete(k);
    let n = 0;
    obj.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    const list = [];
    obj.traverse((o) => {
      const d = o.userData.door;
      if (!d) return;
      const key = `${itemId}#${n++}`;
      o.userData.partKey = key;
      // 關閉時的中心（物件座標）：門已打開時點櫃內，也能找到原本位置的門片關上
      const home = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).applyMatrix4(inv);
      this.doors.set(key, [{ obj: o, door: d, x0: o.position.x, z0: o.position.z, home, item: obj }]);
      list.push(key);
    });
    for (const key of list) this.poseDoor(key);
  }

  poseDoor(id) {
    const st = this.doorState.get(id);
    const p = st ? st.p : 0;
    const e = p * p * (3 - 2 * p); // 緩入緩出
    for (const { obj, door, x0, z0 } of this.doors.get(id) || []) {
      if (door.type === 'swing') obj.rotation.y = door.angle * e;
      else if (door.type === 'flip') obj.rotation.x = door.angle * e;
      else { obj.position.x = x0 + (door.dx || 0) * e; obj.position.z = z0 + (door.dz || 0) * e; }
    }
  }

  toggleDoor(id) {
    if (!this.doors?.has(id)) return false;
    const st = this.doorState.get(id) || { p: 0, target: 0 };
    st.target = st.target ? 0 : 1;
    this.doorState.set(id, st);
    this.live.activity(true);
    return true;
  }

  // 每個畫面推進開關門動畫；回傳是否仍在動
  animateDoors(dt) {
    if (!this.doorState) return false;
    let moving = false;
    for (const [id, st] of this.doorState) {
      if (st.p === st.target) continue;
      st.p = st.target > st.p ? Math.min(1, st.p + dt / 0.7) : Math.max(0, st.p - dt / 0.7);
      this.poseDoor(id);
      moving = true;
      if (st.p === st.target) this.live.activity(true); // 動畫結束後實景重新計算
    }
    return moving;
  }

  // 找出畫面上該點、伸手可及（3.5 公尺內）的門
  doorAt(e) {
    if (!this.doors?.size) return null;
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    this.raycaster.far = 3.5;
    const hit = this.raycaster.intersectObjects([this.structure, this.itemsGroup], true)[0];
    // 點到門片、抽屜或窗扇本身
    for (let o = hit?.object; o; o = o.parent) if (o.userData.partKey) return o.userData.partKey;
    const id = hit?.object.userData.openingId;
    if (id && this.doors.has(id)) return id;
    // 點到櫃體：開關離點擊位置最近的門片或抽屜（50 公分內）
    const itemId = hit?.object.userData.itemId;
    if (itemId) {
      let near = null, nd = 0.6;
      const c = new THREE.Vector3();
      for (const [k, parts] of this.doors) {
        if (!k.startsWith(`${itemId}#`)) continue;
        const pt = parts[0];
        c.copy(pt.home).applyMatrix4(pt.item.matrixWorld);
        const dd = c.distanceTo(hit.point);
        if (dd < nd) { nd = dd; near = k; }
      }
      if (near) return near;
    }
    // 門已打開時點門口中間：檢查視線是否穿過門框範圍
    const ray = this.raycaster.ray, p = new THREE.Vector3();
    let best = null, bestD = hit ? hit.distance + 0.05 : 3.5;
    for (const oid of this.doors.keys()) {
      const root = this.doorRoots?.get(oid);
      if (!root) continue;
      const box = new THREE.Box3().setFromObject(root);
      if (!ray.intersectBox(box, p)) continue;
      const d = p.distanceTo(ray.origin);
      if (d < bestD) { bestD = d; best = oid; }
    }
    return best;
  }

  // 寫實材質：布料絨面、木作與烤漆清漆、石材與磁磚反光、凹凸紋理（手機省略凹凸以維持流暢）
  applyLook(root) {
    const night = !!store.project.settings.night;
    const key = night ? 'night' : 'day';
    const conv = this.looks[key] || (this.looks[key] = makeLook({ lights: night, normalMaps: !this.mobile, raster: true }));
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
      // 玻璃與紗簾不擋陽光
      const k = (Array.isArray(o.material) ? o.material[0] : o.material)?.userData?.kind;
      if (k === 'glass' || k === 'sheer') o.castShadow = false;
    });
  }

  // 日照模擬：sim = { dir: {x,y,z} 朝向太陽, alt, color, intensity }，null 結束
  setSunSim(sim) {
    const was = !!this.sunSim;
    this.sunSim = sim;
    if (was !== !!sim) this.needsSync = true; // 天花板、矮牆需要重建
    this.applyLighting();
    this.renderer.shadowMap.needsUpdate = true;
    this.live.activity(true);
  }

  clearGroup(g) {
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  buildStructure() {
    const P = store.project;
    this.clearGroup(this.structure);
    const joins = wallJoins(P.walls);
    const edgeMat = new THREE.MeshStandardMaterial({ color: '#f1efea', roughness: 0.9 });
    // 牆
    for (const w of P.walls) {
      const L = wallLength(w);
      if (L < 1) continue;
      const f = wallFrame(w);
      const j = joins.get(w.id) || { extS: 0, extE: 0 };
      const fullH = w.height || P.settings.wallHeight;
      const cut = this.cutHeight();
      const H = Math.min(fullH, cut);
      const T = w.thickness;
      const start = -j.extS, end = L + j.extE;
      const ops = P.openings.filter((o) => o.wallId === w.id).map((o) => ({ ...o, a: o.offset - o.width / 2, b: o.offset + o.width / 2 })).sort((a, b) => a.a - b.a);
      const pieces = [];
      let cur = start;
      for (const o of ops) {
        const a = clamp(o.a, start, end), b = clamp(o.b, start, end);
        if (a > cur) pieces.push([cur, a, 0, H]);
        if (o.sill > 0 && o.sill < H) pieces.push([a, b, 0, o.sill]);
        const top = o.sill + o.height;
        if (top < H) pieces.push([a, b, top, H]);
        if (o.sill >= H) pieces.push([a, b, 0, H]);
        cur = Math.max(cur, b);
      }
      if (cur < end) pieces.push([cur, end, 0, H]);
      const wallGroup = new THREE.Group();
      wallGroup.position.set(w.x1 * S, 0, w.y1 * S);
      wallGroup.rotation.y = -f.angle;
      wallGroup.userData = { wallId: w.id };
      const mats = [edgeMat, edgeMat, edgeMat, edgeMat, this.texture(w.matA || 'paint_white'), this.texture(w.matB || 'paint_white')];
      for (const [u0, u1, y0, y1] of pieces) {
        const len = u1 - u0, h = y1 - y0;
        if (len < 0.5 || h < 0.5) continue;
        const geo = new THREE.BoxGeometry(len * S, h * S, T * S);
        scaleBoxUV(geo, len * S, h * S, T * S, u0 * S, y0 * S, (L - u1) * S);
        const mesh = new THREE.Mesh(geo, mats);
        mesh.position.set(((u0 + u1) / 2) * S, ((y0 + y1) / 2) * S, 0);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.userData = { wallId: w.id };
        wallGroup.add(mesh);
      }
      // 門窗（剖切模式下只保留低於剖切高度的門窗）
      for (const o of ops) {
        if (o.sill + o.height > H + 1 && cut < fullH) continue;
        const obj = buildOpeningObject(o, T, paletteFor(P.design.styleId));
        obj.scale.setScalar(S);
        obj.position.set(o.offset * S, o.sill * S, 0);
        obj.traverse((m) => { m.userData.openingId = o.id; });
        wallGroup.add(obj);
      }
      this.structure.add(wallGroup);
    }
    // 地板與天花板
    for (const r of P.rooms) {
      if (r.points.length < 3) continue;
      const shape = new THREE.Shape(r.points.map(([x, y]) => new THREE.Vector2(x * S, -y * S)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      const floor = new THREE.Mesh(geo, this.texture(r.floor || 'wood_oak'));
      floor.position.y = 0.002;
      floor.receiveShadow = true;
      floor.userData = { roomId: r.id };
      this.structure.add(floor);
      // 日照模擬時一律加上天花板：天花板只有朝下的一面，從上方俯瞰仍看得到室內，但會擋住陽光
      if ((P.settings.showCeiling && !P.settings.cutaway) || this.mode === 'walk' || this.mode === 'vr' || this.mode === 'tour' || this.sunSim) {
        // 天花板朝下：形狀以 (x, y) 建立再轉 +90°，位置才會與地板重疊（地板用 (x, -y) 轉 -90°）
        const cg = new THREE.ShapeGeometry(new THREE.Shape(r.points.map(([x, y]) => new THREE.Vector2(x * S, y * S))));
        cg.rotateX(Math.PI / 2);
        const ceil = new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ color: '#fbfaf7', roughness: 0.95 }));
        ceil.position.y = P.settings.wallHeight * S;
        ceil.userData = { roomId: r.id, ceiling: true };
        this.structure.add(ceil);
      }
    }
    // 依平面範圍調整陰影
    const b = projectBounds(P);
    const cx = ((b.x0 + b.x1) / 2) * S, cz = ((b.y0 + b.y1) / 2) * S;
    const R = Math.max(b.x1 - b.x0, b.y1 - b.y0) * S * 0.75 + 2;
    this._sunC = { x: cx, z: cz, R };
    this.sun.position.set(cx - R * 0.6, R * 1.6, cz - R * 0.9);
    this.sun.target.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 0.1; sc.far = R * 5;
    sc.updateProjectionMatrix();
  }

  syncItems(pal, palKey) {
    const P = store.project;
    const seen = new Set();
    for (const it of P.items) {
      seen.add(it.id);
      const key = JSON.stringify([it.kind, it.w, it.d, it.h, it.color, it.color2, !!it.mirror, it.params || null, palKey, CATALOG_MAP[it.kind]?.ceiling ? [it.elev, P.settings.wallHeight] : 0]);
      let entry = this.itemCache.get(it.id);
      if (!entry || entry.key !== key) {
        if (entry) { this.itemsGroup.remove(entry.obj); entry.obj.traverse((o) => o.geometry?.dispose()); }
        const inner = buildItemObject(it, pal, { ceiling: P.settings.wallHeight });
        inner.scale.set(it.mirror ? -S : S, S, S); // 左右翻轉：沿物件寬度方向鏡像
        const obj = new THREE.Group();
        obj.add(inner);
        obj.userData = { itemId: it.id };
        inner.traverse((o) => { o.userData.itemId = it.id; });
        this.applyLook(obj);
        this.collectItemParts(obj, it.id);
        this.itemsGroup.add(obj);
        entry = { key, obj };
        this.itemCache.set(it.id, entry);
      }
      entry.obj.position.set(it.x * S, (it.elev || 0) * S, it.y * S);
      const cutting = this.cutHeight() < P.settings.wallHeight;
      entry.obj.visible = !cutting || ((it.elev || 0) < this.cutHeight() - 5 && it.kind !== 'curtain');
      entry.obj.rotation.y = -THREE.MathUtils.degToRad(it.rot || 0);
    }
    for (const [id, e] of this.itemCache) {
      if (!seen.has(id)) {
        this.itemsGroup.remove(e.obj); e.obj.traverse((o) => o.geometry?.dispose()); this.itemCache.delete(id);
        for (const k of [...(this.doors?.keys() || [])]) if (k.startsWith(`${id}#`)) { this.doors.delete(k); this.doorState?.delete(k); }
      }
    }
  }

  applyLighting() {
    const P = store.project;
    const night = P.settings.night;
    const style = P.design.styleId;
    const temp = { modern: '#fff6ea', nordic: '#ffe9cf', japandi: '#ffe7c7', wabisabi: '#ffdcb0', luxury: '#ffe4bd' }[style] || '#ffeccc';
    this.hemi.intensity = night ? 0.12 : 1.1;
    this.sun.intensity = night ? 0 : 2.2;
    this.sun.color.set('#fff3e0');
    this.scene.environmentIntensity = night ? 0.12 : 0.55;
    this.scene.background = night ? this.skyNight : this.skyDay;
    this.ground.material.color.set(night ? '#30343d' : '#dfe3e6');
    const sim = this.sunSim;
    if (sim && !night) {
      // 依太陽高度調整：低角度時光線偏暖、天空較暗
      const c = this._sunC || { x: 0, z: 0, R: 10 };
      const d = sim.dir;
      this.sun.position.set(c.x + d.x * c.R * 2.5, Math.max(0.05, d.y) * c.R * 2.5, c.z + d.z * c.R * 2.5);
      this.sun.target.position.set(c.x, 0, c.z);
      this.sun.color.set(sim.color);
      this.sun.intensity = sim.intensity;
      const k = Math.min(1, Math.max(0.15, (sim.alt + 4) / 30));
      // 室內環境光調暗，陽光照到的地方才明顯
      this.hemi.intensity = 0.22 + 0.33 * k;
      this.scene.environmentIntensity = 0.14 + 0.2 * k;
    }
    // 燈具光源（夜間模式啟用）
    this.clearGroup(this.lightsGroup);
    if (!night) return;
    let n = 0;
    for (const it of P.items) {
      const def = CATALOG_MAP[it.kind];
      if (!def?.light || n >= 12) continue;
      n++;
      const l = new THREE.PointLight(temp, def.light.intensity * 6, def.light.dist, 1.6);
      const y = def.ceiling ? it.elev - 5 : it.elev + it.h * 0.85;
      l.position.set(it.x * S, y * S, it.y * S);
      this.lightsGroup.add(l);
    }
    // 環境補光避免全黑
    const amb = new THREE.AmbientLight(temp, 0.25);
    this.lightsGroup.add(amb);
  }

  cutHeight() {
    const P = store.project;
    // 日照模擬時牆維持原高，陽光才會只從窗戶照入
    return P.settings.cutaway && this.mode !== 'walk' && this.mode !== 'vr' && this.mode !== 'tour' && !this.sunSim ? 120 : 10000;
  }

  resetView() {
    const b = projectBounds(store.project);
    const cx = ((b.x0 + b.x1) / 2) * S, cz = ((b.y0 + b.y1) / 2) * S;
    const R = Math.max(b.x1 - b.x0, b.y1 - b.y0) * S;
    this.controls.target.set(cx, 0.6, cz);
    // 依視角與畫面比例計算能容納整個平面的距離
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = (R * 0.62) / Math.tan(fov / 2) / Math.min(1, this.camera.aspect * 0.9);
    const dir = new THREE.Vector3(0.42, 0.78, 0.62).normalize();
    this.camera.position.set(cx + dir.x * fit, dir.y * fit + 0.5, cz + dir.z * fit);
    this.controls.update();
  }

  topView() {
    const b = projectBounds(store.project);
    const cx = ((b.x0 + b.x1) / 2) * S, cz = ((b.y0 + b.y1) / 2) * S;
    const R = Math.max(b.x1 - b.x0, b.y1 - b.y0) * S;
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx, R * 1.25 + 2, cz + 0.01);
    this.controls.update();
  }

  updateSelection() {
    const sel = store.selection;
    this.selectionBox.visible = false;
    if (sel?.type === 'item') {
      const e = this.itemCache.get(sel.id);
      if (e) { this.selectionBox.setFromObject(e.obj); this.selectionBox.object = e.obj; this.selectionBox.visible = true; }
    } else if (sel?.type === 'wall') {
      const g = this.structure.children.find((c) => c.userData.wallId === sel.id);
      if (g) { this.selectionBox.setFromObject(g); this.selectionBox.object = g; this.selectionBox.visible = true; }
    }
  }

  // ---------------------------------------------------- 漫遊模式
  setMode(mode) {
    this.mode = mode;
    this.canvas.style.cursor = '';
    if (mode === 'walk') {
      const P = store.project;
      // 從目前視角中心或第一個房間開始
      const room = P.rooms[0];
      let x = this.controls.target.x, z = this.controls.target.z;
      if (room) { const bb = polygonBBox(room.points); x = ((bb.x0 + bb.x1) / 2) * S; z = ((bb.y0 + bb.y1) / 2) * S; }
      this.walk.pos.set(x, 1.6, z);
      this.walk.yaw = 0; this.walk.pitch = 0;
      this.controls.enabled = false;
      this.camera.fov = 70; this.camera.updateProjectionMatrix();
    } else {
      this.setGyro(false);
      this.walk.joy.x = this.walk.joy.y = 0;
      this.controls.enabled = true;
      this.camera.fov = 55; this.camera.updateProjectionMatrix();
      this.resetView();
      this.app.onVisitor?.(null);
    }
    this.needsSync = true;
  }

  // 漫遊陀螺儀：回傳是否成功開啟
  async setGyro(on) {
    if (!on) { this.walk.gyroStop?.(); this.walk.gyroStop = null; this.walk.gyro = null; return false; }
    if (this.walk.gyroStop) return true;
    const stop = await enableGyro((v) => { this.walk.gyro = v; });
    if (!stop) return false;
    this.walk.gyroStop = stop;
    this.walk.gyroOffset = null;
    return true;
  }

  _walkStep(dt) {
    const k = this.walk.keys;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1.5) * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.walk.yaw), 0, -Math.cos(this.walk.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const mv = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) mv.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) mv.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) mv.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) mv.sub(right);
    if (k.has('KeyQ')) this.walk.yaw += dt * 1.6;
    if (k.has('KeyE')) this.walk.yaw -= dt * 1.6;
    // 手機虛擬搖桿：上下前進後退、左右平移
    const j = this.walk.joy;
    if (j.x || j.y) { mv.addScaledVector(fwd, -j.y); mv.addScaledVector(right, j.x); }
    // 陀螺儀：以開啟當下的方向為基準，跟著手機轉動視角
    const g = this.walk.gyro;
    if (g) {
      if (this.walk.gyroOffset === null) this.walk.gyroOffset = this.walk.yaw - g.yaw;
      const ty = g.yaw + this.walk.gyroOffset;
      this.walk.yaw += Math.atan2(Math.sin(ty - this.walk.yaw), Math.cos(ty - this.walk.yaw)) * 0.35;
      this.walk.pitch += (clamp(g.pitch, -1.2, 1.2) - this.walk.pitch) * 0.35;
    }
    if (mv.lengthSq() > 0) {
      mv.multiplyScalar(speed / Math.max(1, mv.length()));
      const next = this.walk.pos.clone().add(mv);
      if (!this._collides(this.walk.pos, next)) this.walk.pos.copy(next);
    }
    this.camera.position.copy(this.walk.pos);
    const dir = new THREE.Vector3(-Math.sin(this.walk.yaw) * Math.cos(this.walk.pitch), Math.sin(this.walk.pitch), -Math.cos(this.walk.yaw) * Math.cos(this.walk.pitch));
    this.camera.lookAt(this.walk.pos.clone().add(dir));
    this.app.onVisitor?.({ x: this.walk.pos.x / S, y: this.walk.pos.z / S, yaw: -this.walk.yaw });
  }

  _collides(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1e-6) return false;
    dir.normalize();
    for (const h of [0.4, 1.2]) {
      const o = from.clone(); o.y = h;
      this.raycaster.set(o, dir);
      this.raycaster.far = len + 0.25;
      const hits = this.raycaster.intersectObjects(this.structure.children, true).filter((x) => x.object.userData.wallId && x.object.material !== undefined && !x.object.material.transparent);
      if (hits.length) return true;
    }
    return false;
  }

  // ---------------------------------------------------- 互動
  _ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  pick(e) {
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    this.raycaster.far = 500;
    const hits = this.raycaster.intersectObjects([this.itemsGroup, this.structure], true);
    for (const h of hits) {
      const u = h.object.userData;
      if (u.ceiling) continue;
      if (u.itemId) return { type: 'item', id: u.itemId, point: h.point };
      if (u.openingId) return { type: 'opening', id: u.openingId, point: h.point };
      if (u.wallId) {
        // 材質群組 4 = A 面、5 = B 面
        const side = h.face?.materialIndex === 5 ? 'B' : 'A';
        return { type: 'wall', id: u.wallId, side, faceIndex: h.face?.materialIndex, point: h.point };
      }
      if (u.roomId) return { type: 'room', id: u.roomId, point: h.point };
    }
    return null;
  }

  floorPoint(e, y = 0) {
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, p) ? { x: p.x / S, y: p.z / S } : null;
  }

  _bindEvents() {
    const c = this.canvas;
    c.tabIndex = 0;
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      this.down = { x: e.clientX, y: e.clientY, button: e.button };
      if (this.mode === 'walk') { this.lookDrag = { x: e.clientX, y: e.clientY, yaw: this.walk.yaw, pitch: this.walk.pitch, offset: this.walk.gyroOffset }; c.setPointerCapture(e.pointerId); return; }
      if (e.button !== 0) return;
      const hit = this.pick(e);
      if (hit?.type === 'item') {
        const it = store.find('item', hit.id);
        store.select({ type: 'item', id: hit.id });
        const fp = this.floorPoint(e, (it.elev || 0) * S);
        if (fp) {
          this.drag3d = { id: hit.id, dx: it.x - fp.x, dy: it.y - fp.y, started: false, elev: (it.elev || 0) * S };
          this.controls.enabled = false;
          c.setPointerCapture(e.pointerId);
        }
      }
    });
    c.addEventListener('pointermove', (e) => {
      // 漫遊時滑鼠移到門上顯示手形游標
      if (this.mode === 'walk' && !this.lookDrag && e.pointerType === 'mouse') {
        const now = performance.now();
        if (!this._hoverT || now - this._hoverT > 80) { this._hoverT = now; c.style.cursor = this.doorAt(e) ? 'pointer' : ''; }
      }
      if (this.lookDrag) {
        if (this.walk.gyro && this.walk.gyroOffset !== null) {
          // 陀螺儀開啟時，拖曳只調整水平基準方向
          this.walk.gyroOffset = this.lookDrag.offset - (e.clientX - this.lookDrag.x) * 0.004;
          return;
        }
        this.walk.yaw = this.lookDrag.yaw - (e.clientX - this.lookDrag.x) * 0.004;
        this.walk.pitch = clamp(this.lookDrag.pitch - (e.clientY - this.lookDrag.y) * 0.004, -1.2, 1.2);
        return;
      }
      const d = this.drag3d;
      if (!d) return;
      const fp = this.floorPoint(e, d.elev);
      if (!fp) return;
      if (!d.started) { store.checkpoint(); d.started = true; }
      const it = store.find('item', d.id);
      if (!it) return;
      it.x = snap(fp.x + d.dx, 1); it.y = snap(fp.y + d.dy, 1);
      store.update(null, 'move');
    });
    const up = (e) => {
      if (this.lookDrag) { this.lookDrag = null; }
      const moved = this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4;
      if (this.drag3d) {
        if (this.drag3d.started) store.changed('commit');
        this.drag3d = null;
        this.controls.enabled = this.mode !== 'walk';
      } else if (this.down && !moved && this.down.button === 0 && this.mode === 'walk') {
        // 漫遊時點門：開門 / 關門
        const id = this.doorAt(e);
        if (id) this.toggleDoor(id);
      } else if (this.down && !moved && this.down.button === 0 && this.mode !== 'walk') {
        const hit = this.pick(e);
        if (!hit) store.select(null);
        else if (hit.type !== 'item') store.select({ type: hit.type, id: hit.id, side: hit.side });
      }
      this.down = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('dblclick', (e) => {
      if (this.mode === 'walk') return;
      const hit = this.pick(e);
      if (hit?.point) { this.controls.target.copy(hit.point); this.controls.update(); }
    });
    c.addEventListener('keydown', (e) => { if (this.mode === 'walk') { this.walk.keys.add(e.code); if (e.code.startsWith('Arrow')) e.preventDefault(); } });
    c.addEventListener('keyup', (e) => this.walk.keys.delete(e.code));
    c.addEventListener('blur', () => this.walk.keys.clear());
    // 拖放家具/材質
    c.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData('application/x-catalog');
      const matId = e.dataTransfer.getData('application/x-material');
      if (kind) {
        const fp = this.floorPoint(e);
        if (fp) this.app.placeCatalog(kind, fp.x, fp.y);
      } else if (matId) {
        const hit = this.pick(e);
        if (hit) this.app.applyMaterialToHit(matId, hit);
      }
    });
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
}

// 讓牆面貼圖依實際尺寸（公尺）平鋪並保持連續
function scaleBoxUV(geo, w, h, d, uOff, vOff, uOffB) {
  const uv = geo.attributes.uv;
  // 每面 4 個頂點：px, nx, py, ny, pz, nz
  const dims = [[d, h, 0, vOff], [d, h, 0, vOff], [w, d, uOff, 0], [w, d, uOff, 0], [w, h, uOff, vOff], [w, h, uOffB, vOff]];
  for (let f = 0; f < 6; f++) {
    const [su, sv, ou, ov] = dims[f];
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su + ou, uv.getY(idx) * sv + ov);
    }
  }
  uv.needsUpdate = true;
}
