// 風水檢查面板（使用共用的檢查面板）
import { CheckPanel } from './check-panel.js';
import { checkFengshui, CHECKS } from '../editor/fengshui.js';

export class FengshuiPanel extends CheckPanel {
  constructor(app) {
    super(app, {
      el: '#fsPanel', btn: '#fsBtn', title: '☯ 風水檢查', check: checkFengshui, checks: CHECKS, fixLabel: '化解',
      empty: '沒有發現常見的風水問題',
      note: '依台灣常見的居家風水說法，從平面圖的門窗、房間與家具位置判斷，僅供參考。',
    });
  }
}
