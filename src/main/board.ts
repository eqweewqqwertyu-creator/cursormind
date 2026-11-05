/**
 * 灵标看板（Board）：独立透明圆角便签窗口。
 *
 * 能力：
 *  - 待办 + 可选提醒时间，到点弹系统通知（用户确认：仅系统通知，不语音）
 *  - 便签贴条样式展示（渲染层 board.html）
 *  - 拖拽自由移动；松手：拖到左/右缘 → 吸附窄条停靠；拖出屏幕顶 → 关闭
 *  - 停靠低干扰：窄条 + 不置顶（不遮挡正常窗口），点窄条才展开置顶
 *
 * 数据持久化：userData/boardData.json（JSON 数组，临时文件 + rename 原子写）
 * 提醒调度：主进程 5s 轮询到期任务 → 系统通知（Set<id> 记已通知，防重复）
 */
import { app, BrowserWindow, ipcMain, Notification, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const logFile = path.join(__dirname, '..', '..', '.temp', 'hotkey.log');
function boardLog(msg: string): void {
  try { fs.appendFileSync(logFile, '[board] ' + msg + '\n'); } catch { /* 忽略 */ }
}

// ---------- 尺寸 ----------
const FULL_W = 340;
const FULL_H = 420;
const DOCK_W = 24;        // 停靠窄条宽（细条把手：低干扰）
const DOCK_H = 120;       // 停靠窄条高（挂起只占一小块，不再整条 420 高）
const EDGE_MARGIN = 40;   // 距左/右缘小于此值 → 吸附
const TOP_CLOSE_PAD = 24; // 窗口顶拖出屏幕顶超过此值 → 上滑关闭

export interface BoardTask {
  id: string;
  text: string;
  /** epoch ms；null = 无提醒 */
  remindAt: number | null;
  done: boolean;
  createdAt: number;
}

let win: BrowserWindow | null = null;
let tasks: BoardTask[] = [];
let dockSide: 'left' | 'right' | null = null;
let remindTimer: NodeJS.Timeout | null = null;
let ipcInited = false;
const firedIds = new Set<string>(); // 已通知的任务 id（防重复提醒）

// ---------- 持久化 ----------
function dataFile(): string {
  return path.join(app.getPath('userData'), 'boardData.json');
}

function loadTasks(): void {
  try {
    const p = dataFile();
    if (!fs.existsSync(p)) { tasks = []; return; }
    const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
    tasks = Array.isArray(arr) ? arr.filter((t: BoardTask) => t && typeof t.text === 'string') : [];
  } catch { tasks = []; }
}

function saveTasks(): void {
  try {
    const p = dataFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf-8');
    fs.renameSync(tmp, p); // 原子写，避免写一半损坏
  } catch { /* 保存失败静默 */ }
}

// ---------- 窗口 ----------
export function createBoard(): void {
  if (win && !win.isDestroyed()) return;
  loadTasks();

  const disp = screen.getPrimaryDisplay();
  const right = disp.bounds.x + disp.bounds.width;
  const y = Math.round(disp.bounds.y + (disp.bounds.height - FULL_H) / 3);

  win = new BrowserWindow({
    width: FULL_W,
    height: FULL_H,
    x: right - FULL_W - 12,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // 注意：透明窗口不能用 setContentProtection —— DWM 会丢弃合成导致不显示
  win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'board.html'));

  win.on('closed', () => { win = null; });
  initBoardIpc();
}

// ---------- IPC ----------
function boardSend(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

export function initBoardIpc(): void {
  if (ipcInited) return;
  ipcInited = true;
  // 渲染层初始化拉数据
  ipcMain.on('board:load', () => {
    boardSend('board:data', tasks);
  });
  // 渲染层全量保存（渲染层是唯一编辑者，主进程只持久化 + 调度提醒）
  ipcMain.on('board:save', (_e, data: unknown) => {
    if (Array.isArray(data)) {
      tasks = data.filter((t): t is BoardTask => t && typeof (t as BoardTask).text === 'string');
      saveTasks();
      boardSend('board:synced', tasks);
    }
  });
  // 拖拽移动：按光标位置 - offset 定位窗口
  ipcMain.on('board:drag', (_e, offset: unknown) => {
    if (!win || win.isDestroyed()) return;
    const o = (offset || {}) as { x?: number; y?: number };
    const p = screen.getCursorScreenPoint();
    win.setPosition(
      Math.round(p.x - (typeof o.x === 'number' ? o.x : 0)),
      Math.round(p.y - (typeof o.y === 'number' ? o.y : 0))
    );
  });
  // 拖拽松手：吸附 / 上滑关闭判定
  ipcMain.on('board:drop', () => handleDrop());
  // 点窄条 / 拖拽结束不吸附 → 展开
  ipcMain.on('board:expand', () => setExpanded(true));
  // 收起按钮 → 收窄停靠最近边缘
  ipcMain.on('board:collapse', () => setCollapsed());
  // 隐藏（点击关闭按钮）
  ipcMain.on('board:hide', () => hideBoard());
}

/** 松手判定：上滑关闭 → 贴边吸附 → 自由展开 */
function handleDrop(): void {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const disp = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw } = disp.bounds;

  if (b.y <= dy - TOP_CLOSE_PAD) { hideBoard(); return; } // 上滑关闭

  const nearLeft = b.x - dx <= EDGE_MARGIN;
  const nearRight = dx + dw - (b.x + b.width) <= EDGE_MARGIN;
  if (nearLeft) { dock('left'); return; }
  if (nearRight) { dock('right'); return; }
  setExpanded(true); // 自由停靠，展开完整
}

/** 吸附：收成小把手 + 贴边 + 侧边垂直居中 + 不置顶（低干扰不遮挡） */
function dock(side: 'left' | 'right'): void {
  if (!win || win.isDestroyed()) return;
  const disp = screen.getPrimaryDisplay();
  const b = win.getBounds();
  const x = side === 'left' ? disp.bounds.x : disp.bounds.x + disp.bounds.width - DOCK_W;
  const y = Math.round(disp.bounds.y + (disp.bounds.height - DOCK_H) / 2); // 侧边垂直居中
  win.setBounds({ x, y, width: DOCK_W, height: DOCK_H }, false);
  win.setAlwaysOnTop(false);
  dockSide = side;
  boardSend('board:state', { docked: true, expanded: false });
}

/** 展开完整看板（置顶） */
function setExpanded(en: boolean): void {
  if (!win || win.isDestroyed()) return;
  const disp = screen.getPrimaryDisplay();
  const b = win.getBounds();
  if (en) {
    let x = b.x;
    if (dockSide === 'left') x = disp.bounds.x;
    else if (dockSide === 'right') x = disp.bounds.x + disp.bounds.width - FULL_W;
    // 展开时保持 y 在屏幕内（DOCK 态是居中 y，展开高度更大需 clamp）
    let y = b.y;
    const minY = disp.bounds.y;
    const maxY = disp.bounds.y + disp.bounds.height - FULL_H;
    if (y < minY) y = minY;
    if (y > maxY) y = maxY;
    win.setBounds({ x, y, width: FULL_W, height: FULL_H }, false);
    win.setAlwaysOnTop(true, 'screen-saver');
    dockSide = null;
  }
  boardSend('board:state', { docked: false, expanded: en });
}

function setCollapsed(): void {
  if (!win || win.isDestroyed()) return;
  const disp = screen.getPrimaryDisplay();
  const b = win.getBounds();
  const side = b.x + b.width / 2 < disp.bounds.x + disp.bounds.width / 2 ? 'left' : 'right';
  dock(side);
}

/** 隐藏（任务保留；热键/托盘再唤起） */
export function hideBoard(): void {
  if (win && !win.isDestroyed()) {
    win.hide();
    win.setAlwaysOnTop(false);
    dockSide = null;
  }
}

/** 唤起看板：hidden→显示并展开；展开→收起窄条；窄条→展开 */
export function toggleBoard(): void {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {
    win.show();
    setExpanded(true);
    return;
  }
  const b = win.getBounds();
  if (b.width >= FULL_W - 50) setCollapsed();
  else setExpanded(true);
}

export function showBoard(): void {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) { win.show(); }
  setExpanded(true);
}

// ---------- 提醒调度 ----------
function fireDue(): void {
  if (!tasks.length) return;
  const now = Date.now();
  for (const t of tasks) {
    if (t.remindAt && !t.done && t.remindAt <= now && !firedIds.has(t.id)) {
      firedIds.add(t.id);
      boardLog('提醒到期: ' + t.text);
      notify(t.text);
    }
  }
}

function notify(text: string): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title: '灵标便签提醒', body: text }).show();
    }
  } catch { /* 通知失败静默 */ }
}

// ---------- 生命周期 ----------
export function destroyBoard(): void {
  if (remindTimer) { clearInterval(remindTimer); remindTimer = null; }
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

/** 启动提醒轮询（app ready 后调用） */
export function startBoardReminderLoop(): void {
  if (remindTimer) return;
  remindTimer = setInterval(fireDue, 5000);
}