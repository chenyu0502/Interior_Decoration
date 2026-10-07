// 寫實渲染：以光線追蹤（path tracing）計算光線多次反彈、柔和陰影、反射與透光，
// 使用目前 3D 畫面的視角，逐步累積取樣，畫面會越來越清晰。
// 光線追蹤引擎（three-gpu-pathtracer）在第一次渲染時才載入。
import * as THREE from 'three';
import { store } from '../core/state.js';
import { projectBounds } from '../core/model.js';
import { pointInPolygon, polygonCentroid, polygonArea } from '../core/geometry.js';
import { CATALOG_MAP } from '../data/catalog.js';

const S = 0.01; // 公分 → 公尺

// 時段：天空、太陽與曝光
export const RENDER_TIMES = {
  day: { name: '白天', sky: '#a9cdf0', horizon: '#eef1ee', ground: '#d9d6cf', env: 1.0, sun: { color: '#fff3e2', intensity: 3.2, elev: 52, azim: 35 }, exposure: 1.1, lights: false },
  dusk: { name: '黃昏', sky: '#47577a', horizon: '#f2a865', ground: '#8a7563', env: 0.55, sun: { color: '#ffae63', intensity: 2.2, elev: 9, azim: 250 }, exposure: 1.1, lights: true },
  night: { name: '夜晚', sky: '#070b16', horizon: '#141a2a', ground: '#15171c', env: 0.04, sun: null, exposure: 1.0, lights: true },
};

// 品質：長邊像素、取樣次數、光線反彈次數
export const RENDER_QUALITY = {
  draft: { name: '草稿（最快）', long: 960, samples: 48, bounces: 4 },
  standard: { name: '標準', long: 1440, samples: 200, bounces: 5 },
  fine: { name: '精細（耗時較長）', long: 1920, samples: 600, bounces: 6 },
};

export const RENDER_ENGINES = { pathtracing: '光線追蹤（寫實）', raster: '相容模式（快速）' };

export const RENDER_ASPECTS = { view: '目前 3D 畫面', '16:9': '16:9 橫式', '4:3': '4:3 橫式', '1:1': '1:1 方形', '3:4': '3:4 直式' };

let ptModule = null;
async function loadPathTracer() {
  if (!ptModule) ptModule = await import('../../vendor/pathtracer/three-gpu-pathtracer.min.js');
  return ptModule;
}

export class RenderStudio {
  constructor(view3d) {
    this.v = view3d;
    this.running = false;
    this.renderer = null;
    this.pt = null;
    this.disposables = [];
  }

  // 依選項計算輸出尺寸
  size(opts) {
    const q = RENDER_QUALITY[opts.quality] || RENDER_QUALITY.standard;
    let ratio;
    if (opts.aspect === 'view' || !opts.aspect) ratio = this.v.camera.aspect || 16 / 9;
    else { const [a, b] = opts.aspect.split(':').map(Number); ratio = a / b; }
    const W = ratio >= 1 ? q.long : Math.round(q.long * ratio);
    const H = ratio >= 1 ? Math.round(q.long / ratio) : q.long;
    return { W: Math.max(16, W), H: Math.max(16, H) };
  }

  // 建立渲染用場景：沿用目前的牆、地板、門窗與家具，另外配置天空、太陽與室內燈光
  buildScene(opts, mod) {
    const v = this.v, P = store.project;
    const t = RENDER_TIMES[opts.time] || RENDER_TIMES.day;
    const scene = new THREE.Scene();
    const structure = v.structure.clone();
    scene.add(structure, v.itemsGroup.clone());
    this.splitMultiMaterial(scene);

    const groundMat = v.ground.material.clone();
    groundMat.color.set(t.ground);
    this.disposables.push(groundMat);
    const ground = new THREE.Mesh(v.ground.geometry, groundMat);
    ground.rotation.copy(v.ground.rotation);
    ground.position.copy(v.ground.position);
    scene.add(ground);

    // 天花板：畫面上沒有天花板時另外補上（光線在室內反彈需要天花板）
    let hasCeiling = false;
    structure.traverse((o) => { if (o.userData?.ceiling) hasCeiling = true; });
    if (opts.ceiling && !hasCeiling) {
      const cm = new THREE.MeshStandardMaterial({ color: '#fbfaf7', roughness: 0.95 });
      this.disposables.push(cm);
      for (const r of P.rooms) {
        const shape = new THREE.Shape(r.points.map(([x, y]) => new THREE.Vector2(x * S, y * S)));
        const g = new THREE.ShapeGeometry(shape);
        g.rotateX(Math.PI / 2);
        this.disposables.push(g);
        const m = new THREE.Mesh(g, cm);
        m.position.y = P.settings.wallHeight * S;
        scene.add(m);
      }
    }

    // 天空（同時作為環境光）
    if (mod) {
      const sky = new mod.GradientEquirectTexture(256);
      sky.topColor.set(t.sky);
      sky.bottomColor.set(t.horizon);
      sky.exponent = 0.6;
      sky.update();
      this.disposables.push(sky);
      scene.background = sky;
      scene.environment = sky;
    } else {
      scene.background = new THREE.Color(t.horizon);
    }
    scene.environmentIntensity = t.env;
    scene.backgroundIntensity = 1;

    // 太陽
    const b = projectBounds(P);
    const cx = ((b.x0 + b.x1) / 2) * S, cz = ((b.y0 + b.y1) / 2) * S;
    if (t.sun) {
      const sun = new THREE.DirectionalLight(t.sun.color, t.sun.intensity);
      this.sunLight = sun;
      const el = THREE.MathUtils.degToRad(t.sun.elev), az = THREE.MathUtils.degToRad(t.sun.azim + (opts.sunRotate || 0));
      sun.position.set(cx + Math.cos(el) * Math.sin(az) * 50, Math.sin(el) * 50, cz + Math.cos(el) * Math.cos(az) * 50);
      sun.target.position.set(cx, 0, cz);
      scene.add(sun, sun.target);
    }

    // 室內燈光：燈具依類型放置光源；沒有主燈的房間自動補一盞吸頂燈
    if (opts.lights) {
      const warm = new THREE.Color('#ffd9a8');
      const lit = new Set();
      for (const it of P.items) {
        const def = CATALOG_MAP[it.kind];
        if (!def?.light) continue;
        const x = it.x * S, z = it.y * S;
        if (def.ceiling) {
          const room = P.rooms.find((r) => pointInPolygon(it.x, it.y, r.points));
          if (room) lit.add(room.id);
          const l = new THREE.PointLight(warm, def.light.intensity * 3, 0, 2);
          l.position.set(x, (it.elev - 4) * S, z);
          scene.add(l);
        } else {
          const l = new THREE.PointLight(warm, def.light.intensity * 2, 0, 2);
          l.position.set(x, (it.elev + it.h * 0.8) * S, z);
          scene.add(l);
        }
      }
      for (const r of P.rooms) {
        if (lit.has(r.id)) continue;
        const [x, y] = polygonCentroid(r.points);
        const area = Math.abs(polygonArea(r.points)) / 10000; // m²
        const l = new THREE.PointLight(warm, Math.min(10, 2 + area * 0.25), 0, 2);
        l.position.set(x * S, (P.settings.wallHeight - 25) * S, y * S);
        scene.add(l);
      }
    }
    return scene;
  }

  // 光線追蹤引擎不支援單一物件多種材質（例如牆的兩面不同材質），先拆成每種材質一個物件
  splitMultiMaterial(root) {
    const list = [];
    root.traverse((o) => { if (o.isMesh && Array.isArray(o.material)) list.push(o); });
    for (const mesh of list) {
      const g = mesh.geometry, parent = mesh.parent;
      const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : g.attributes.position.count, materialIndex: 0 }];
      for (const grp of groups) {
        const m = mesh.material[grp.materialIndex];
        if (!m || m.visible === false) continue;
        const part = new THREE.BufferGeometry();
        for (const [k, a] of Object.entries(g.attributes)) part.setAttribute(k, a);
        if (g.index) part.setIndex(Array.from(g.index.array.slice(grp.start, grp.start + grp.count)));
        else part.setIndex(Array.from({ length: grp.count }, (_, i) => grp.start + i));
        this.disposables.push(part);
        const pm = new THREE.Mesh(part, m);
        pm.position.copy(mesh.position); pm.quaternion.copy(mesh.quaternion); pm.scale.copy(mesh.scale);
        pm.userData = { ...mesh.userData };
        parent.add(pm);
      }
      parent.remove(mesh);
    }
  }

  async start(opts, host, cb = {}) {
    this.stop();
    this.running = true;
    this.fallbackReason = null;
    const { onProgress, onDone, onError } = cb;
    let mod = null;
    try {
      if (opts.engine !== 'raster') mod = await loadPathTracer();
    } catch (err) {
      console.error(err);
      this.fallbackReason = '無法載入光線追蹤引擎';
    }
    if (!this.running) return;
    const { W, H } = this.size(opts);
    if (opts.engine === 'raster' || !mod) { this.rasterRender(opts, host, W, H, mod, cb); return; }
    try {
      const t = RENDER_TIMES[opts.time] || RENDER_TIMES.day;
      const q = RENDER_QUALITY[opts.quality] || RENDER_QUALITY.standard;

      const renderer = this.makeRenderer(W, H, opts, false);
      host.replaceChildren(renderer.domElement);
      // 記錄著色器編譯錯誤與顯示卡中斷，用來判斷黑畫面的原因
      this.glError = null;
      renderer.debug.checkShaderErrors = true;
      renderer.debug.onShaderError = (gl, program) => { this.glError = `著色器編譯失敗：${(gl.getProgramInfoLog(program) || '').slice(0, 160)}`; };
      renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.glError = '顯示卡記憶體不足或驅動程式中斷（WebGL context lost）'; });

      const camera = this.v.camera.clone();
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      this.camera = camera;

      onProgress?.({ stage: 'scene', samples: 0, total: q.samples });
      await nextFrame();
      const scene = this.buildScene(opts, mod);
      this.scene = scene;

      const pt = new mod.WebGLPathTracer(renderer);
      this.pt = pt;
      pt.renderDelay = 0;
      pt.fadeDuration = 0;
      pt.minSamples = 1;
      pt.dynamicLowRes = false;
      pt.rasterizeScene = true;
      pt.bounces = q.bounces;
      pt.filterGlossyFactor = 0.5;
      // 所有材質貼圖會合併成一組貼圖陣列，尺寸越大越吃顯示卡記憶體；512 可大幅降低記憶體不足造成的黑畫面
      pt.textureSize.set(512, 512);
      pt.tiles.set(W * H > 1.6e6 ? 3 : 2, W * H > 1.6e6 ? 3 : 2);
      pt.setScene(scene, camera);

      const t0 = performance.now();
      // 每個畫面送出的取樣次數依畫面間隔自動調整，避免顯示卡工作堆積造成瀏覽器卡頓
      let perFrame = 1, last = performance.now(), checked = false;
      const hist = []; // 最近幾秒的 [時間, 取樣數]，用來估算目前速度
      const step = () => {
        if (!this.running || this.pt !== pt) return;
        if (this.glError) { this.fallback(this.glError, opts, host, W, H, mod, cb); return; }
        const now = performance.now(), dt = now - last;
        last = now;
        // 分頁切到背景時瀏覽器會暫停渲染，暫停前的紀錄不列入速度估算
        if (dt > 1000) hist.length = 0;
        if (dt < 22 && perFrame < 16) perFrame++;
        else if (dt > 45 && perFrame > 1) perFrame = Math.max(1, Math.floor(perFrame / 2));
        for (let i = 0; i < perFrame && pt.samples < q.samples; i++) pt.renderSample();
        const exact = Math.min(pt.samples, q.samples), samples = Math.floor(exact);
        // 前幾次取樣後檢查畫面：全黑或數值異常時改用相容模式
        if (!checked && exact >= Math.min(3, q.samples) && (opts.lights || opts.time !== 'night')) {
          checked = true;
          const bad = this.diagnose();
          if (bad) { this.fallback(bad, opts, host, W, H, mod, cb); return; }
        }
        // 預估剩餘時間：以最近 6 秒的取樣速度推算（剛開始送出的工作會先排隊，早期速度偏快）
        const tNow = performance.now();
        let eta = null;
        if (exact > 0) {
          hist.push([tNow, exact]);
          while (hist.length > 2 && tNow - hist[0][0] > 6000) hist.shift();
          const [ta, sa] = hist[0];
          if (tNow - ta > 1500 && exact > sa) eta = ((q.samples - exact) * (tNow - ta)) / (exact - sa) / 1000;
        }
        onProgress?.({ stage: pt.isCompiling || exact === 0 ? 'compile' : 'render', samples, exact, total: q.samples, elapsed: (tNow - t0) / 1000, eta });
        if (pt.samples >= q.samples) {
          this.running = false;
          onDone?.({ samples, elapsed: (performance.now() - t0) / 1000, W, H, engine: 'pathtracing' });
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } catch (err) {
      console.error(err);
      this.fallback(`光線追蹤初始化失敗：${err?.message || err}`, opts, host, W, H, mod, cb);
    }
  }

  makeRenderer(W, H, opts, antialias) {
    const t = RENDER_TIMES[opts.time] || RENDER_TIMES.day;
    const renderer = new THREE.WebGLRenderer({ antialias, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = (opts.exposure ?? 1) * t.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;
    return renderer;
  }

  // 檢查輸出：畫面幾乎全黑、或累積結果含無效數值（NaN）時回傳原因
  diagnose() {
    try {
      const src = this.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = 64; c.height = Math.max(1, Math.round((64 * src.height) / src.width));
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      const mean = sum / (d.length / 4) / 3;
      let nan = 0;
      const tgt = this.pt?.target;
      if (tgt && tgt.texture.type === THREE.FloatType) {
        const n = 8, buf = new Float32Array(n * n * 4);
        this.renderer.readRenderTargetPixels(tgt, Math.floor(tgt.width / 2 - n / 2), Math.floor(tgt.height / 2 - n / 2), n, n, buf);
        for (const v of buf) if (!Number.isFinite(v)) nan++;
      }
      if (nan) return '光線追蹤結果含無效數值（NaN）';
      if (mean < 1.5) return '光線追蹤輸出全黑';
    } catch (err) { console.warn(err); }
    return null;
  }

  // 光線追蹤失敗時改用相容模式，並附上顯示卡型號方便回報
  fallback(reason, opts, host, W, H, mod, cb) {
    const gpu = this.gpuName();
    try { this.pt?.dispose(); } catch { /* ignore */ }
    this.pt = null;
    if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss?.(); this.renderer = null; }
    for (const d of this.disposables) d.dispose?.();
    this.disposables = [];
    this.fallbackReason = `${reason}${gpu ? `（顯示卡：${gpu}）` : ''}`;
    console.warn('寫實渲染改用相容模式：', this.fallbackReason);
    this.rasterRender(opts, host, W, H, mod, cb);
  }

  gpuName() {
    try {
      const gl = (this.renderer || this.v.renderer).getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { return ''; }
  }

  // 相容模式：一般即時渲染（含柔和陰影與環境光），不做光線反彈，幾乎所有裝置都能執行
  rasterRender(opts, host, W, H, mod, { onProgress, onDone, onError } = {}) {
    try {
      const t0 = performance.now();
      const t = RENDER_TIMES[opts.time] || RENDER_TIMES.day;
      onProgress?.({ stage: 'scene', samples: 0, total: 1 });
      const renderer = this.makeRenderer(W, H, opts, true);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      host.replaceChildren(renderer.domElement);
      this.sunLight = null;
      const scene = this.buildScene(opts, mod);
      this.scene = scene;
      // 光線追蹤會自動計算反彈光，相容模式以半球光補足室內亮度
      scene.add(new THREE.HemisphereLight(t.sky, t.ground, opts.time === 'night' ? 0.15 : 0.9 * t.env + 0.3));
      if (this.sunLight) {
        const sun = this.sunLight;
        sun.castShadow = true;
        sun.shadow.mapSize.set(4096, 4096);
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.02;
        const b = projectBounds(store.project);
        const R = Math.max(b.x1 - b.x0, b.y1 - b.y0) * S * 0.75 + 2;
        Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 120 });
        sun.shadow.radius = 4;
      }
      scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      const camera = this.v.camera.clone();
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      this.camera = camera;
      requestAnimationFrame(() => {
        if (!this.running) return;
        renderer.render(scene, camera);
        this.running = false;
        this.rasterScene = scene;
        onDone?.({ samples: 1, elapsed: (performance.now() - t0) / 1000, W, H, engine: 'raster', reason: this.fallbackReason });
      });
    } catch (err) {
      this.running = false;
      onError?.(err);
    }
  }

  // 只更新亮度，不重新取樣
  setExposure(exposure, time) {
    if (!this.renderer) return;
    const t = RENDER_TIMES[time] || RENDER_TIMES.day;
    this.renderer.toneMappingExposure = exposure * t.exposure;
    if (!this.pt) { if (this.rasterScene && !this.running) this.renderer.render(this.rasterScene, this.camera); return; }
    if (!this.running) {
      this.pt.pausePathTracing = true;
      this.pt.renderSample();
      this.pt.pausePathTracing = false;
    }
  }

  stop() { this.running = false; }

  toDataURL() { return this.renderer ? this.renderer.domElement.toDataURL('image/png') : null; }

  dispose() {
    this.stop();
    try { this.pt?.dispose(); } catch { /* ignore */ }
    for (const d of this.disposables) d.dispose?.();
    this.disposables = [];
    if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss?.(); }
    this.renderer = null; this.pt = null; this.scene = null; this.rasterScene = null;
  }
}

function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }
