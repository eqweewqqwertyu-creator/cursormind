/**
 * 托盘：任务栏状态区常驻入口 + 运行状态暗示。
 * idle：白玻璃球静默；busy（AI 思考/识别/优化中）：橙色进度弧旋转 + tooltip 变化。
 * 左键 = 召唤精灵；右键 = 菜单（召唤/新对话/自检/退出）。
 */
import { app, Menu, nativeImage, Tray } from 'electron';
import { renderFramePng } from './trayicon';

/** Windows 常见 DPI 档，全部点对点出图（托盘逻辑尺寸 16px） */
const SCALES = [1, 1.25, 1.5, 2];
const BUSY_FRAMES = [0, 1, 2, 3] as const;
const BUSY_MS = 140;

export interface TrayCallbacks {
  onSummon: () => void;
  onNewChat: () => void;
  onDemo: () => void;
  onSettings: () => void;
  onQuit: () => void;
}

let tray: Tray | null = null;
let idleImg: Electron.NativeImage;
let busyImgs: Electron.NativeImage[] = [];
let busyCount = 0; // 并发链路计数（agent / asr / textops 可能同时跑）
let busyLabel = '';
let timer: NodeJS.Timeout | null = null;
let frame = 0;

function makeImage(kind: 0 | 1 | 2 | 3 | 'idle'): Electron.NativeImage {
  const img = nativeImage.createEmpty();
  for (const s of SCALES) {
    const size = Math.round(16 * s);
    img.addRepresentation({
      scaleFactor: s,
      width: size,
      height: size,
      buffer: renderFramePng(kind, size),
    });
  }
  return img;
}

function applyState(): void {
  if (!tray) return;
  if (busyCount > 0) {
    if (!timer) {
      frame = 0;
      tray.setImage(busyImgs[0]);
      timer = setInterval(() => {
        if (!tray) return;
        frame = (frame + 1) % BUSY_FRAMES.length;
        tray.setImage(busyImgs[frame]);
      }, BUSY_MS);
    }
    tray.setToolTip('灵标 CursorMind · ' + (busyLabel || '正在思考') + '…');
  } else {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    tray.setImage(idleImg);
    tray.setToolTip('灵标 CursorMind · 待命中');
  }
}

/** 置忙/解除（可并发；label 是本次忙态的 tooltip 副文案，如"正在优化文字"） */
export function setTrayBusy(on: boolean, label?: string): void {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  if (on && label) busyLabel = label;
  if (busyCount === 0) busyLabel = '';
  applyState();
}

export function initTray(cb: TrayCallbacks): void {
  if (tray) return;
  idleImg = makeImage('idle');
  busyImgs = BUSY_FRAMES.map((f) => makeImage(f));
  tray = new Tray(idleImg);
  tray.setToolTip('灵标 CursorMind · 待命中');
  // 左键直接召唤；右键弹菜单（不 setContextMenu，否则左键也会弹菜单）
  tray.on('click', () => cb.onSummon());
  tray.on('right-click', () => {
    if (!tray) return;
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: '召唤灵标', click: () => cb.onSummon() },
        { label: '新对话', click: () => cb.onNewChat() },
        { label: '自检演示', click: () => cb.onDemo() },
        { label: '设置…', click: () => cb.onSettings() },
        { type: 'separator' },
        { label: '退出', click: () => cb.onQuit() },
      ]),
    );
  });
}

export function destroyTray(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

// 进程退出兜底清理
app.on('will-quit', () => destroyTray());
