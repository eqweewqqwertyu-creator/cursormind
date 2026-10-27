import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';

let panel: BrowserWindow | null = null;
/** 退场中标志：cancel 后到达的迟到回复不再拉回窗口（白条 bug 根治） */
let dismissed = false;

const PANEL_W = 620;
const PANEL_H = 430;

/**
 * 提问/设置面板：大透明窗口，默认只显示底部两个圆钮（dock），
 * 点击圆钮后在渲染层做 fluid morph 展开成面板。
 * 透明区域通过 setIgnoreMouseEvents(true, {forward:true}) 穿透，
 * 渲染层 mousemove 检测命中 .hit 元素时经 IPC 关闭穿透。
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

  panel.on('closed', () => {
    panel = null;
  });

  // 推送模型配置状态（设置面板显示用）
  panel.webContents.once('did-finish-load', () => {
    sendMeta();
  });

  return panel;
}

function sendMeta(): void {
  if (!panel || panel.isDestroyed()) return;
  panel.webContents.send('panel:meta', JSON.stringify({
    brain: !!process.env.DEEPSEEK_API_KEY,
    eye: !!process.env.QWEN_API_KEY,
  }));
}

/** 收起隐藏的竞态令牌：collapse 后 420ms 内被重新 show/回复到达则取消隐藏 */
let collapseToken = 0;
function cancelPendingHide(): void {
  collapseToken++;
}

/** 显示面板（dock 形态：两个圆钮） */
export function showPanel(): void {
  dismissed = false;
  cancelPendingHide();
  if (!panel) createPanel();
  if (!panel || panel.isDestroyed()) return;
  if (!panel.isVisible()) panel.show();
  panel.webContents.send('panel:open');
  sendMeta();
}

/** 长按 ~ ：召唤直达打字（显示窗口 + 直接展开提问输入框并聚焦） */
export function openSearchPanel(): void {
  dismissed = false;
  cancelPendingHide();
  if (!panel) createPanel();
  if (!panel || panel.isDestroyed()) return;
  if (!panel.isVisible()) panel.show();
  panel.webContents.send('panel:search');
  sendMeta();
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
  if (!panel.isVisible()) panel.show();
  panel.webContents.send('panel:reply', text);
}

export function getPanel(): BrowserWindow | null {
  return panel;
}
