// 實景模式：3D 畫面停止操作片刻後，直接在畫面上以光線追蹤逐步算出照片般的效果
// （日光從窗戶照入、光線在室內反彈、柔和陰影與反射）；一旦移動視角或修改設計，立即切回即時畫面。
// 沿用寫實渲染（RenderStudio）的場景、材質、天空與自動曝光設定。
import * as THREE from 'three';
import { store } from '../core/state.js';
import { RenderStudio, RENDER_TIMES } from './render.js';

const PREF_KEY = 'interior-live-trace';
const IDLE_MS = 350; // 停止操作多久後開始計算

let ptModule = null;
async function loadPathTracer() {
  if (!ptModule) ptModule = await import('../../vendor/pathtracer/three-gpu-pathtracer.min.js');
  return ptModule;
}

function prefGet() { try { return localStorage.getItem(PREF_KEY); } catch { return null; } }
function prefSet(v) { try { localStorage.setItem(PREF_KEY, v); } catch { /* 無法儲存時只在本次有效 */ } }

export class LiveTrace {
  constructor(view3d, { mobile = false } = {}) {
    this.v = view3d;
    this.mobile = mobile;
    this.enabled = prefGet() !== 'off';
    this.failed = false;
    this.safe = 0; // 降級次數：顯示卡中斷或畫面異常時降低解析度與每次計算量後重試
    this.state = 'idle'; // idle：未計算；tracing：計算中；done：已完成
    this.covering = false; // 照片是否蓋在即時畫面上
    this.sceneDirty = true;
    this.lastActivity = performance.now();
    // 取樣越多越清晰：達到上限後停止，保留最後的照片
    this.maxSamples = mobile ? 320 : 1200;
    this.onStatus = null;
  }

  setEnabled(on) {
    this.enabled = on;
    prefSet(on ? 'on' : 'off');
    if (!on) this.cancel();
    this.lastActivity = performance.now();
    this.status();
  }

  // 視角移動、設計修改、選取物件時呼叫：取消目前的照片
  activity(sceneChanged = false) {
    this.lastActivity = performance.now();
    if (sceneChanged) this.sceneDirty = true;
    if (this.state !== 'idle' || this.covering) this.cancel();
  }

  cancel() {
    this.state = 'idle';
    this.ready = false;
    this.run = (this.run || 0) + 1;
    this.hide();
    this.status();
  }

  hide() {
    if (!this.canvas) return;
    this.covering = false;
    this.canvas.style.transition = 'none';
    this.canvas.style.opacity = '0';
  }

  show() {
    if (!this.canvas || this.covering) return;
    this.covering = true;
    this.canvas.style.transition = 'opacity .45s ease';
    this.canvas.style.opacity = '1';
  }

  get busy() { return this.state === 'tracing'; }

  // 每個畫面由 3D 檢視呼叫（即時畫面已渲染之後）
  tick(paused) {
    if (!this.enabled || this.failed) return;
    if (paused) { if (this.state === 'tracing') this.cancel(); return; }
    if (this.state === 'done') return;
    if (this.state === 'idle') {
      if (performance.now() - this.lastActivity < IDLE_MS) return;
      this.begin();
      return;
    }
    this.step();
  }

  init() {
    if (!this.initP) this.initP = this._init();
    return this.initP;
  }

  async _init() {
    try {
      const mod = await loadPathTracer();
      this.mod = mod;
      const r = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
      r.setPixelRatio(1);
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.toneMapping = THREE.NeutralToneMapping;
      const c = r.domElement;
      Object.assign(c.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', opacity: '0', pointerEvents: 'none' });
      // 放在工具列之前，按鈕仍在照片上方
      this.v.container.insertBefore(c, this.v.container.firstChild);
      c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.retry('顯示卡記憶體不足或驅動程式中斷（WebGL context lost）'); });
      this.renderer = r;
      this.canvas = c;
      const rs = new RenderStudio(this.v);
      rs.renderer = r;
      this.rs = rs;
      const pt = new mod.WebGLPathTracer(r);
      pt.renderDelay = 0;
      pt.fadeDuration = 0;
      pt.minSamples = 1;
      pt.dynamicLowRes = false;
      pt.rasterizeScene = false;
      pt.bounces = this.mobile ? 3 : 5;
      pt.filterGlossyFactor = 0.8;
      pt.textureSize.set(512, 512);
      rs.pt = pt;
      this.useDenoise(pt, mod);
      rs.reblit = () => { pt.pausePathTracing = true; pt.renderSample(); pt.pausePathTracing = false; };
      this.pt = pt;
      return true;
    } catch (err) {
      console.warn('實景模式無法使用', err);
      this.fail(`無法啟動光線追蹤（${err?.message || err}）`);
      return false;
    }
  }

  // 降噪：保留邊緣的平滑濾鏡；取樣少時平滑較強，取樣多時仍保留輕度平滑去除殘餘顆粒
  useDenoise(pt, mod) {
    if (!mod.DenoiseMaterial) return;
    const dm = new mod.DenoiseMaterial({ blending: THREE.NoBlending });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dm);
    quad.frustumCulled = false;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    cam.position.z = 0.5;
    this.keep = [dm, quad.geometry];
    pt.renderToCanvasCallback = (target, renderer, q) => {
      const n = Math.max(1, pt.samples);
      dm.map = target.texture;
      dm.opacity = q.material.opacity;
      dm.sigma = Math.min(5, 2 + 9 / Math.sqrt(n));
      dm.kSigma = 1.2;
      dm.threshold = Math.min(0.3, Math.max(0.05, 1 / Math.sqrt(n)));
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(quad, cam);
      renderer.autoClear = ac;
    };
  }

  // 降低解析度與每次計算量後重新啟動；降級兩次仍失敗才停用
  retry(reason) {
    console.warn('實景模式：', reason);
    if (this.safe >= 2) { this.fail(reason); return; }
    this.safe++;
    this.cancel();
    this.teardown();
    this.lastReason = reason;
  }

  teardown() {
    try { this.pt?.dispose(); } catch { /* 忽略 */ }
    for (const d of [...(this.rs?.disposables || []), ...(this.keep || [])]) d.dispose?.();
    if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss?.(); }
    this.canvas?.remove();
    this.pt = null; this.renderer = null; this.canvas = null; this.rs = null; this.keep = null;
    this.scene = null; this.sceneDirty = true; this.initP = null;
  }

  gpuName() {
    try {
      const gl = (this.renderer || this.v.renderer).getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { return ''; }
  }

  fail(reason) {
    this.failed = true;
    this.cancel();
    const gpu = this.gpuName();
    this.failReason = gpu ? `${reason}；顯示卡：${gpu}` : reason;
    console.warn('實景模式停用：', this.failReason);
    this.status();
  }

  // 依目前的 3D 畫面建立光線追蹤場景
  options() {
    const P = store.project, v = this.v;
    const night = !!P.settings.night;
    const inside = v.mode === 'walk';
    return {
      time: night ? 'night' : 'day',
      lights: night,
      ceiling: inside,
      engine: 'pathtracing',
      detail: true,
      ...(v.sunSim && !night ? { sunSim: v.sunSim } : {}),
    };
  }

  size() {
    const r = this.v.container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 1.25);
    // 解析度上限：手機長邊 900、電腦 1600 像素
    const cap = (this.mobile ? 900 : 1600) * [1, 0.7, 0.5][this.safe];
    let W = r.width * dpr, H = r.height * dpr;
    const s = Math.min(1, cap / Math.max(W, H));
    W = Math.max(16, Math.round(W * s)); H = Math.max(16, Math.round(H * s));
    return { W, H };
  }

  async begin() {
    this.state = 'tracing';
    this.ready = false;
    const run = (this.run = (this.run || 0) + 1);
    this.status();
    if (!(await this.init())) return;
    if (this.state !== 'tracing' || run !== this.run) return;
    const { W, H } = this.size();
    const r = this.renderer, pt = this.pt, rs = this.rs;
    if (r.domElement.width !== W || r.domElement.height !== H) r.setSize(W, H, false);
    // 分塊計算：每次只算一小塊，避免單次運算太久被顯示卡驅動程式中斷（Windows TDR）
    const tilePx = [60000, 30000, 15000][this.safe];
    const tilesN = Math.min(12, Math.max(1, Math.ceil(Math.sqrt((W * H) / tilePx))));
    pt.tiles.set(tilesN, tilesN);
    const opts = this.options();
    const optKey = JSON.stringify(opts);
    const cam = this.v.camera.clone();
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.cam = cam;
    try {
      if (this.sceneDirty || optKey !== this.optKey || !this.scene) {
        // 釋放上一個場景的資源後重新建立
        for (const d of rs.disposables) d.dispose?.();
        rs.disposables = [];
        this.scene = rs.buildScene(opts, this.mod);
        this.sceneDirty = false;
        this.optKey = optKey;
        this.exposed = false;
        pt.setScene(this.scene, cam);
      } else {
        pt.setCamera(cam);
        pt.reset();
      }
    } catch (err) {
      console.warn('實景模式場景建立失敗', err);
      this.retry(`場景建立失敗（${err?.message || err}）`);
      return;
    }
    const t = RENDER_TIMES[opts.time] || RENDER_TIMES.day;
    this.timeKey = t.key;
    if (!this.exposed) { rs.baseExposure = t.exposure; rs.userExposure = 1; }
    r.toneMappingExposure = rs.baseExposure;
    this.checked = false;
    this.recheck = 0;
    this.perFrame = 1;
    this.lastFrame = performance.now();
    this.t0 = performance.now();
    this.ready = true;
  }

  step() {
    const pt = this.pt, rs = this.rs;
    if (!pt || !this.ready) return;
    const now = performance.now(), dt = now - this.lastFrame;
    this.lastFrame = now;
    // 依畫面間隔調整取樣量，避免拖慢操作
    if (dt < 24 && this.perFrame < 6) this.perFrame++;
    else if (dt > 50 && this.perFrame > 1) this.perFrame = Math.max(1, this.perFrame >> 1);
    for (let i = 0; i < this.perFrame && pt.samples < this.maxSamples; i++) pt.renderSample();
    if (!this.checked && pt.samples >= 2) {
      this.checked = true;
      if (!this.exposed) { rs.autoExpose(this.timeKey); this.exposed = true; }
      const bad = store.project.settings.night ? null : rs.diagnose();
      // 剛開始畫面可能還沒算完整，異常時多算幾次再確認一次
      if (bad) this.recheck = 12;
      else this.show();
    }
    if (this.recheck && pt.samples >= this.recheck) {
      this.recheck = 0;
      rs.autoExpose(this.timeKey);
      const bad = rs.diagnose();
      if (bad) { this.retry(bad); return; }
      this.show();
    }
    if (pt.samples >= this.maxSamples) this.state = 'done';
    this.status();
  }

  status() {
    const s = this.pt?.samples || 0;
    this.onStatus?.({
      enabled: this.enabled,
      failed: this.failed,
      reason: this.failReason,
      state: this.state,
      covering: this.covering,
      progress: this.state === 'done' ? 1 : Math.min(1, s / this.maxSamples),
    });
  }

  dispose() { this.teardown(); }
}
