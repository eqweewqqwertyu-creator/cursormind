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

  // 顶部白条修复（真因：Win11 给透明无边框窗口绘制的 DWM 装饰带——半透明白、横贯全屏、
  // 左上角带窗口标题文字"cursorMind overlay"，非页面内容）：
  //   roundedCorners: false  → 关掉 Win11 DWM 装饰（含那条带标题的 caption band），根治
  //   backgroundColor 透明   → 兜底：不给 DWM 留默认白底
  //   顶部 1px 内缩          → 上一轮的边缘线保险，无害保留
  const TOP_TRIM = 1;
  const trimY = y + TOP_TRIM;
  const trimH = Math.max(1, height - TOP_TRIM);

  win = new BrowserWindow({
    width,
    height: trimH,
    x,
    y: trimY,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: false,
    roundedCorners: false,        // Win11：关 DWM 装饰带（顶部白条+标题文字的来源）
    thickFrame: false,            // 去 WS_THICKFRAME：标题栏样式根源；点击触发 DWM 重绘后会把
                                  //   caption 标题栏画出来（"点一下鼠标白条出现"的真因），去掉即无 caption 可绘
    backgroundColor: '#00000000', // 显式透明底色，兜底默认白底残留
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

/** 球可见性（设置面板「灵标球」开关）：隐藏时球 DOM display:none，语音/指路/优化链路全保留 */
let orbVisible = true;
export function setOrbVisible(v: boolean): void {
  orbVisible = !!v;
  sendCommand({ type: 'setOrbVisible', visible: orbVisible });
}
export function isOrbVisible(): boolean {
  return orbVisible;
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
