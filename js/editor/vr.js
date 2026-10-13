// VR 頭盔模式（WebXR）：在 Meta Quest 等 VR 頭盔的瀏覽器中，以 1:1 實際尺寸站在室內環顧與移動。
// 操作：左搖桿移動（會被牆擋住）、右搖桿每次轉 30°、按住扳機指向地板放開即瞬間移動。
import * as THREE from 'three';

const S = 0.01;
const SNAP = Math.PI / 6;

export async function vrSupported() {
  try { return !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'); } catch { return false; }
}

export class VRMode {
  constructor(view3d) {
    this.v = view3d;
    this.session = null;
    // 使用者所在的「台座」：頭盔位置是相對於台座，移動與轉向都移動台座
    this.rig = new THREE.Group();
    this.rig.name = 'vrRig';
    this.raycaster = new THREE.Raycaster();
    this.ctrls = [];
    this.turnReady = true;
    // 瞬間移動目標：地板上的圓環
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 40), new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.9, depthTest: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 10;
    ring.visible = false;
    this.marker = ring;
  }

  get active() { return !!this.session; }

  async enter(start) {
    const v = this.v, r = v.renderer;
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    this.prev = { mode: v.mode, shadowAuto: r.shadowMap.autoUpdate };
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local-floor');
    r.xr.setFoveation?.(1);
    v.scene.add(this.rig, this.marker);
    this.rig.position.set(start.x, 0, start.z);
    this.rig.rotation.set(0, start.yaw || 0, 0);
    this.rig.add(v.camera);
    v.camera.position.set(0, 0, 0);
    v.camera.rotation.set(0, 0, 0);
    // VR 中與漫遊相同：牆不降低、顯示天花板
    v.mode = 'vr';
    v.needsSync = true;
    // 陰影只在場景變動時更新，減輕頭盔負擔
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;
    this.setupControllers();
    session.addEventListener('end', () => this.onEnd());
    await r.xr.setSession(session);
    this.session = session;
  }

  setupControllers() {
    const r = this.v.renderer;
    for (let i = 0; i < 2; i++) {
      const c = r.xr.getController(i);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6 }),
      );
      line.scale.z = 4;
      c.add(line);
      const st = { c, line, aiming: false, target: null, hand: '' };
      c.addEventListener('connected', (e) => { st.hand = e.data?.handedness || ''; });
      c.addEventListener('selectstart', () => { st.aiming = true; });
      c.addEventListener('selectend', () => { st.aiming = false; if (st.target) this.teleport(st.target); st.target = null; this.marker.visible = false; });
      this.rig.add(c);
      this.ctrls.push(st);
    }
  }

  exit() { this.session?.end(); }

  onEnd() {
    const v = this.v, r = v.renderer;
    for (const st of this.ctrls) { st.c.remove(st.line); st.line.geometry.dispose(); this.rig.remove(st.c); }
    this.ctrls = [];
    this.rig.remove(v.camera);
    v.scene.remove(this.rig, this.marker);
    this.session = null;
    r.xr.enabled = false;
    r.shadowMap.autoUpdate = this.prev?.shadowAuto ?? true;
    if (this.prev?.mode === 'walk') {
      // 回到漫遊，停在 VR 中最後的位置與方向
      const { pos, dir } = this.lastHead || { pos: v.walk.pos, dir: new THREE.Vector3(0, 0, -1) };
      v.mode = 'walk';
      v.walk.pos.set(pos.x, 1.6, pos.z);
      v.walk.yaw = Math.atan2(-dir.x, -dir.z);
      v.walk.pitch = 0;
      v.needsSync = true;
    } else {
      v.setMode('orbit');
    }
    v.app.onVRChange?.(false);
  }

  // 頭盔在世界中的位置與水平朝向
  head() {
    const cam = this.v.renderer.xr.getCamera();
    const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    return { pos, dir: dir.normalize() };
  }

  teleport(point) {
    const { pos } = this.head();
    this.rig.position.x += point.x - pos.x;
    this.rig.position.z += point.z - pos.z;
  }

  // 每個畫面：讀取搖桿、處理瞬間移動指向
  update(dt) {
    if (!this.session) return;
    const { pos, dir } = this.head();
    this.lastHead = { pos: pos.clone(), dir: dir.clone() };
    const right = new THREE.Vector3(-dir.z, 0, dir.x);
    for (const src of this.session.inputSources) {
      const gp = src.gamepad;
      if (!gp || !gp.axes) continue;
      const ax = gp.axes;
      const x = ax.length >= 4 ? ax[2] : ax[0] || 0;
      const y = ax.length >= 4 ? ax[3] : ax[1] || 0;
      if (src.handedness === 'right') {
        // 右搖桿：快速轉向（以頭為中心轉 30°）
        if (Math.abs(x) > 0.7 && this.turnReady) { this.rotateAround(pos, x > 0 ? -SNAP : SNAP); this.turnReady = false; }
        if (Math.abs(x) < 0.3) this.turnReady = true;
      } else {
        // 左搖桿（或單一控制器）：往頭朝向的方向平滑移動
        if (Math.hypot(x, y) < 0.15) continue;
        const mv = new THREE.Vector3().addScaledVector(dir, -y).addScaledVector(right, x).multiplyScalar(1.4 * dt);
        const from = new THREE.Vector3(pos.x, 0, pos.z), to = from.clone().add(mv);
        if (!this.v._collides(from, to)) { this.rig.position.x += mv.x; this.rig.position.z += mv.z; }
      }
    }
    // 扳機按住時：沿控制器射線找地板落點（被牆擋住則不可移動）
    for (const st of this.ctrls) {
      if (!st.aiming) continue;
      st.c.updateMatrixWorld();
      const o = new THREE.Vector3().setFromMatrixPosition(st.c.matrixWorld);
      const d = new THREE.Vector3(0, 0, -1).transformDirection(st.c.matrixWorld);
      this.raycaster.set(o, d);
      this.raycaster.far = 15;
      const hit = this.raycaster.intersectObjects([this.v.structure, this.v.itemsGroup, this.v.ground], true)[0];
      const n = hit?.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      if (hit && n && n.y > 0.7 && hit.point.y < 0.3) {
        st.target = hit.point.clone();
        this.marker.position.set(hit.point.x, hit.point.y + 0.01, hit.point.z);
        this.marker.visible = true;
        st.line.scale.z = hit.distance;
      } else {
        st.target = null;
        this.marker.visible = false;
        st.line.scale.z = hit ? hit.distance : 4;
      }
    }
    this.v.app.onVisitor?.({ x: pos.x / S, y: pos.z / S, yaw: Math.atan2(dir.x, -dir.z) });
  }

  rotateAround(center, ang) {
    const r = this.rig;
    const off = new THREE.Vector3(r.position.x - center.x, 0, r.position.z - center.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
    r.position.x = center.x + off.x;
    r.position.z = center.z + off.z;
    r.rotation.y += ang;
  }
}
