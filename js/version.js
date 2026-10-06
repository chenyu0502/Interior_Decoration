// 版本資訊：每次發布新版時更新 VERSION 並在 CHANGELOG 最前面新增一筆。
// 網站會定期讀取伺服器上的這個檔案，版本號較新時跳出更新確認視窗。
// 版本號採語意化版本（主版號.次版號.修訂號）：
//   主版號：不相容的大改版（例如專案檔格式改變）
//   次版號：新增功能
//   修訂號：錯誤修正

export const VERSION = '1.3.0';

export const CHANGELOG = [
  {
    version: '1.3.0',
    date: '2026-10-06',
    notes: [
      '新增版本控制：狀態列顯示目前版本，點選可查看版本紀錄。',
      '網站有新版本時自動跳出更新確認視窗，可選擇立即更新或稍後再說。',
      '檔案選單新增「檢查更新」。',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-10-06',
    notes: [
      '新增「從圖片自動建立平面圖」：匯入 PNG / JPG 格局圖，自動辨識牆體、門窗、門洞並建立房間，不保留底圖。',
      '依門寬自動推估比例尺，可輸入實際總寬度校正。',
      '依面積與門的連通關係推斷房型並命名。',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-06',
    notes: ['新增 GitHub Pages 自動部署，合併到 main 後自動發布網站。'],
  },
  {
    version: '1.0.0',
    date: '2026-10-05',
    notes: [
      '首次發布：2D 平面圖編輯、即時 3D 透視圖、拖拉式家具與門窗、程序化材質。',
      '五種風格模板（現代、北歐、日系無印、侘寂、輕奢）與 AI 自動設計、設計建議書。',
      '選用的 Claude API 設計提案、自動存檔、JSON 匯入匯出、PNG 匯出。',
    ],
  },
];

// 比較版本號：a > b 回傳正數
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
