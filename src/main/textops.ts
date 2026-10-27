/**
 * 文字操作：划选优化（A 卡片确认 + B 自动替换）与剪切（移动到指定位置）。
 *
 * 链路（利用「粘贴覆盖选区」的通用编辑器行为）：
 *   读：模拟 Ctrl+C（不破坏选区）→ 读剪贴板 → 暂存原剪贴板
 *   想：DeepSeek 优化（纯文本，不走截图管线）
 *   写：二次 Ctrl+C 确认选区仍在 → 剪贴板写新文本 → 模拟 Ctrl+V → 恢复原剪贴板
 * 降级链：任何一环失败 → 卡片模式（结果 + 已复制，用户手动 Ctrl+V）
 */
import { clipboard } from 'electron';
import { sendCommand } from './overlay';
import { sendCtrlCombo, VK } from './win-keys';
import { showTextCard, hideTextCard } from './textcard';

const DEEPSEEK_URL =
  (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com') + '/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

/** B 模式总开关（设置面板；false = A 卡片确认模式） */
let autoReplace = false;
export function setAutoReplace(v: boolean): void {
  autoReplace = v;
}

interface ClipText {
  text: string;
  /** 富文本（含格式）内容，恢复剪贴板时用；空 = 纯文本 */
  html: string;
}

function saveClipboard(): ClipText {
  const text = clipboard.readText();
  let html = '';
  try {
    html = clipboard.readHTML();
  } catch { html = ''; }
  return { text, html };
}

function restoreClipboard(c: ClipText): void {
  try {
    if (c.html) {
      clipboard.writeHTML(c.html); // 富文本优先：格式完整恢复
    } else {
      clipboard.writeText(c.text);
    }
  } catch { /* 恢复失败不阻塞主流程 */ }
}

/** 模拟 Ctrl+C 后小憩，等剪贴板更新（同步剪贴板有延迟） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function copySelection(): Promise<string> {
  sendCtrlCombo(VK.C);
  await sleep(120); // 剪贴板异步更新窗口
  return clipboard.readText();
}

/**
 * 划选优化入口（Ctrl+Alt+O）。
 * mode: 'polish' 优化原文并替换 / 'cut' 剪切（移除原文，等粘贴目标）
 */
export async function textPolish(mode: 'polish' | 'cut'): Promise<void> {
  // ① 读
  const savedClip = saveClipboard();
  const original = await copySelection();
  if (!original.trim()) {
    // 划选为空：可能没选东西或来源不可复制。直接弹卡片提示（不贴任何东西）
    showTextCard(mode === 'cut' ? '没检测到划选文字' : '没检测到划选文字，先划选一段再试', '', '');
    return;
  }

  // ② 想：单次调用光判断后优化——已足够好则不弹卡片，气泡告知（cut 模式不走模型）
  let optimized = original;
  if (mode === 'polish') {
    sendCommand({ type: 'thinking', text: '判断中' });
    const result = await optimizeText(original);
    sendCommand({ type: 'clear' });
    if (result === null) {
      // 模型失败 → 降级：把原文放回剪贴板并弹卡片（手动模式）
      restoreClipboard(savedClip);
      showTextCard('优化失败（模型不可用）', original, original);
      sendCommand({ type: 'bubble', text: '优化失败，已弹卡片' });
      return;
    }
    if (!result.changed || result.text.trim() === original.trim()) {
      // 模型判断不需要优化：不弹卡片，恢复剪贴板，气泡告知
      restoreClipboard(savedClip);
      sendCommand({ type: 'bubble', text: '这段话挺好，不用改' });
      return;
    }
    optimized = result.text;
  } else {
    // cut：模拟 Ctrl+X（用户选区已被剪切掉），文本已进剪贴板
    sendCtrlCombo(VK.X);
    await sleep(120);
    sendCommand({ type: 'bubble', text: '已剪切，去目标位置按 Ctrl+Alt+V' });
    return;
  }

  // ③ 写（B 模式：二次确认后自动替换；A 模式：弹卡片等确认）
  if (autoReplace) {
    const confirmText = await copySelection();
    if (confirmText !== original) {
      // 选区丢了（用户中途点了别处）→ 降级卡片
      clipboard.writeText(optimized);
      showTextCard('选区变了，已复制优化结果', original, optimized);
      restoreClipboardLater(savedClip, optimized);
      return;
    }
    clipboard.writeText(optimized);
    sendCtrlCombo(VK.V);
    await sleep(150);
    restoreClipboard(savedClip);
    sendCommand({ type: 'bubble', text: '已替换' });
  } else {
    // A 模式：写好剪贴板 + 弹卡片，用户点「替换」才粘贴
    clipboard.writeText(optimized);
    showTextCard('点「替换」自动贴回（或手动 Ctrl+V）', original, optimized, () => {
      // 用户确认替换：此时选区大概率还在（卡片浮在上层不抢焦点）
      void doConfirmReplace(savedClip, original, optimized);
    });
  }
}

/** A 模式卡片确认后的粘贴执行（带二次确认与降级） */
async function doConfirmReplace(savedClip: ClipText, original: string, optimized: string): Promise<void> {
  const confirmText = await copySelection();
  if (confirmText !== original) {
    clipboard.writeText(optimized);
    showTextCard('选区变了，已复制优化结果', original, optimized);
    return;
  }
  clipboard.writeText(optimized);
  sendCtrlCombo(VK.V);
  await sleep(150);
  restoreClipboard(savedClip);
  sendCommand({ type: 'bubble', text: '已替换' });
}

/** 剪切后到目标位置粘贴（Ctrl+Alt+V）：把剪贴板内容贴到当前光标处 */
export async function pasteFromClipboard(): Promise<void> {
  const text = clipboard.readText();
  if (!text.trim()) {
    sendCommand({ type: 'bubble', text: '剪贴板是空的' });
    return;
  }
  sendCtrlCombo(VK.V);
  await sleep(150);
  sendCommand({ type: 'bubble', text: '已粘贴' });
}

/** 延迟恢复剪贴板（给用户留手动 Ctrl+V 的窗口） */
function restoreClipboardLater(c: ClipText, currentText: string, delayMs = 8000): void {
  setTimeout(() => {
    // 用户还没手动粘贴（剪贴板仍是我们写的）才恢复
    if (clipboard.readText() === currentText) {
      restoreClipboard(c);
    }
  }, delayMs);
}

/** DeepSeek 判断+润色一体（单次调用）：文字已足够好返回 changed:false，避免两次请求 */
async function optimizeText(text: string): Promise<{ changed: boolean; text: string } | null> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          {
            role: 'system',
            content:
              '你是文字润色助手。先判断这段文字是否需要润色：\n- 若已足够通顺、专业、无明显问题，只输出 OK，不要任何其他内容。\n- 否则输出润色后的完整文字（更通顺、更专业、保留原意与原语言）。只输出结果本身，不要解释、不要引号、不要任何前后缀。',
          },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = data.choices?.[0]?.message?.content?.trim();
    if (!out) return null;
    if (/^ok[.!。！]?$/i.test(out)) return { changed: false, text: '' };
    return { changed: true, text: out };
  } catch {
    return null;
  }
}
