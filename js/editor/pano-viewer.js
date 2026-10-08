// 360° 環景檢視器：以 WebGL 將等距柱狀（2:1）環景圖顯示成可拖曳環顧的畫面。
// mountPano 不依賴任何外部程式，同一份程式碼也會嵌入匯出的獨立 HTML 檢視網頁。

export function mountPano(container, img, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab';
  container.appendChild(canvas);
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
  if (!gl) { container.textContent = '此瀏覽器不支援 WebGL，無法顯示 360° 環景'; return { dispose() {} }; }

  const vs = 'attribute vec2 p; varying vec2 vp; void main(){ vp = p; gl_Position = vec4(p, 0.0, 1.0); }';
  // 與光線追蹤引擎相同的等距柱狀座標：方向 = (sinφ·cosθ, cosφ, sinφ·sinθ)
  const fs = [
    'precision highp float;',
    'uniform sampler2D tex; uniform float yaw, pitch, tanHalf, aspect; varying vec2 vp;',
    'const float PI = 3.141592653589793;',
    'void main(){',
    '  vec3 d = normalize(vec3(vp.x * tanHalf * aspect, vp.y * tanHalf, -1.0));',
    '  float cp = cos(pitch), sp = sin(pitch);',
    '  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);',
    '  float ca = cos(yaw), sa = sin(yaw);',
    '  d = vec3(d.x * ca + d.z * sa, d.y, -d.x * sa + d.z * ca);',
    '  float u = atan(d.z, d.x) / (2.0 * PI) + 0.5;',
    '  float v = 1.0 - acos(clamp(d.y, -1.0, 1.0)) / PI;',
    '  gl_FragColor = texture2D(tex, vec2(u, v));',
    '}',
  ].join('\n');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uYaw = U('yaw'), uPitch = U('pitch'), uTan = U('tanHalf'), uAspect = U('aspect');

  const st = { yaw: opts.yaw || 0, pitch: 0, fov: 75, auto: opts.autoRotate !== false, raf: 0, alive: true };
  const draw = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform1f(uYaw, st.yaw);
    gl.uniform1f(uPitch, st.pitch);
    gl.uniform1f(uTan, Math.tan((st.fov * Math.PI) / 360));
    gl.uniform1f(uAspect, w / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  let last = performance.now();
  const loop = (t) => {
    if (!st.alive) return;
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    if (st.auto) st.yaw -= dt * 0.12; // 尚未操作前緩慢自動旋轉
    draw();
    st.raf = requestAnimationFrame(loop);
  };
  st.raf = requestAnimationFrame(loop);

  // 拖曳環顧、滾輪或雙指縮放
  const pts = new Map();
  let pinch = 0;
  const clampPitch = () => { st.pitch = Math.max(-1.45, Math.min(1.45, st.pitch)); };
  canvas.addEventListener('pointerdown', (e) => { st.auto = false; canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.style.cursor = 'grabbing'; });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch && before > 0) st.fov = Math.max(30, Math.min(100, st.fov * (before / after)));
      pinch = 1;
      return;
    }
    const k = (st.fov / 75) * 0.0045;
    st.yaw += (e.clientX - p.x) * k;
    st.pitch += (e.clientY - p.y) * k;
    clampPitch();
    p.x = e.clientX; p.y = e.clientY;
  });
  const up = (e) => { pts.delete(e.pointerId); pinch = 0; canvas.style.cursor = 'grab'; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); st.auto = false; st.fov = Math.max(30, Math.min(100, st.fov * Math.exp(e.deltaY * 0.001))); }, { passive: false });

  return {
    canvas,
    reset() { st.yaw = opts.yaw || 0; st.pitch = 0; st.fov = 75; },
    dispose() { st.alive = false; cancelAnimationFrame(st.raf); gl.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); },
  };
}

// 產生可單獨開啟、傳給客戶的 360° 檢視網頁（圖片內嵌在檔案中，不需網路）
export function panoViewerHTML(dataURL, title, yaw = 0) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${esc(title)} · 360° 環景</title>
<style>html,body{margin:0;height:100%;background:#111;color:#fff;font-family:system-ui,sans-serif;overflow:hidden}#v{position:fixed;inset:0}
.bar{position:fixed;left:12px;bottom:12px;right:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;pointer-events:none}
.tag{background:rgba(0,0,0,.55);padding:6px 12px;border-radius:999px;font-size:13px}</style></head>
<body><div id="v"></div><div class="bar"><span class="tag">${esc(title)}</span><span class="tag">拖曳環顧 · 滾輪或雙指縮放</span></div>
<script>
${mountPano.toString()}
var img = new Image();
img.onload = function () { mountPano(document.getElementById('v'), img, { yaw: ${Number(yaw) || 0} }); };
img.src = ${JSON.stringify(dataURL)};
</script></body></html>`;
}
