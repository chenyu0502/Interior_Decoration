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

const S = 0.01; // 公分 → 公尺

export class View3D {
  constructor(container, app) {
    this.container = container;
    this.app = app;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e9edf1');
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
    this.walk = { yaw: 0, pitch: 0, keys: new Set(), pos: new THREE.Vector3() };
    this.raycaster = new THREE.Raycaster();
    this.selectionBox = new THREE.BoxHelper(undefined, 0x2563eb);
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);
    this.dirty = true;
    this.firstBuild = true;

    this._bindEvents();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    store.on('change', (reason) => { this.needsSync = true; this._lastReason = reason; });
    store.on('select', () => this.updateSelection());
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  get visible() { return this.container.offsetParent !== null && this.container.clientWidth > 2; }

  tick() {
    if (!this.visible) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.needsSync) { this.needsSync = false; this.sync(); }
    if (this.mode === 'walk') this._walkStep(dt);
    else this.controls.update();
    if (this.selectionBox.visible && this.selectionBox.object) this.selectionBox.update();
    this.renderer.render(this.scene, this.camera);
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
    const sKey = JSON.stringify([P.walls, P.rooms, P.openings, P.settings.showCeiling, P.settings.wallHeight, P.settings.cutaway, palKey, this.mode]);
    if (sKey !== this.structKey) {
      this.structKey = sKey;
      this.buildStructure(pal);
    }
    this.syncItems(pal, palKey);
    this.applyLighting();
    if (this.firstBuild && (P.walls.length || P.items.length)) { this.firstBuild = false; this.resetView(); }
    this.updateSelection();
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
      if ((P.settings.showCeiling && !P.settings.cutaway) || this.mode === 'walk') {
        const cg = new THREE.ShapeGeometry(shape);
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
      if (!seen.has(id)) { this.itemsGroup.remove(e.obj); e.obj.traverse((o) => o.geometry?.dispose()); this.itemCache.delete(id); }
    }
  }

  applyLighting() {
    const P = store.project;
    const night = P.settings.night;
    const style = P.design.styleId;
    const temp = { modern: '#fff6ea', nordic: '#ffe9cf', japandi: '#ffe7c7', wabisabi: '#ffdcb0', luxury: '#ffe4bd' }[style] || '#ffeccc';
    this.hemi.intensity = night ? 0.12 : 1.1;
    this.sun.intensity = night ? 0 : 2.2;
    this.scene.environmentIntensity = night ? 0.12 : 0.55;
    this.scene.background.set(night ? '#1b2030' : '#e9edf1');
    this.ground.material.color.set(night ? '#30343d' : '#dfe3e6');
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
    return P.settings.cutaway && this.mode !== 'walk' ? 120 : 10000;
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
      this.controls.enabled = true;
      this.camera.fov = 55; this.camera.updateProjectionMatrix();
      this.resetView();
      this.app.onVisitor?.(null);
    }
    this.needsSync = true;
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
    if (mv.lengthSq() > 0) {
      mv.normalize().multiplyScalar(speed);
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
      if (this.mode === 'walk') { this.lookDrag = { x: e.clientX, y: e.clientY, yaw: this.walk.yaw, pitch: this.walk.pitch }; c.setPointerCapture(e.pointerId); return; }
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
      if (this.lookDrag) {
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
