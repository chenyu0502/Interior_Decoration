// 光線追蹤的顯示卡節流與頁面離開時的停止。
// WebGL 指令是非同步送到顯示卡的，只看畫面間隔（CPU 時間）調整取樣量時，顯示卡的工作會一直堆積；
// 指令佇列塞滿時 Chrome 的顯示卡處理程序被占滿，整個瀏覽器（包括「上一頁」）都會失去回應。
// GpuPacer 以 WebGL2 fence 確認上一批工作已在顯示卡上完成才送出下一批，並依完成的速度調整每批的取樣次數，
// 讓每批大約在一個畫面的時間內做完。

export class GpuPacer {
  constructor(renderer, { max = 8 } = {}) {
    this.gl = renderer.getContext();
    this.max = max;
    this.n = 1;
    this.sync = null;
    this.t = 0;
    this.late = false;
  }

  // 這個畫面可以送出幾次取樣；上一批還沒完成時回傳 0（這個畫面不送，讓顯示卡先做完）
  take() {
    const gl = this.gl;
    if (this.sync) {
      let done = true;
      try { done = gl.getSyncParameter(this.sync, gl.SYNC_STATUS) === gl.SIGNALED; } catch { /* 環境失效時視為完成 */ }
      if (!done) { this.late = true; return 0; }
      try { gl.deleteSync(this.sync); } catch { /* 忽略 */ }
      this.sync = null;
      // 下一個畫面就完成：可以多送一些；超過兩個畫面才完成：減半
      const took = performance.now() - this.t;
      if (this.late || took > 34) this.n = Math.max(1, this.n >> 1);
      else if (took < 22 && this.n < this.max) this.n++;
      this.late = false;
    }
    return this.n;
  }

  // 送出這批取樣後呼叫
  mark() {
    const gl = this.gl;
    if (typeof gl.fenceSync !== 'function') { this.n = 1; return; } // WebGL1：無法確認，固定每個畫面一次
    try {
      this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      this.t = performance.now();
    } catch { this.sync = null; }
  }

  dispose() {
    if (this.sync) { try { this.gl.deleteSync(this.sync); } catch { /* 忽略 */ } }
    this.sync = null;
  }
}

// 頁面離開（pagehide，onStop('leave')）或切到背景（visibilitychange → hidden，onStop('hidden')）時停止；
// 回到前景（包括從上一頁快取還原）時呼叫 onResume
export function onPageHidden(onStop, onResume) {
  window.addEventListener('pagehide', () => onStop('leave'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onStop('hidden');
    else onResume?.();
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) onResume?.(); });
}
