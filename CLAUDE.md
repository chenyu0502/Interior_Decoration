# CLAUDE.md

本檔案提供 Claude Code 在此專案工作時遵循的規則。

## 溝通與文件

- 回覆、文件（README、CHANGELOG、PR 說明）、commit message 與程式碼註解一律使用繁體中文（台灣用語）。
- 中文與英文或數字之間加半形空格，標點使用全形。
- 不使用 emoji。
- 使用者的開發環境是 Windows，說明指令時以 Windows 為準（例如 `start.bat`、`py -m http.server`）。

## 專案概要

Interior Studio：純前端靜態網頁的室內設計工具（2D 平面圖、即時 3D、AI 風格自動設計、寫實渲染、360° 環景）。

- 沒有建置流程，ES Module 直接由瀏覽器載入；`three` 透過 `index.html` 的 importmap 指向 `vendor/three/three.module.min.js`（r169）。
- 第三方函式庫全部放在 `vendor/`（Three.js、Anthropic SDK、three-gpu-pathtracer 打包檔），不使用 CDN。
- 部署：合併到 `main` 後，`.github/workflows/pages.yml` 自動發布到 GitHub Pages。

主要檔案：

| 路徑 | 內容 |
| --- | --- |
| `js/main.js` | 介面控制、目錄、屬性面板、檔案、快捷鍵、渲染視窗、手機版面板 |
| `js/core/state.js` | 專案資料、選取、復原 / 重做、自動存檔 |
| `js/core/geometry.js`、`js/core/model.js` | 幾何計算、房間偵測、牆與門窗關係 |
| `js/editor/plan2d.js` | 2D 平面圖編輯器 |
| `js/editor/view3d.js` | 3D 檢視與漫遊（含陀螺儀、虛擬搖桿） |
| `js/editor/render.js`、`render-look.js` | 寫實渲染（光線追蹤、相容模式）、物理材質與天空 |
| `js/editor/pano-viewer.js` | 360° 環景檢視器與檢視網頁匯出 |
| `js/editor/vr.js` | VR 頭盔模式（WebXR、控制器移動與瞬間移動） |
| `js/data/catalog.js` | 家具與門窗（2D 符號、3D 程序化模型、可調參數） |
| `js/data/materials.js`、`styles.js`、`samples.js` | 材質、風格模板、範例平面圖 |
| `js/ai/` | AI 自動設計、Claude 提案、圖片辨識平面圖 |
| `js/version.js` | 版本號與版本紀錄（網站更新提示依此判斷） |

單位慣例：平面圖以公分為單位、y 軸向下；3D 以公尺為單位（`S = 0.01`），平面 x 對應 3D x、平面 y 對應 3D z。

## 開發流程

1. 從最新的 `main` 建立或重設開發分支 `claude/interior-design-web-app-wtcua0`（前一個 PR 已合併時，以 `git fetch origin main && git checkout -B claude/interior-design-web-app-wtcua0 origin/main` 重新開始）。
2. 修改程式，並在本機啟動伺服器（`npx http-server -p 8765 -c-1`）用 Playwright 實際操作測試；手機相關功能以觸控、手機尺寸模擬測試；VR 功能以 IWER（Immersive Web Emulation Runtime，`installRuntime({ forceInstall: true })`）模擬 Meta Quest 3 測試。
3. 每次發布新功能或修正都要更新版本：
   - `js/version.js` 的 `VERSION`，並在 `CHANGELOG` 最前面新增一筆。
   - 同步更新 `CHANGELOG.md` 與 `package.json` 的版本號。
   - 功能有變動時更新 `README.md`。
   - 版本號規則：新增功能升次版號，錯誤修正升修訂號。
4. commit 後推送到開發分支。

## 自動合併 PR

使用者同意：修改完成且測試通過後，直接開 PR 並合併到 `main`，不需要再詢問。流程：

1. 推送開發分支後開 PR（說明包含變更內容與測試結果）。
2. 測試通過即合併（merge commit），並確認 GitHub Pages 部署已啟動。
3. 向使用者回報修改內容、測試結果、PR 連結與部署狀態。

以下情況不自動合併，先向使用者說明並等待確認：

- 測試沒有通過，或有錯誤尚未解決。
- 有測試環境無法驗證的風險，且可能影響既有功能（例如需要實體手機、顯示卡才能確認的行為改動）。
- 修改範圍超出使用者的要求，或會改變專案檔格式、刪除既有功能、造成舊專案無法開啟。
