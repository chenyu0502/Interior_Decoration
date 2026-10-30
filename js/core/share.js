// 分享設計：
// 1. 長網址：把專案壓縮後放在網址 # 之後（不會傳到任何伺服器），不需要設定。
// 2. 短網址：把專案存成使用者 GitHub 帳號下不公開的 Gist，網址只帶 Gist 編號，可做成 QR code。
//    需要使用者自己的 GitHub 權杖（只需 gist 權限），只存在這個瀏覽器。

const TOKEN_KEY = 'interior-studio:github-token';
const GIST_FILE = 'interior-studio.json';

export function getGithubToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setGithubToken(t) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t.trim()); else localStorage.removeItem(TOKEN_KEY); } catch { /* 無痕模式 */ }
}

// 分享用的專案資料：不含底圖（圖片太大），其餘照原樣
export function sharePayload(project) {
  const { background, ...rest } = project;
  // 方案的縮圖是圖片，不放進分享資料
  if (Array.isArray(rest.variants)) rest.variants = rest.variants.map(({ thumb, ...v }) => v);
  return rest;
}

const toB64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (str) => {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// 專案 → 網址片段（deflate 壓縮 + base64url）
export async function encodeProject(project) {
  const json = new TextEncoder().encode(JSON.stringify(sharePayload(project)));
  return toB64url(await pipe(json, new CompressionStream('deflate-raw')));
}
export async function decodeProject(str) {
  let p;
  try {
    const json = await pipe(fromB64url(str), new DecompressionStream('deflate-raw'));
    p = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new Error('分享連結不完整或已損毀（可能複製時少了一段），請對方重新複製完整連結');
  }
  return validProject(p);
}

function validProject(p) {
  if (!p || !Array.isArray(p.walls) || !Array.isArray(p.rooms) || !Array.isArray(p.items)) throw new Error('分享的資料格式不正確');
  return p;
}

// 網站本身的網址（不含 # 與查詢參數）
export function siteUrl() {
  return `${location.origin}${location.pathname}`;
}

export async function longLink(project) {
  return `${siteUrl()}#share=${await encodeProject(project)}`;
}

// 建立不公開的 Gist，回傳短網址
export async function shortLink(project, token = getGithubToken()) {
  if (!token) throw new Error('尚未設定 GitHub 權杖');
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: `Interior Studio 分享：${project.name || '室內設計'}`,
      public: false,
      files: { [GIST_FILE]: { content: JSON.stringify(sharePayload(project)) } },
    }),
  });
  if (res.status === 401) throw new Error('GitHub 權杖無效或已過期，請重新設定');
  if (res.status === 403 || res.status === 404) throw new Error('GitHub 權杖沒有建立 Gist 的權限（需要 gist 權限）');
  if (!res.ok) throw new Error(`GitHub 回應錯誤（${res.status}）`);
  const data = await res.json();
  return { url: `${siteUrl()}?g=${data.id}`, id: data.id, html: data.html_url };
}

// 讀取 Gist 中的專案（不需要權杖）
export async function loadGist(id) {
  if (!/^[0-9a-f]{20,40}$/i.test(id)) throw new Error('分享網址不正確');
  const res = await fetch(`https://api.github.com/gists/${id}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 404) throw new Error('找不到這個分享，可能已被刪除');
  if (res.status === 403) throw new Error('GitHub 暫時限制讀取次數，請稍後再試');
  if (!res.ok) throw new Error(`讀取分享失敗（${res.status}）`);
  const data = await res.json();
  const f = data.files?.[GIST_FILE] || Object.values(data.files || {})[0];
  if (!f) throw new Error('分享內容是空的');
  const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
  return validProject(JSON.parse(text));
}

// 從目前網址讀出分享的專案；沒有分享時回傳 null
export async function readShareFromUrl() {
  const m = location.hash.match(/^#share=([A-Za-z0-9_-]+)/);
  if (m) return { project: await decodeProject(m[1]), kind: 'link' };
  const g = new URLSearchParams(location.search).get('g');
  if (g) return { project: await loadGist(g), kind: 'gist' };
  return null;
}
