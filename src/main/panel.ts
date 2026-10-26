import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';

let panel: BrowserWindow | null = null;

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

/** 显示面板（dock 形态：两个圆钮） */
export function showPanel(): void {
  if (!panel) createPanel();
  if (!panel || panel.isDestroyed()) return;
  if (!panel.isVisible()) panel.show();
  panel.webContents.send('panel:open');
  sendMeta();
}

/** morph 收起到 dock（不隐藏窗口）：提交问题后调用 */
export function collapsePanel(): void {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('panel:collapse');
  }
}

export function hidePanel(): void {
  if (panel && !panel.isDestroyed()) panel.hide();
}

/** 显示长回答（morph 展开为"回复条 + 输入框"） */
export function showReply(text: string): void {
  if (!panel || panel.isDestroyed()) return;
  if (!panel.isVisible()) panel.show();
  panel.webContents.send('panel:reply', text);
}

export function getPanel(): BrowserWindow | null {
  return panel;
}
