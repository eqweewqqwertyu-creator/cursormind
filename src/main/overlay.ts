import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import type { SpriteCommand } from '../shared/types';

let win: BrowserWindow | null = null;
let cursorTimer: NodeJS.Timeout | null = null;

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
  // 注意：透明窗口不能用 setContentProtection/WDA —— DWM 会直接丢弃合成，窗口彻底不显示

  // 开发期直接加载源码目录里的 renderer（不参与 tsc 编译）
  const rendererHtml = path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');
  win.loadFile(rendererHtml);

  // 高频轮询全局鼠标位置，推给渲染层做惯性跟随（窗口点击穿透，收不到可靠的 mousemove）
  startCursorPolling();

  win.on('closed', () => {
    win = null;
    stopCursorPolling();
  });

  return win;
}

/** 全局鼠标位置轮询（约 60Hz），坐标 = DIP（与窗口坐标一致） */
function startCursorPolling(): void {
  stopCursorPolling();
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    try {
      const p = screen.getCursorScreenPoint();
      win.webContents.send('cursor', { x: p.x, y: p.y });
    } catch {
      // 忽略瞬时错误，下一拍重试
    }
  }, 16);
}

function stopCursorPolling(): void {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
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
