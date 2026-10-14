// 選單縮圖攝影棚：以柔光箱反射、主光陰影與物理材質（布料絨面、清漆、凹凸）產生家具、門窗與材質的 3D 縮圖。
import * as THREE from 'three';
import { RoomEnvironment } from '../../vendor/three/addons/RoomEnvironment.js';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { buildItemObject, buildOpeningObject } from '../data/catalog.js';
import { getMaterial, materialCanvas } from '../data/materials.js';
import { realisticMaterials } from '../editor/render-look.js';

const S = 0.01;
const SIZE = 256; // 渲染解析度（卡片以 2 倍密度顯示）

export class ThumbStudio {
  constructor() {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(SIZE, SIZE, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(0x000000, 0);
    this.renderer = r;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    pmrem.dispose();
    scene.environment = this.envTex;
    scene.environmentIntensity = 0.75;
    // 主光（投影）與補光
    const key = new THREE.DirectionalLight('#fff6ea', 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 6;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    scene.add(key, key.target);
    scene.add(new THREE.HemisphereLight('#ffffff', '#c9c2b8', 0.5));
    // 地面只接收陰影，背景透明
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.22 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.scene = scene; this.key = key; this.ground = ground;
    this.cam = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
    this.wallMat = new THREE.MeshStandardMaterial({ color: '#f1efea', roughness: 0.9 });
  }

  // 拍攝一個物件：依外框自動取景，回傳畫布
  shoot(obj, { view = [0.95, 0.72, 1.6], fill = 1.0, groundY = null } = {}) {
    const scene = this.scene;
    scene.add(obj);
    obj.updateMatrixWorld(true);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const box = new THREE.Box3().setFromObject(obj);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const c = sphere.center, R = Math.max(sphere.radius, 0.05);
    this.ground.position.y = groundY ?? box.min.y - 0.001;
    // 主光從左上前方照射，陰影範圍貼合物件
    this.key.position.set(c.x - R * 1.4, c.y + R * 3, c.z + R * 2.2);
    this.key.target.position.copy(c);
    const sc = this.key.shadow.camera;
    Object.assign(sc, { left: -R * 2, right: R * 2, top: R * 2, bottom: -R * 2, near: 0.01, far: R * 10 });
    sc.updateProjectionMatrix();
    const dir = new THREE.Vector3(...view).normalize();
    const dist = (R / Math.sin(THREE.MathUtils.degToRad(this.cam.fov / 2))) * 1.02 / fill;
    this.cam.position.copy(c).addScaledVector(dir, dist);
    this.cam.near = dist / 50; this.cam.far = dist * 10;
    this.cam.updateProjectionMatrix();
    this.cam.lookAt(c);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(scene, this.cam);
    scene.remove(obj);
    return this.renderer.domElement;
  }

  // 家具：套用物理材質後拍攝
  item(def, pal) {
    const g = new THREE.Group();
    const inner = buildItemObject({ kind: def.id, w: def.w, d: def.d, h: def.h, id: def.id, elev: def.elev || 0 }, pal, { ceiling: (def.elev || 0) + def.h + 30 });
    inner.scale.setScalar(S);
    inner.rotation.y = -0.55;
    g.add(inner);
    const made = realisticMaterials(g, { lights: def.cat === 'light', normalMaps: false, raster: true });
    const out = this.shoot(g, { fill: def.flat ? 1.1 : 1.0, groundY: def.ceiling || def.elev ? null : 0 });
    dispose(g, made);
    return out;
  }

  // 門窗：嵌在一小段牆上拍攝，看得到門片、框與玻璃
  opening(def, pal) {
    const op = { kind: def.id, width: def.width, height: def.height, sill: def.sill || 0, offset: 0 };
    const T = 12, side = 34, top = 26;
    const W = op.width + side * 2, H = op.sill + op.height + top;
    const g = new THREE.Group();
    const wall = new THREE.Group();
    const add = (w, h, x, y) => { if (w <= 0 || h <= 0) return; const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, T), this.wallMat); m.position.set(x, y + h / 2, 0); wall.add(m); };
    add(side, H, -op.width / 2 - side / 2, 0);
    add(side, H, op.width / 2 + side / 2, 0);
    add(op.width, top, 0, op.sill + op.height);
    add(op.width, op.sill, 0, 0);
    const o = buildOpeningObject(op, T, pal);
    o.position.y = op.sill;
    wall.add(o);
    wall.scale.setScalar(S);
    wall.rotation.y = -0.42;
    g.add(wall);
    const made = realisticMaterials(g, { normalMaps: false, raster: true });
    const out = this.shoot(g, { view: [0.55, 0.32, 1.6], fill: 1.05, groundY: 0 });
    dispose(g, made, true);
    return out;
  }

  // 材質：圓角方塊，看得到三個面的紋理、凹凸與反光
  material(id) {
    const m = getMaterial(id);
    const tex = new THREE.CanvasTexture(materialCanvas(id));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const edge = 0.5;
    tex.repeat.set(edge / m.size, edge / m.size);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: m.rough ?? 0.8 });
    mat.userData.matId = id;
    const box = new THREE.Mesh(new RoundedBoxGeometry(edge, edge, edge, 4, 0.035), mat);
    box.position.y = edge / 2;
    box.rotation.y = Math.PI / 4.6;
    const g = new THREE.Group();
    g.add(box);
    const made = realisticMaterials(g, { normalMaps: true, raster: true });
    const out = this.shoot(g, { view: [0.9, 0.9, 1.4], fill: 1.12, groundY: 0 });
    dispose(g, made);
    tex.dispose(); mat.dispose();
    return out;
  }

  dispose() {
    this.envTex.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}

function dispose(root, made, ownGeometry = true) {
  root.traverse((o) => { if (ownGeometry && o.geometry) o.geometry.dispose(); });
  for (const m of made) m.dispose?.();
}

// 卡片背景：柔和的攝影棚漸層
export function paintStudioBackground(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f7f7f6');
  g.addColorStop(1, '#e3e5e8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
