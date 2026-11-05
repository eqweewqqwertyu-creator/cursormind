/**
 * Win32 低级鼠标钩子（WH_MOUSE_LL，koffi 纯 JS FFI）。
 *
 * 只观察不拦截：所有事件都透传 CallNextHookEx，画圈判定的副作用
 * （如拖动了桌面图标）属于用户自己的操作，灵标绝不干扰输入。
 *
 * 坐标链路：MSLLHOOKSTRUCT.pt 是屏幕物理像素（低级钩子不受 DPI 虚拟化
 * 影响）→ 减主屏 bounds 原点 → 除 scaleFactor 转 DIP。DIP 与
 * screenshot.ts 截图像素坐标同尺度（thumbnail 按 DIP 尺寸取），圈选
 * 包围盒可直接用于裁剪。
 *
 * 采样策略：轨迹点间距 ≥3px（DIP）才记录——125Hz 鼠标全采样会点数爆炸，
 * 3px 间距既保形又控量。轨迹上限 2000 点防失控。
 */
import koffi from 'koffi';
import { screen } from 'electron';
import type { TrailPoint } from './gesture';

const user32 = koffi.load('user32.dll');

// MSLLHOOKSTRUCT（tagMSLLHOOKSTRUCT）
const MSLLPoint = koffi.struct('MSLLPointTag', { x: 'long', y: 'long' });
const MSLL = koffi.struct('MSLLHOOKSTRUCTTag', {
  pt: MSLLPoint,
  mouseData: 'uint32_t',
  flags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});

const HookProcProto = koffi.proto(
  'intptr_t MouseHookProc(int32_t nCode, uintptr_t wParam, void* lParam)'
);
/** 回调指针类型：koffi.register 要求传入 <callback>* 类型，返回 bigint 地址 */
const HookProcPtr = koffi.pointer(HookProcProto);
const SetWindowsHookExW = user32.func(
  'void* SetWindowsHookExW(int32_t idHook, MouseHookProc* lpfn, void* hmod, uint32_t dwThreadId)'
);
const CallNextHookEx = user32.func(
  'intptr_t CallNextHookEx(void* hhk, int32_t nCode, uintptr_t wParam, void* lParam)'
);
const UnhookWindowsHookEx = user32.func('int32_t UnhookWindowsHookEx(void* hhk)');

const WH_MOUSE_LL = 14;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const LLMHF_INJECTED = 0x01; // 注入事件（我们或其它软件模拟的）不当作用户手势
// 测试模式：放行注入事件（自动化测试用 SendInput/mouse_event 模拟画圈）。
// 真实运行必须关闭，否则其它软件的鼠标宏会被当成用户手势。
const ACCEPT_INJECTED = process.env.CURSORMIND_ACCEPT_INJECTED === '1';

const SAMPLE_GAP_DIP = 3;   // 采样最小间距（DIP px）
const MAX_TRAIL_POINTS = 2000;

let hook: unknown = null;         // HHOOK（koffi 外部指针）
let hookCb: bigint | null = null; // koffi.register 返回的回调地址（持引用防 GC）
let onTrailCb: ((pts: TrailPoint[]) => void) | null = null;

// 主屏换算参数（安装时缓存）
let scaleFactor = 1;
let originX = 0;
let originY = 0;

let collecting = false;
let trail: TrailPoint[] = [];

/** 钩子回调：只观察，异常全部吞掉（koffi 回调抛异常是未定义行为） */
function hookProc(nCode: number, wParam: number | bigint, lParam: unknown): bigint | number {
  try {
    if (nCode >= 0) {
      const msg = Number(wParam);
      if (msg === WM_LBUTTONDOWN || msg === WM_MOUSEMOVE || msg === WM_LBUTTONUP) {
        const info = koffi.decode(lParam, MSLL) as {
          pt: { x: number; y: number };
          flags: number;
          time: number;
        };
        if (ACCEPT_INJECTED || (info.flags & LLMHF_INJECTED) === 0) {
          handleEvent(msg, info);
        }
      }
    }
  } catch {
    // 观察失败静默：绝不让钩子链断掉
  }
  return CallNextHookEx(hook, nCode, wParam as never, lParam as never);
}

function handleEvent(
  msg: number,
  info: { pt: { x: number; y: number }; time: number }
): void {
  // 物理像素 → 主屏相对 DIP
  const x = (info.pt.x - originX) / scaleFactor;
  const y = (info.pt.y - originY) / scaleFactor;

  if (msg === WM_LBUTTONDOWN) {
    // 新按下：重置轨迹（丢弃没收到 up 的残迹）
    collecting = true;
    trail = [{ x, y, t: info.time }];
    return;
  }
  if (!collecting) return;

  if (msg === WM_MOUSEMOVE) {
    const last = trail[trail.length - 1];
    if (!last) return;
    if (Math.hypot(x - last.x, y - last.y) < SAMPLE_GAP_DIP) return;
    if (trail.length >= MAX_TRAIL_POINTS) return; // 防失控：超限停止记录（手势判定自然失败）
    trail.push({ x, y, t: info.time });
    return;
  }

  // WM_LBUTTONUP：轨迹收尾，交出去判定
  collecting = false;
  const last = trail[trail.length - 1];
  if (last && Math.hypot(x - last.x, y - last.y) >= 1) {
    trail.push({ x, y, t: info.time });
  }
  const pts = trail;
  trail = [];
  if (onTrailCb && pts.length > 1) {
    try {
      onTrailCb(pts);
    } catch {
      // 回调异常不影响钩子链
    }
  }
}

/**
 * 安装轨迹观察钩子。onTrail：左键抬起时收到完整轨迹（DIP 坐标）。
 * @returns 是否安装成功
 */
export function installMouseTrail(onTrail: (pts: TrailPoint[]) => void): boolean {
  if (hook) return true; // 已安装（幂等，重复调用只更新回调）
  onTrailCb = onTrail;

  const display = screen.getPrimaryDisplay();
  scaleFactor = display.scaleFactor || 1;
  originX = display.bounds.x;
  originY = display.bounds.y;

  hookCb = koffi.register(hookProc, HookProcPtr);
  if (hookCb === null || hookCb === undefined) return false;

  // WH_MOUSE_LL 全局钩子：hmod 允许 NULL（回调在当前进程内）
  hook = SetWindowsHookExW(WH_MOUSE_LL, hookCb as never, null as never, 0);
  if (!hook) {
    koffi.unregister(hookCb);
    hookCb = null;
    onTrailCb = null;
    return false;
  }
  return true;
}

/** 卸载钩子（app 退出时） */
export function uninstallMouseTrail(): void {
  if (hook) {
    UnhookWindowsHookEx(hook as never);
    hook = null;
  }
  if (hookCb !== null) {
    koffi.unregister(hookCb);
    hookCb = null;
  }
  onTrailCb = null;
  collecting = false;
  trail = [];
}
