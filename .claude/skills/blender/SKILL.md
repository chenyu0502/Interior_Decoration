---
name: blender
description: 透過 MCP for Blender（https://github.com/ahujasid/blender-mcp，套件名 mcp-for-blender）操作使用者電腦上的 Blender：建模家具與裝飾、套用材質、渲染檢查、匯入 Poly Haven / Sketchfab 素材，並匯出 glTF（.glb）。當使用者要求「用 Blender 做 / 改模型」、「在 Blender 裡渲染」、「從 Blender 匯出模型」或提到 blender MCP 時使用。
---

# Blender（MCP for Blender）

MCP for Blender 讓 Claude 直接控制使用者電腦上正在執行的 Blender：寫 Blender Python 建模、調整材質、從多個角度截圖檢查成果、匯入免費素材。它只能在使用者自己的電腦上運作（需要 Blender 開著），雲端工作環境無法使用。

## 使用前檢查

1. 確認工具已連線：可用的工具名稱以 `mcp__blender__` 開頭（例如 `mcp__blender__get_scene_info`）。沒有這些工具時，不要假裝已連線，改為依「安裝與設定」引導使用者。
2. 先呼叫 `get_addon_status` 確認 Blender 與附加元件版本，再用 `get_scene_info` 了解目前場景，不要直接覆蓋使用者的場景。
3. 需要安裝或下載任何東西（uv、附加元件、素材、AI 生成模型）前，先告知使用者並取得同意（專案規則：安裝軟體前先通知）。

## 安裝與設定（Windows，由使用者在自己的電腦上執行）

需要：Blender 3.0 以上、uv（Python 套件管理工具）。以下指令都會安裝或下載軟體，請使用者確認後自行執行：

```powershell
# 1. 安裝 uv（擇一）
winget install --id=astral-sh.uv -e
# 2. 安裝 Blender 附加元件並設定 MCP 用戶端（會詢問要設定哪些 AI 工具，並備份原設定）
uvx mcp-for-blender setup
```

- 本專案根目錄的 `.mcp.json` 已登記名為 `blender` 的 MCP 伺服器（安全模式開啟、遙測關閉）。在專案資料夾啟動 Claude Code 時會詢問是否啟用，選擇允許即可；或手動執行 `claude mcp add blender uvx mcp-for-blender`。
- 開啟 Blender，在 3D 檢視按 `N` 開啟側邊欄 → **MCP for Blender** 分頁，伺服器未啟動時按 **Start MCP Server**。
- 出現 `spawn uvx ENOENT`：Claude Code 找不到 uvx，執行 `where uvx` 取得完整路徑，或把 `.mcp.json` 的 `command` 改為 `cmd`、`args` 改為 `["/c", "uvx", "mcp-for-blender"]`。

## 可用工具

| 工具 | 用途 |
| --- | --- |
| `execute_blender_code` | 在 Blender 中執行 Python（建模、排版、材質、匯出） |
| `look` | 從視埠、相機、多角度或渲染結果截圖，檢查成果 |
| `get_scene_info` | 場景摘要（物件位置、材質、面數） |
| `search_assets`、`import_asset` | Poly Haven（免費 HDRI、貼圖、模型）、Sketchfab、Poly Pizza 素材 |
| `generate_3d` | 以 AI 生成 3D 模型（需付費方案或使用者自己的 API 金鑰，使用前先詢問） |
| `get_addon_status` | Blender、附加元件版本與已啟用的功能 |

## 與 Interior Studio 對應的慣例

- 單位：Blender 1 單位 = 1 公尺，與 Interior Studio 的 3D 場景相同（平面圖的公分 × 0.01）。家具尺寸以 `js/data/catalog.js` 該項目的 `w`（寬，x）、`d`（深）、`h`（高）公分為準。
- 原點：物件原點放在底面中心，模型站在 z = 0 的地面上。
- 方向：家具正面朝 Blender 的 **-Y**（前視圖看到的那一面）。以 glTF 匯出（+Y 朝上）後，正面會對應 Interior Studio 3D 的 +z，與程序化模型相同。
- 材質：使用 Principled BSDF；木紋、布料、石材等盡量用 Poly Haven 的 CC0 貼圖，貼圖解析度以 1K～2K 為主，避免網頁載入過重。
- 匯出：`bpy.ops.export_scene.gltf(filepath=..., export_format='GLB', use_selection=True, export_yup=True)`，檔名用目錄 id（例如 `sofa3.glb`）。
- 每次修改後用 `look` 從正面與 3/4 角度截圖給使用者確認，再進行下一步。

## 注意

- Interior Studio 目前所有家具都是程序化模型（`js/data/catalog.js`），網站尚未支援載入 .glb。要把 Blender 模型放進網站，需要另外加入 glTF 載入器（放在 `vendor/`，不使用 CDN）並調整目錄資料，屬於網站功能修改，依 CLAUDE.md 的開發流程進行。
- 安全：`.mcp.json` 已設定 `BLENDER_MCP_SAFE_MODE=1`，會阻擋讀寫任意檔案、執行其他程式、連網等高風險 Python；一般建模、材質、渲染、存檔與匯入匯出不受影響。附加元件的連接埠（預設 9876）只應在本機使用。
