// 動線與尺寸健檢面板（使用共用的檢查面板）
import { CheckPanel } from './check-panel.js';
import { checkClearance, CHECKS } from '../editor/clearance.js';

export class ClearancePanel extends CheckPanel {
  constructor(app) {
    super(app, {
      el: '#clPanel', btn: '#clBtn', title: '⇆ 動線與尺寸健檢', check: checkClearance, checks: CHECKS, fixLabel: '建議',
      empty: '動線與使用空間都符合建議尺寸',
      note: '依常見的人體工學尺寸判斷（主要動線 80 到 90 公分、次要通道 60 公分、櫃前 70 公分等），以平面圖上的家具外框計算。',
    });
  }
}
