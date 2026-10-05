// 選用：串接 Claude API 取得更深入的設計提案（需自備 API Key，金鑰只存在使用者瀏覽器）
import Anthropic from '../../vendor/anthropic-sdk.min.js';
import { STYLE_MAP } from '../data/styles.js';
import { CATALOG_MAP } from '../data/catalog.js';
import { MATERIAL_MAP } from '../data/materials.js';
import { ROOM_TYPES } from './designer.js';

const KEY_STORAGE = 'interior-studio:anthropic-key';
export const MODEL = 'claude-opus-5-5';

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}
export function setApiKey(k) {
  try { if (k) localStorage.setItem(KEY_STORAGE, k); else localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
}

function summarize(project, report) {
  const style = STYLE_MAP[project.design.styleId];
  const rooms = (report?.rooms || []).map((r) => {
    const room = project.rooms.find((x) => x.id === r.id);
    const items = project.items.filter((it) => room && inPoly(it.x, it.y, room.points)).map((it) => `${CATALOG_MAP[it.kind]?.name || it.kind}（${it.w}×${it.d}×${it.h} cm）`);
    return {
      名稱: r.name, 類型: ROOM_TYPES[r.type] || r.type, 面積: `${r.m2.toFixed(1)} m² / ${r.ping.toFixed(1)} 坪`,
      地坪: MATERIAL_MAP[r.floor]?.name, 牆面: MATERIAL_MAP[r.wall]?.name, 目前配置: items, 配置說明: r.notes,
    };
  });
  return {
    風格模板: style ? { 名稱: style.name, 特色: style.features, 色彩與材質: style.colors, 適用空間: style.suits } : null,
    總面積: report ? `${report.totalM2.toFixed(1)} m² / ${report.totalPing.toFixed(1)} 坪` : null,
    牆高: `${project.settings.wallHeight} cm`,
    空間: rooms,
  };
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const SYSTEM = `你是一位資深的台灣室內設計師。使用者用網頁工具畫好平面圖，系統已依選定的風格模板自動配置家具與材質。
請根據提供的平面資料，以繁體中文（台灣用語）撰寫一份專業、具體、可執行的室內設計提案：
1. 整體設計概念（2–3 句，扣緊風格模板的特色、色彩材質與適用空間）。
2. 色彩計畫與材質建議（列出主色、輔色、點綴色與建材，盡量具體到色號方向或材質名稱）。
3. 逐一空間的設計建議：動線、家具尺寸是否合適、收納、照明（色溫與層次）、軟裝。若自動配置有不合理之處，直接指出並提出調整方式。
4. 預算分配與施工優先順序建議（以比例或高/中/低描述即可，不要編造精確金額）。
使用 Markdown 標題與條列，避免空泛形容詞，總長度控制在 900 字以內。`;

/**
 * 串流取得設計提案
 * @param {object} project
 * @param {object} report  designer.autoDesign 的結果
 * @param {(text:string)=>void} onText  每收到一段文字就呼叫
 */
export async function requestProposal(project, report, onText, extraPrompt = '') {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('尚未設定 Anthropic API Key');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const data = summarize(project, report);
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    // 遇到安全分類拒絕時由伺服器自動改用替代模型
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `以下是平面圖與自動配置資料（JSON）：\n\n${JSON.stringify(data, null, 2)}${extraPrompt ? `\n\n使用者補充需求：${extraPrompt}` : ''}`,
    }],
  });
  stream.on('text', (t) => onText(t));
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude 無法處理此請求，請調整補充說明後再試一次。');
  return msg;
}

export function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'API Key 無效，請重新設定。';
  if (e instanceof Anthropic.PermissionDeniedError) return '此 API Key 沒有使用該模型的權限。';
  if (e instanceof Anthropic.RateLimitError) return '請求過於頻繁，請稍後再試。';
  if (e instanceof Anthropic.APIConnectionError) return '無法連線到 Claude API，請檢查網路。';
  if (e instanceof Anthropic.APIError) return `Claude API 錯誤（${e.status ?? ''}）：${e.message}`;
  return e?.message || String(e);
}
