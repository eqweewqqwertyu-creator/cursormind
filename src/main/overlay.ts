import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import type { SpriteCommand } from '../shared/types';

let win: BrowserWindow | null = null;

/**
 * 创建覆盖层窗口：透明、置顶、无边框、点击穿透、不抢焦点。
 * 参考 MudrikNow 的透明置顶 overlay，但用更轻的自实现。
 */
export function createOverlay(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width, height, x, y } = display.bounds;

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });

  // 开发期直接加载源码目录里的 renderer（不参与 tsc 编译）
  const rendererHtml = path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');
  win.loadFile(rendererHtml);

  win.on('closed', () => {
    win = null;
  });

  return win;
}

/** 切换点击穿透（圈选时临时关闭） */
export function setClickThrough(through: boolean): void {
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(through, { forward: true });
  }
}

/** 向渲染进程下发精灵指令 */
export function sendCommand(cmd: SpriteCommand): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('sprite:command', cmd);
  }
}

export function getOverlay(): BrowserWindow | null {
  return win;
}
