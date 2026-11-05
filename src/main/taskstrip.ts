/**
 * 后台任务条（TaskStrip）：屏幕右上角的小提示窗口。
 *
 * 形态（同一块玻璃设计语言）：
 *  - 紧凑胶囊（默认）：橙点脉冲 + 「后台 N · 任务名」，点击展开
 *  - 展开列表：任务卡片（状态点/标题/步骤/耗时/token）+ 取消/看结果/删除
 *
 * 低干扰原则：
 *  - 无任务时窗口隐藏，有任务才出现；showInactive 不抢焦点
 *  - 位置固定屏幕右上角，不遮挡常规工作区；置顶（screen-saver）
 *
 * 数据流：dshRunner 是任务 source of truth，每次状态变化调 syncTaskstrip() 推
 * 全量视图；taskstrip 只读展示 + 回调上抛用户操作（cancel/view/remove/clear），
 * 通过 setTaskstripHandlers 注入，避免与 dshRunner 循环依赖。
 */
import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';
import type { BgTaskView } from './dshRunner';

// ---------- 尺寸 ----------
const COMPACT_W = 250;
const COMPACT_H = 46;
const LIST_W = 330;
const LIST_H = 430;
const EDGE_PAD = 12; // 距屏幕右/上缘

export interface TaskstripHandlers {
  onCancel(id: string): void;
  onView(id: string): void;
  onRemove(id: string): void;
  onClearDone(): void;
}

let win: BrowserWindow | null = null;
let expanded = false;
let handlers: TaskstripHandlers | null = null;
let ipcInited = false;
let lastViews: BgTaskView[] = [];

/** 右上角锚点定位，按当前形态返回窗口位置 */
function anchorBounds(): { x: number; y: number; width: number; height: number } {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = expanded ? LIST_W : COMPACT_W;
  const h = expanded ? LIST_H : COMPACT_H;
  return { x: wa.x + wa.width - w - EDGE_PAD, y: wa.y + EDGE_PAD, width: w, height: h };
}

function applyBounds(): void {
  if (!win || win.isDestroyed()) return;
  win.setBounds(anchorBounds(), false);
}

export function createTaskStrip(): void {
  if (win && !win.isDestroyed()) return;

  win = new BrowserWindow({
    ...anchorBounds(),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: true, // 按钮点击需要可交互
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // 注意：透明窗口不能用 setContentProtection/WDA —— DWM 会丢弃合成导致不显示
  win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'taskstrip.html'));
  win.on('closed', () => { win = null; });
  initTaskstripIpc();
}

function initTaskstripIpc(): void {
  if (ipcInited) return;
  ipcInited = true;
  // 渲染层初始化拉数据
  ipcMain.on('taskstrip:load', () => pushData());
  // 紧凑 ⇄ 展开
  ipcMain.on('taskstrip:expand', () => {
    expanded = !expanded;
    applyBounds();
    pushData();
  });
  // 用户操作上抛（index.ts 注入 handlers 接到 dshRunner）
  ipcMain.on('taskstrip:cancel', (_e, id: unknown) => {
    if (handlers) handlers.onCancel(String(id || ''));
  });
  ipcMain.on('taskstrip:view', (_e, id: unknown) => {
    if (handlers) handlers.onView(String(id || ''));
  });
  ipcMain.on('taskstrip:remove', (_e, id: unknown) => {
    if (handlers) handlers.onRemove(String(id || ''));
  });
  ipcMain.on('taskstrip:clear-done', () => {
    if (handlers) handlers.onClearDone();
  });
}

function pushData(): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('taskstrip:data', JSON.stringify(lastViews), JSON.stringify(expanded));
  }
}

/** 注入用户操作回调（index.ts 调；接 dshRunner 的任务管理函数） */
export function setTaskstripHandlers(h: TaskstripHandlers): void {
  handlers = h;
}

/** dshRunner 每次任务状态变化调用：推全量视图；无任务隐藏窗口 */
export function syncTaskstrip(views: BgTaskView[]): void {
  lastViews = views;
  if (!win || win.isDestroyed()) return;
  if (views.length === 0) {
    if (win.isVisible()) win.hide();
    if (expanded) expanded = false;
    return;
  }
  if (!win.isVisible()) {
    win.setBounds(anchorBounds(), false);
    win.showInactive(); // 不抢焦点：用户正在打字时任务完成不打断输入
  }
  pushData();
}

/** 托盘菜单「后台任务」入口：唤起并展开列表 */
export function showTaskStrip(): void {
  if (!win || win.isDestroyed()) return;
  expanded = true;
  if (!win.isVisible()) win.setBounds(anchorBounds(), false);
  win.showInactive();
  pushData();
}

export function destroyTaskStrip(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
