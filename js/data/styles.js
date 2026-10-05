// 風格模板。features / colors / suits 三個欄位是使用者提供的原始說明，請勿任意改寫；
// 其餘欄位（材質、配色、家具偏好、建議）是 AI 自動設計引擎實際使用的參數。
// 新增風格：複製任一物件、改 id 與參數即可，介面會自動列出。

export const STYLES = [
  {
    id: 'modern',
    name: '現代風',
    en: 'Modern',
    features: '俐落線條、重視機能配置與材質層次。',
    colors: '中性色（如黑白灰、米色）、木質、石材與金屬。',
    suits: '各坪數皆宜，特別適合追求時尚感與高效收納的家庭。',
    swatches: ['#f4f3ef', '#c9cacb', '#4a4c4f', '#7a553a', '#2b2b2d', '#d8cdb9'],
    materials: {
      floor: { default: 'tile_grey', bedroom: 'wood_walnut', master: 'wood_walnut', study: 'wood_walnut', kitchen: 'tile_grey', bathroom: 'tile_bath', balcony: 'tile_bath', entry: 'tile_grey' },
      wall: { default: 'paint_white', bathroom: 'tile_subway', kitchen: 'paint_white' },
      accent: { tvWall: 'marble_white', bedHead: 'paint_charcoal' },
    },
    palette: {
      fabric: '#5f6266', fabric2: '#a9adb1', wood: '#7a553a', wood2: '#3d2c22', metal: '#1e1e1e',
      stone: '#e7e5e1', lacquer: '#f1f0ec', accent: '#b07a45', rug: '#4b4d50', leaf: '#4f7a45', ceramic: '#f7f7f5',
      legs: 'metal', soft: 1.5,
    },
    prefs: { sofa: 'sofa_l', dining: 'dining_table', bed: 'bed_double', storageWall: 'bookshelf', curtains: true, plants: 1, artwork: true, pendant: 'pendant_linear', lightTemp: 4000 },
    tips: {
      general: ['以黑、白、灰為主調，局部搭配胡桃木與金屬線條增加層次。', '收納整合在壁面櫃體中，維持立面平整俐落。', '照明以嵌燈、軌道燈加上間接光帶為主，避免繁複主燈。'],
      living: ['電視牆可用大板石材或岩板，搭配懸浮電視櫃製造輕盈感。', '沙發選擇低背、細金屬腳款式，L 型配置可兼顧動線與座位數。'],
      dining: ['餐桌可選石材或岩板桌面，搭配線條吊燈形成視覺軸線。'],
      master: ['床頭牆以深色塗料或繃布板塑造重點，床頭櫃可做懸吊式。'],
      bedroom: ['衣櫃門片建議無把手設計（按壓或隱藏把手），保持立面簡潔。'],
      kitchen: ['廚具可選霧面門板，檯面使用石英石或不鏽鋼，好清潔又耐用。'],
      bathroom: ['乾濕分離搭配大片玻璃隔屏，壁面可延伸大板磚營造一致性。'],
      study: ['書桌面向窗戶取得自然光，背牆整面系統櫃收納。'],
    },
  },
  {
    id: 'nordic',
    name: '北歐風',
    en: 'Scandinavian',
    features: '明亮、溫暖，重視自然採光與生活感。',
    colors: '淺色基底、木質家具、布料織品與局部跳色。',
    suits: '中小坪數或採光需要被引進的空間。',
    swatches: ['#f4f3ef', '#c9a57a', '#b5bfa8', '#a9b6c2', '#e3b75c', '#8d8f93'],
    materials: {
      floor: { default: 'wood_oak', kitchen: 'tile_white', bathroom: 'tile_hex', balcony: 'tile_bath', entry: 'tile_hex' },
      wall: { default: 'paint_white', bathroom: 'tile_subway' },
      accent: { sofaWall: 'paint_sage', bedHead: 'paint_blue' },
    },
    palette: {
      fabric: '#b9bcbd', fabric2: '#e3b75c', wood: '#c9a57a', wood2: '#a9804f', metal: '#2e2e2e',
      stone: '#f1efeb', lacquer: '#f7f6f2', accent: '#3f6e8c', rug: '#e8e2d6', leaf: '#5c8a4a', ceramic: '#f7f7f5',
      legs: 'taper', soft: 3,
    },
    prefs: { sofa: 'sofa3', dining: 'dining_table', bed: 'bed_double', storageWall: 'bookshelf', curtains: true, plants: 2, artwork: true, pendant: 'pendant_dome', lightTemp: 3000, armchair: true },
    tips: {
      general: ['大面積白牆與淺木地板，把自然光放到最大。', '以抱枕、地毯、掛畫做局部跳色（芥末黃、霧霾藍、鼠尾草綠）。', '綠色植栽是北歐風的靈魂，建議至少 2 處。'],
      living: ['布質沙發搭配錐形實木腳，加上單椅與落地燈形成閱讀角。', '沙發背牆可漆上低彩度跳色，掛上黑框掛畫。'],
      dining: ['圓弧或實木餐桌搭配不同款式餐椅，增加生活感。', '餐桌上方使用造型吊燈（如穹頂燈）聚焦。'],
      master: ['床頭牆可使用霧霾藍或灰綠塗料，搭配亞麻寢具。'],
      bedroom: ['窗簾選用透光紗簾，保留採光並柔化光線。'],
      kitchen: ['白色門板配木紋檯面或地鐵磚壁面，清爽明亮。'],
      bathroom: ['六角磚或花磚地坪增添趣味，搭配木質浴櫃。'],
      study: ['開放層架與洞洞板收納，兼具展示與生活感。'],
    },
  },
  {
    id: 'japandi',
    name: '日系無印風',
    en: 'Japanese Muji',
    features: '平靜配色、生活秩序與簡潔家具，強調空間流動。',
    colors: '木色、米白與自然織品。',
    suits: '小坪數、希望營造無壓與療癒氛圍的住宅。',
    swatches: ['#efe7da', '#ddc9ab', '#c9b79a', '#e9e2d4', '#9b8a74', '#6d7a5e'],
    materials: {
      floor: { default: 'wood_ash', kitchen: 'tile_beige', bathroom: 'tile_bath', balcony: 'tile_bath', entry: 'tile_beige', study: 'wood_ash' },
      wall: { default: 'paint_warm', bathroom: 'tile_beige' },
      accent: { tvWall: 'wood_panel', bedHead: 'wood_panel' },
    },
    palette: {
      fabric: '#d9cfbf', fabric2: '#efe9dd', wood: '#d2b48c', wood2: '#a98a63', metal: '#7d7466',
      stone: '#e9e2d4', lacquer: '#f3efe6', accent: '#7d8b6a', rug: '#d8ccb6', leaf: '#6d8a5a', ceramic: '#f7f6f2',
      legs: 'wood', soft: 4, low: true,
    },
    prefs: { sofa: 'sofa3', dining: 'dining_table', bed: 'bed_queen', storageWall: 'bookshelf', curtains: true, plants: 1, artwork: false, pendant: 'pendant_paper', lightTemp: 3000 },
    tips: {
      general: ['家具選低矮、圓角、原木色，降低視覺壓迫，讓空間「流動」。', '收納以「藏八露二」為原則：大部分收進櫃體，只展示少量生活物件。', '照明以暖色 3000K 為主，搭配和紙燈或棉麻燈罩。'],
      living: ['可省略電視牆，改以木格柵或層架作為立面主角。', '沙發選亞麻或棉麻布料，搭配蒲團或矮凳。'],
      dining: ['實木餐桌搭配溫莎椅或板凳，桌面保持淨空。'],
      master: ['床架選低床或架高地板，床頭以木作格柵營造溫潤感。'],
      bedroom: ['衣櫃門片用木紋或米白，與牆色融為一體。'],
      kitchen: ['檯面保持乾淨，器具收進下櫃；開放層架放少量常用器皿。'],
      bathroom: ['米色石紋磚配木質浴櫃，加上棉麻毛巾即有溫泉旅宿感。'],
      study: ['和室或架高地板可兼做客房，書桌靠窗擺放。'],
    },
  },
  {
    id: 'wabisabi',
    name: '侘寂風',
    en: 'Wabi-Sabi',
    features: '大量留白、自然紋理與不過度修飾的原始美感。',
    colors: '米灰、低彩度大地色、特殊塗料（如微水泥）。',
    suits: '追求沉靜、慢步調氛圍的空間。',
    swatches: ['#c8c0b4', '#ddd3c4', '#8a857e', '#7a5c45', '#d9c9ad', '#ece6db'],
    materials: {
      floor: { default: 'microcement', bedroom: 'wood_smoked', master: 'wood_smoked', bathroom: 'microcement', kitchen: 'microcement', balcony: 'microcement' },
      wall: { default: 'limewash', bathroom: 'microcement' },
      accent: { tvWall: 'microcement_dark', bedHead: 'travertine' },
    },
    palette: {
      fabric: '#e6dfd3', fabric2: '#c8bba6', wood: '#7a5c45', wood2: '#5b4334', metal: '#5a5650',
      stone: '#d9c9ad', lacquer: '#ddd5c8', accent: '#9b7e5f', rug: '#cfc3b0', leaf: '#7b7a5a', ceramic: '#eee9e0',
      legs: 'plinth', soft: 8, low: true, fabricKind: 'boucle',
    },
    prefs: { sofa: 'sofa_curve', dining: 'dining_round', bed: 'bed_queen', storageWall: null, curtains: true, plants: 1, artwork: false, pendant: 'pendant_paper', lightTemp: 2700, plantKind: 'plant_branch' },
    tips: {
      general: ['大量留白：家具數量精簡，讓牆面與光影成為主角。', '使用微水泥、礦物塗料、洞石等帶有手作痕跡的材質。', '色彩控制在米灰、大地色之間，彩度越低越沉靜。'],
      living: ['圓弧沙發或泰迪絨（Bouclé）沙發，搭配洞石或原木實心茶几。', '以枯枝、陶器取代鮮豔植栽，呈現「不完美之美」。'],
      dining: ['圓形實木餐桌搭配粗獷木椅，上方懸吊和紙燈或手作陶燈。'],
      master: ['床頭以洞石或礦物塗料做出自然紋理，寢具選麻、棉等天然材質。'],
      bedroom: ['燈光以低位間接照明為主，營造慢步調氛圍。'],
      kitchen: ['微水泥檯面與門板一體成形，減少分割線。'],
      bathroom: ['微水泥無縫壁地，搭配石材檯面盆與黃銅龍頭。'],
      study: ['以實木厚板書桌為主角，牆面保持留白。'],
    },
  },
  {
    id: 'luxury',
    name: '輕奢風',
    en: 'Modern Luxury',
    features: '以簡潔底色搭配少量精緻細節，形成視覺焦點。',
    colors: '柔和底色、石紋、金屬線條與精緻織品。',
    suits: '中大型坪數或想局部營造質感的高級感住宅。',
    swatches: ['#d9cfc2', '#f1efeb', '#c5a46d', '#2f3d52', '#6e4c33', '#2b2b2d'],
    materials: {
      floor: { default: 'marble_white', bedroom: 'herringbone', master: 'herringbone', study: 'herringbone', kitchen: 'tile_white', bathroom: 'marble_white', balcony: 'tile_bath' },
      wall: { default: 'paint_greige', bathroom: 'marble_white' },
      accent: { tvWall: 'marble_dark', bedHead: 'wallpaper_stripe' },
    },
    palette: {
      fabric: '#8f8173', fabric2: '#2f3d52', wood: '#6e4c33', wood2: '#3b2a1f', metal: '#c5a46d',
      stone: '#f1efeb', lacquer: '#ece6dc', accent: '#c5a46d', rug: '#bfb3a3', leaf: '#4c7046', ceramic: '#ffffff',
      legs: 'gold', soft: 2, fabricKind: 'velvet',
    },
    prefs: { sofa: 'sofa_l', dining: 'dining_table', bed: 'bed_double', storageWall: 'display_cabinet', curtains: true, plants: 1, artwork: true, pendant: 'chandelier', lightTemp: 3000, armchair: true },
    tips: {
      general: ['以奶茶灰、米白等柔和底色打底，再以「少量」金屬線條與石紋聚焦。', '金屬元素集中在燈具、家具腳、把手與鑲嵌線條，避免全面使用。', '織品選絲絨、緞面等有光澤的材質提升精緻度。'],
      living: ['電視牆以黑金或白色大理石紋搭配金屬嵌條，形成空間主視覺。', '絲絨沙發搭配金屬腳茶几，地毯選短毛有光澤款。'],
      dining: ['餐桌上方使用水晶或金屬造型吊燈，搭配大理石桌面。'],
      master: ['床頭繃布或壁紙加金屬框線，搭配對稱的床頭櫃與檯燈。'],
      bedroom: ['窗簾選雙層（紗簾 + 遮光絨布），落地拖地更顯大器。'],
      kitchen: ['白色亮面或木紋門板配金色把手，檯面使用石紋石英石。'],
      bathroom: ['大理石紋壁地磚，搭配金色五金與鏡櫃燈光。'],
      study: ['深色木皮書櫃搭配展示層板與層板燈。'],
    },
  },
];

export const STYLE_MAP = Object.fromEntries(STYLES.map((s) => [s.id, s]));

// 尚未套用風格時的預設配色
export const DEFAULT_PALETTE = {
  fabric: '#9aa0a6', fabric2: '#d8d2c8', wood: '#b08a64', wood2: '#6b4f3a', metal: '#2b2b2b',
  stone: '#e3e0da', lacquer: '#f2f0ec', accent: '#c48a3f', rug: '#cfc6b8', leaf: '#5c8a4a', ceramic: '#f7f7f5',
  legs: 'wood', soft: 2,
};

export function paletteFor(styleId) {
  const s = STYLE_MAP[styleId];
  return { ...DEFAULT_PALETTE, ...(s ? s.palette : {}) };
}
