// 範例平面圖
import { uid } from '../core/geometry.js';

function build({ name, walls, openings, rooms }) {
  const W = walls.map(([x1, y1, x2, y2, t]) => ({ id: uid('w'), x1, y1, x2, y2, thickness: t, height: 280, matA: 'paint_white', matB: 'paint_white' }));
  const O = openings.map(([wi, kind, offset, width, height, sill, flipH = false, flipV = false]) => ({ id: uid('o'), kind, wallId: W[wi].id, offset, width, height, sill, flipH, flipV }));
  const R = rooms.map(([nm, type, pts, floor]) => ({ id: uid('r'), name: nm, type, points: pts, floor: floor || 'wood_oak', ceiling: true }));
  return {
    version: 1, name,
    settings: { wallHeight: 280, wallThickness: 12, snap: true, grid: true, showCeiling: false, night: false },
    walls: W, openings: O, rooms: R, items: [], dims: [], background: null, design: { styleId: null, report: null },
  };
}

export const SAMPLES = [
  {
    id: 'three-bed',
    name: '三房兩廳（約 33 坪）',
    make: () => build({
      name: '三房兩廳範例',
      walls: [
        [0, 0, 1200, 0, 20], // 0 北外牆
        [1200, 0, 1200, 900, 20], // 1 東外牆
        [1200, 900, 0, 900, 20], // 2 南外牆
        [0, 900, 0, 0, 20], // 3 西外牆
        [400, 0, 400, 400, 12], // 4 主臥/客廳
        [0, 400, 400, 400, 12], // 5 主臥南牆
        [0, 560, 1200, 560, 12], // 6 中央隔間
        [250, 400, 250, 560, 12], // 7 浴室東牆
        [400, 560, 400, 900, 12], // 8 次臥/書房
        [900, 560, 900, 900, 12], // 9 書房/廚房
      ],
      openings: [
        [1, 'door_entry', 150, 105, 215, 0],
        [5, 'door_single', 325, 85, 210, 0, false, true],
        [7, 'door_single', 80, 75, 210, 0, false, false],
        [6, 'door_single', 325, 85, 210, 0, true, false],
        [6, 'door_single', 480, 85, 210, 0, false, false],
        [6, 'door_sliding', 1050, 160, 220, 0],
        [0, 'window_std', 200, 180, 130, 90],
        [0, 'window_french', 800, 300, 230, 0],
        [2, 'window_std', 1000, 160, 130, 90],
        [2, 'window_wide', 550, 200, 130, 85],
        [1, 'window_std', 730, 120, 120, 100],
        [3, 'window_high', 420, 60, 50, 170],
      ],
      rooms: [
        ['主臥室', 'master', [[0, 0], [400, 0], [400, 400], [0, 400]]],
        ['客餐廳', 'living', [[400, 0], [1200, 0], [1200, 560], [400, 560]]],
        ['走道', 'hall', [[250, 400], [400, 400], [400, 560], [250, 560]]],
        ['浴室', 'bathroom', [[0, 400], [250, 400], [250, 560], [0, 560]], 'tile_bath'],
        ['次臥室', 'bedroom', [[0, 560], [400, 560], [400, 900], [0, 900]]],
        ['書房', 'study', [[400, 560], [900, 560], [900, 900], [400, 900]]],
        ['廚房', 'kitchen', [[900, 560], [1200, 560], [1200, 900], [900, 900]], 'tile_white'],
      ],
    }),
  },
  {
    id: 'studio',
    name: '一房一廳（約 15 坪）',
    make: () => build({
      name: '一房一廳範例',
      walls: [
        [0, 0, 800, 0, 20], // 0
        [800, 0, 800, 600, 20], // 1
        [800, 600, 0, 600, 20], // 2
        [0, 600, 0, 0, 20], // 3
        [350, 0, 350, 600, 12], // 4
        [0, 380, 350, 380, 12], // 5
        [200, 380, 200, 600, 12], // 6
      ],
      openings: [
        [1, 'door_entry', 480, 100, 215, 0],
        [4, 'door_single', 300, 85, 210, 0],
        [5, 'door_single', 100, 75, 210, 0, false, false],
        [4, 'door_sliding', 490, 120, 220, 0],
        [0, 'window_std', 175, 160, 130, 90],
        [0, 'window_french', 575, 240, 230, 0],
        [3, 'window_high', 110, 60, 50, 170],
        [2, 'window_std', 525, 100, 100, 110],
      ],
      rooms: [
        ['臥室', 'master', [[0, 0], [350, 0], [350, 380], [0, 380]]],
        ['客餐廳', 'living', [[350, 0], [800, 0], [800, 600], [350, 600]]],
        ['浴室', 'bathroom', [[0, 380], [200, 380], [200, 600], [0, 600]], 'tile_bath'],
        ['廚房', 'kitchen', [[200, 380], [350, 380], [350, 600], [200, 600]], 'tile_white'],
      ],
    }),
  },
];
