/**
 * 文字操作结果卡片：借 panel 窗口显示前后对比 + 替换/取消按钮。
 * 卡片是 DOM 元素（panel.html 注入样式），主进程只负责推送内容。
 */
import { getPanel } from './panel';

let cardShown = false;

export function showTextCard(
  title: string,
  original: string,
  optimized: string,
  onReplace?: () => void
): void {
  const panel = getPanel();
  if (!panel || panel.isDestroyed()) return;
  cardShown = true;
  // 替换确认走 IPC：渲染层点按钮后回发，避免闭包序列化问题
  pendingReplace = onReplace || null;
  panel.webContents.send('textcard:show', JSON.stringify({
    title,
    original,
    optimized,
    hasAction: !!onReplace,
  }));
}

export function hideTextCard(): void {
  const panel = getPanel();
  if (!panel || panel.isDestroyed()) return;
  cardShown = false;
  panel.webContents.send('textcard:hide');
}

/** 用户点了「替换」：执行挂起的回调 */
export function consumeReplaceAction(): boolean {
  if (pendingReplace) {
    const cb = pendingReplace;
    pendingReplace = null;
    cb();
    return true;
  }
  return false;
}

/** 用户点了「取消/关闭」：清挂起回调 */
export function cancelReplaceAction(): void {
  pendingReplace = null;
}

let pendingReplace: (() => void) | null = null;
