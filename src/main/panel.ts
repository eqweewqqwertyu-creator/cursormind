import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

let panel: BrowserWindow | null = null;

/** 创建提问输入面板（可聚焦、无边框、置顶） */
export function createPanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel;

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const panelW = 520;
  const panelH = 92;

  panel = new BrowserWindow({
    width: panelW,
    height: panelH,
    x: Math.round((width - panelW) / 2),
    y: Math.round(height - panelH - 130),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
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
  panel.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'panel.html'));
  panel.on('closed', () => {
    panel = null;
  });

  return panel;
}

/** 显示面板并聚焦输入框 */
export function showPanel(): void {
  if (!panel) createPanel();
  if (!panel || panel.isDestroyed()) return;
  panel.show();
  panel.focus();
  panel.webContents.send('panel:open');
}

export function hidePanel(): void {
  if (panel && !panel.isDestroyed()) panel.hide();
}

/** 显示长回答（面板展开为"回复条 + 输入框"） */
export function showReply(text: string): void {
  if (!panel || panel.isDestroyed()) return;
  if (!panel.isVisible()) panel.show();
  panel.webContents.send('panel:reply', text);
}

/** 面板收起回复条，回到纯输入框 */
export function collapseReply(): void {
  if (!panel || panel.isDestroyed()) return;
  panel.webContents.send('panel:reply', '');
}

export function getPanel(): BrowserWindow | null {
  return panel;
}
