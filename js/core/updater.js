// 檢查新版本：讀取伺服器上最新的 version.js，版本較新時通知介面
import { VERSION, compareVersions } from '../version.js';

const CHECK_INTERVAL = 5 * 60 * 1000; // 每 5 分鐘檢查一次
const SNOOZE_KEY = 'interior-studio:update-snoozed';

// 以不同網址載入，避開瀏覽器快取與模組快取
async function fetchLatest() {
  const url = new URL('../version.js', import.meta.url);
  url.searchParams.set('t', Date.now());
  return import(url.href);
}

export class Updater {
  /** @param {(latest: {VERSION: string, CHANGELOG: object[]}) => void} onUpdate */
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.checking = false;
    this.shownFor = null;
  }

  start() {
    // 頁面載入後稍等再檢查，避免影響啟動速度
    setTimeout(() => this.check(), 3000);
    setInterval(() => this.check(), CHECK_INTERVAL);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.check(); });
  }

  /** @param {boolean} manual 使用者手動檢查時，忽略「稍後再說」並回報結果 */
  async check(manual = false) {
    if (this.checking) return null;
    this.checking = true;
    try {
      const latest = await fetchLatest();
      if (compareVersions(latest.VERSION, VERSION) <= 0) return { latest, newer: false };
      const snoozed = sessionGet(SNOOZE_KEY);
      if (!manual && (snoozed === latest.VERSION || this.shownFor === latest.VERSION)) return { latest, newer: true };
      this.shownFor = latest.VERSION;
      this.onUpdate(latest);
      return { latest, newer: true };
    } catch {
      return null; // 離線或檔案暫時無法讀取時略過
    } finally {
      this.checking = false;
    }
  }

  snooze(version) { sessionSet(SNOOZE_KEY, version); }

  // 重新下載已載入的程式與樣式（更新瀏覽器快取）後重新整理頁面
  async apply() {
    const urls = new Set([location.href.split('#')[0]]);
    for (const e of performance.getEntriesByType('resource')) {
      const u = new URL(e.name);
      if (u.origin === location.origin && /\.(js|css|html|json)$/.test(u.pathname)) { u.search = ''; urls.add(u.href); }
    }
    await Promise.allSettled([...urls].map((u) => fetch(u, { cache: 'reload' })));
    location.reload();
  }
}

function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 無法儲存時忽略 */ } }
