---
name: furniture
description: 在 Interior Studio 新增或修改家具、電器、裝飾的 3D 程序化模型（js/data/catalog.js），包含 2D 平面符號、3D 建模、風格配色、可開關的門片與抽屜、櫃內物品，並以截圖檢查成果。使用者要求「新增家具」、「做一個 XX 的模型」、「把 XX 做得更寫實」、「XX 打開要看得到 YY」、「調整家具外觀」時使用。不需要 Blender 或其他軟體。
---

# 新增 / 修改家具

Interior Studio 的家具全部是用程式產生的 3D 模型（Three.js），定義在 `js/data/catalog.js`。這個 skill 是固定流程：寫模型 → 截圖檢查 → 修正 → 收尾。

## 1. 先讀程式

- 讀 `js/data/catalog.js` 開頭的工具（`mat`、`Kit`、`carcass`、`hingedDoors`、`drawerBox`、`deskDrawer`、`fillWardrobe`、`fillShoes` 等）與要修改的項目，沿用既有寫法，不要另起一套。
- 找類似的家具當範本（例如櫃子看 `buildCabinet`、桌子看 `buildTable`、電器看 `buildFridge`）。

## 2. 目錄項目欄位

```js
{ id: 'sofa3', name: '三人沙發', cat: 'living', w: 220, d: 92, h: 80, roles: ['fabric', 'fabric2'], plan: planSofa, build: (k, w, d, h) => buildSofa(k, w, d, h) },
```

| 欄位 | 說明 |
| --- | --- |
| `id` | 英文小寫與底線，專案檔會存這個值，既有 id 不可改名或刪除（舊專案會打不開） |
| `name` | 繁體中文名稱，顯示在選單 |
| `cat` | 分類：`living` `dining` `bedroom` `study` `kitchen` `bath` `storage` `light` `decor` `outdoor` |
| `w` `d` `h` | 預設寬、深、高（公分），依台灣常見尺寸 |
| `elev` | 離地高度（公分）：掛牆物件、吊燈、放在桌上的燈 |
| `roles` | 可在屬性面板改色的配色角色（最多 2 個）：`fabric` `fabric2` `wood` `wood2` `metal` `stone` `lacquer` `accent` `rug` `leaf` `ceramic` |
| `plan` | 2D 平面符號 `(ctx, w, d, lw, pal, prm)`，用 `P.rect`、`P.line`、`P.circle`、`P.label`、`rr`、`fillStroke`、`tint` |
| `build` | 3D 模型 `(k, w, d, h, prm)`，`k` 是 `Kit` |
| 其他 | `ceiling: true`（吊頂燈具）、`light: { intensity, dist }`（會發光）、`flat: true`（地毯類）、`params`（可調參數，見中島 `kitchen_island`） |

## 3. 建模規則

- 單位公分；原點在底面中心；**正面朝 +Z**，背面靠 -Z（靠牆那面）。`Kit` 的 `box(w, h, d, x, y, z, m, r)` 中 y 是底面高度。
- 材質一律用 `mat(color, kind)`（有快取），種類：`matte` `fabric` `boucle` `velvet` `wood` `metal` `gold` `chrome` `stone` `gloss` `ceramic` `glass` `mirror` `emissive` `sheer`。寫實渲染與實景模式會依種類自動加上光澤、絨面、清漆、玻璃折射，所以種類要選對。
- 顏色跟著風格：用 `k.pal`（`fabric`、`wood`、`lacquer`、`metal`、`stone`…）、`k.woodMat()`、`k.fabricMat()`、`k.metalMat()`，不要寫死顏色（電器、食物等固定色的東西例外）。
- 風格差異：`k.pal.legs`（`wood` `taper` `metal` `gold` `plinth`）決定腳的樣式；現代風（`metal`）的櫃子無把手；`softR(k.pal, n)` 取得圓角大小。
- 可開關的部件：
  - 有門的櫃子用 `carcass`（中空櫃體）+ `hingedDoors`（鉸鏈門片），內部放層板與物品。
  - 抽屜用 `drawerBox`；桌面下的抽屜用 `deskDrawer`。
  - 其他（翻蓋、單扇電器門）用 `k.pivot(x, z, { type: 'swing' | 'flip' | 'slide', angle | dx | dz, y })`，在回傳的 `done()` 之前加入的物件會一起動。
  - `swing` 繞 Y 軸（鉸鏈在左邊時角度為負，門往 +Z 外開）；`flip` 繞 X 軸（例如烤箱門、馬桶蓋）；`slide` 平移。
  - 漫遊時點擊即可開關，`view3d.js` 會自動收集，不用另外登記。
- 櫃內物品要符合真實：衣櫃有衣物、鞋櫃有鞋、冰箱有食物。物品放在門片關閉後的空間內，不可穿出門片或櫃體。
- 效能：單件家具網格數盡量在 150 以內；重複的小物件共用 `mat()` 回傳的材質。
- 2D 符號與 3D 外形要一致（尺寸、方向、門的開向）。

## 4. 截圖檢查（每次修改後都做）

1. 啟動本機伺服器：`npx http-server -p 8765 -c-1`（Windows 也可用 `py -m http.server 8765`）。
2. 執行：

   ```
   node .claude/skills/furniture/shoot.mjs <家具 id，可用逗號分隔> [風格 id] [輸出資料夾]
   ```

   會輸出 `<id>-front.png`（正面）、`<id>-angle.png`（斜角）、`<id>-open.png`（所有門與抽屜打開，有可動部件才有）、`<id>-thumb.png`（選單縮圖），並列出錯誤訊息。
3. 用 Read 看每張截圖，確認比例、方向、物件沒有穿插或浮空、打開後內容正確。
4. 至少用兩種風格檢查（例如 `nordic` 與 `modern`，`modern` 沒有把手、`luxury` 用金色五金）。風格 id：`modern` `nordic` `japandi` `wabisabi` `luxury`。
5. 需要時再用 Playwright 測漫遊點擊開關。

腳本需要 Playwright。使用者電腦上沒有時，先詢問是否同意安裝（`npm i -D playwright`），不要自行安裝。

## 5. 收尾

- 依 CLAUDE.md 更新版本：`js/version.js`（`VERSION` 與 `CHANGELOG`）、`CHANGELOG.md`、`package.json`；新增家具升次版號，外觀修正升修訂號。
- 新增家具時更新 `README.md` 的家具清單；需要 AI 自動設計自動擺放時，另外修改 `js/ai/designer.js`。
- 截圖給使用者看（SendUserFile），回報修改內容與測試結果，再依 CLAUDE.md 開 PR 合併。
