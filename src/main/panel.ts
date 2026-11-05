import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';
import { isVoiceOn } from './tts';
import { isAutoReplace } from './textops';
import { isOrbVisible } from './overlay';
import { captureScreen } from './screenshot';

let panel: BrowserWindow | null = null;
/** 退场中标志：cancel 后到达的迟到回复不再拉回窗口（白条 bug 根治） */
let dismissed = false;

const PANEL_W = 620;
const PANEL_H = 760; // 大窗口：设置面板内容多（含 MCP 区），需要足够高才能完整展开不滚动

/**
 * 提问/设置面板：大透明窗口，平时隐藏（dock 已删，「不用时窗口不存在」），
 * 召唤/长按 ~/托盘设置时显示，面板从底部中央小圆点 fluid morph 展开。
 * 透明区域通过 setIgnoreMouseEvents(true, {forward:true}) 穿透，
 * 渲染层 mousemove 检测命中 .hit/.panel 元素时经 IPC 关闭穿透。
 */
export function createPanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel;

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  // 窗口底边离屏幕底 ~130px（与旧输入面板位置一致），向上扩展
  const x = Math.round((width - PANEL_W) / 2);
  const y = Math.max(0, height - 130 - PANEL_H);

  panel = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  panel.setAlwaysOnTop(true, 'screen-saver');
  // 默认整体穿透（dock 只占底部一小块），命中元素时渲染层会关闭穿透
  panel.setIgnoreMouseEvents(true, { forward: true });
  // 注意：透明窗口不能用 setContentProtection/WDA —— DWM 会丢弃合成导致窗口不显示

  panel.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'panel.html'));

  // 渲染层穿透切换
  ipcMain.on('panel:set-ignore', (_e, v: unknown) => {
    if (panel && !panel.isDestroyed()) {
      panel.setIgnoreMouseEvents(!!v, { forward: true });
    }
  });

  // 面板收回动画完成后：隐藏窗口（dock 已删，无常驻形态）
  ipcMain.on('panel:request-hide', () => {
    if (panel && !panel.isDestroyed()) panel.hide();
  });

  panel.on('closed', () => {
    panel = null;
  });

  // 推送模型配置状态（设置面板显示用）
  panel.webContents.once('did-finish-load', () => {
    sendMeta();
  });

  return panel;
}

import { loadHotwords } from './hotwords';

function sendMeta(): void {
  if (!panel || panel.isDestroyed()) return;
  panel.webContents.send('panel:meta', JSON.stringify({
    brain: !!process.env.DEEPSEEK_API_KEY,
    eye: !!process.env.QWEN_API_KEY,
    voice: isVoiceOn(),            // 开关真实状态同步（修复：重开后显示旧默认值）
    autoReplace: isAutoReplace(),
    orbVisible: isOrbVisible(),    // 球可见性同步（设置面板「灵标球」开关）
    hotwords: loadHotwords().join(', '), // 语音热词回显
  }));
}

/** 收起隐藏的竞态令牌：collapse 后 420ms 内被重新 show/回复到达则取消隐藏 */
let collapseToken = 0;
function cancelPendingHide(): void {
  collapseToken++;
}

/** 显示面板（召唤：直接展开搜索面板；dock 形态已删除） */
export function showPanel(): void {
  dismissed = false;
  cancelPendingHide();
  if (!panel) createPanel();
  if (!panel || panel.isDestroyed()) return;
  movePanelNearCursor(); // 提问面板从鼠标右下角展开
  if (!panel.isVisible()) panel.show();
  pushBackdrop(); // 桌面截屏推给渲染层做液态玻璃背景实层
  panel.webContents.send('panel:open');
  sendMeta();
}

/** 长按 ~ ：召唤直达打字（显示窗口 + 直接展开提问输入框并聚焦） */
export function openSearchPanel(): void {
  dismissed = false;
  cancelPendingHide();
  if (!panel) createPanel();
  if (!panel || panel.isDestroyed()) return;
  movePanelNearCursor(); // 打字区从鼠标右下角展开（不固定屏幕中间）
  if (!panel.isVisible()) panel.show();
  pushBackdrop();
  panel.webContents.send('panel:search');
  sendMeta();
}

/** 托盘右键菜单「设置」：展开设置面板（语音播报/自动替换等开关） */
export function openSettingsPanel(): void {
  dismissed = false;
  cancelPendingHide();
  if (!panel) createPanel();
  if (!panel || panel.isDestroyed()) return;
  movePanelDefault(); // 设置面板回屏幕中央（全局操作，不跟鼠标）
  if (!panel.isVisible()) panel.show();
  pushBackdrop();
  panel.webContents.send('panel:settings');
  sendMeta();
}

/** 提问/打字面板跟随鼠标：把窗口的「底部中央」（morph 起点）对准鼠标右下角偏移处，
 *  面板即从鼠标右下角长出；clamp 在工作区内避免出屏。 */
function movePanelNearCursor(): void {
  if (!panel || panel.isDestroyed()) return;
  try {
    const cursor = screen.getCursorScreenPoint();
    const [winW, winH] = panel.getSize();
    const OFF = 28; // 右下偏移：morph 小圆点出现在鼠标右下 28px 处（Gemini 式贴近）
    let x = Math.round(cursor.x + OFF - winW / 2);
    let y = Math.round(cursor.y + OFF - winH);
    const wa = screen.getPrimaryDisplay().workArea;
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - winW));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - winH));
    panel.setPosition(x, y);
  } catch { /* 定位失败不阻塞面板展开 */ }
}

/** 面板回默认位置（屏幕底部居中，与创建时一致） */
function movePanelDefault(): void {
  if (!panel || panel.isDestroyed()) return;
  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width - PANEL_W) / 2);
    const y = Math.max(0, height - 130 - PANEL_H);
    panel.setPosition(x, y);
  } catch { /* 忽略 */ }
}

/** 推送桌面截屏（面板玻璃背景实层；静默失败不阻塞面板展开） */
function pushBackdrop(): void {
  void captureScreen().then((shot) => {
    if (shot && panel && !panel.isDestroyed() && !panel.webContents.isDestroyed()) {
      panel.webContents.send('panel:backdrop', shot.dataUrl);
    }
  });
}

/** morph 收起并隐藏窗口（提交问题后调用：视线回到球，面板整体退场） */
export function collapsePanel(): void {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('panel:collapse');
    const token = ++collapseToken;
    setTimeout(() => {
      if (token !== collapseToken) return; // 期间被重新 show/回复到达 → 取消隐藏
      // 等 morph 动画（约 0.4s）结束后再隐藏窗口，避免动画中途窗口消失的生硬感
      if (panel && !panel.isDestroyed() && !panel.webContents.isDestroyed()) {
        panel.hide();
      }
    }, 420);
  }
}

export function hidePanel(): void {
  dismissed = true;
  if (panel && !panel.isDestroyed()) panel.hide();
}

/** 显示长回答：退场中（dismissed）迟到回复静默丢弃，不把窗口拉回成白条；
 *  提问后窗口已隐藏但用户在等回复 → 拉回展开 */
export function showReply(text: string): void {
  if (!panel || panel.isDestroyed() || dismissed) return;
  cancelPendingHide(); // 回复在 collapse 的 420ms 隐藏窗口内到达：取消隐藏，否则刚展开就被藏
  if (!panel.isVisible()) {
    panel.show();
    pushBackdrop();
  }
  panel.webContents.send('panel:reply', text);
}

export function getPanel(): BrowserWindow | null {
  return panel;
}
