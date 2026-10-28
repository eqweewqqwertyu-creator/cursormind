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
import * as fs from 'fs';
import * as path from 'path';
import { sendCommand } from './overlay';
import { sendCtrlCombo, sendKey, VK } from './win-keys';
import { showTextCard, hideTextCard } from './textcard';
import { speak } from './tts';
import { setTrayBusy } from './tray';

const DEEPSEEK_URL =
  (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com') + '/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const QWEN_TEXT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

// 同步日志：与 index.ts 共用 hotkey.log，textPolish 每步落盘便于诊断
const logFile = path.join(__dirname, '..', '..', '.temp', 'hotkey.log');
function log(msg: string): void {
  try { fs.appendFileSync(logFile, msg + '\n'); } catch { /* 忽略 */ }
}

/** B 模式总开关（设置面板；false = A 卡片确认模式） */
let autoReplace = false;
export function setAutoReplace(v: boolean): void {
  autoReplace = v;
}
/** 面板打开时同步开关真实状态（修复：重开后设置面板显示的旧默认值 bug） */
export function isAutoReplace(): boolean {
  return autoReplace;
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

/** 划选优化入口（Ctrl+Alt+O 或语音意图路由）。
 * mode: 'polish' 优化原文并替换 / 'cut' 剪切（移除原文，等粘贴目标）
 * forceAuto: 语音触发时强制自动替换（用户就是要「说一句就改好」，不受设置开关影响）
 */
export async function textPolish(mode: 'polish' | 'cut', forceAuto = false): Promise<void> {
  setTrayBusy(true, '正在优化文字');
  try {
    await textPolishCore(mode, forceAuto);
  } finally {
    setTrayBusy(false);
  }
}

async function textPolishCore(mode: 'polish' | 'cut', forceAuto = false): Promise<void> {
  // ① 读
  const savedClip = saveClipboard();
  const original = await copySelection();
  log(`[textops] ${mode} 读选区: ${original ? original.length + '字' : '空'}`);
  if (!original.trim()) {
    // 划选为空：可能没选东西或来源不可复制。直接弹卡片提示（不贴任何东西）
    log('[textops] 读选区为空（未划选或 Ctrl+C 未生效）');
    showTextCard(mode === 'cut' ? '没检测到划选文字' : '没检测到划选文字，先划选一段再试', '', '');
    sendCommand({ type: 'bubble', text: '没检测到划选文字，先划选一段再试' });
    speak('没检测到划选的文字，先划选一段再试');
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
      log('[textops] 模型优化失败（DeepSeek 不可用）');
      restoreClipboard(savedClip);
      showTextCard('优化失败（模型不可用）', original, original);
      sendCommand({ type: 'bubble', text: '优化失败，已弹卡片' });
      speak('优化失败，模型不可用');
      return;
    }
    if (!result.changed || result.text.trim() === original.trim()) {
      // 模型判断不需要优化：不弹卡片，恢复剪贴板，气泡告知
      log('[textops] 模型判断无需优化');
      restoreClipboard(savedClip);
      sendCommand({ type: 'bubble', text: '这段话挺好，不用改' });
      return;
    }
    optimized = result.text;
    log(`[textops] 优化完成: ${optimized.length}字`);
  } else {
    // cut：模拟 Ctrl+X（用户选区已被剪切掉），文本已进剪贴板
    sendCtrlCombo(VK.X);
    await sleep(120);
    sendCommand({ type: 'bubble', text: '已剪切，去目标位置按 Ctrl+Alt+V' });
    return;
  }

  // ③ 写（B 模式：二次确认后自动替换；A 模式：弹卡片等确认）
  if (autoReplace || forceAuto) {
    const confirmText = await copySelection();
    log(`[textops] 二次确认选区: ${confirmText === original ? '一致' : '不一致'}`);
    if (confirmText !== original) {
      // 选区丢了（用户中途点了别处）→ 降级卡片
      log('[textops] 选区已变，降级卡片');
      clipboard.writeText(optimized);
      showTextCard('选区变了，已复制优化结果', original, optimized);
      restoreClipboardLater(savedClip, optimized);
      return;
    }
    clipboard.writeText(optimized);
    sendCtrlCombo(VK.V);
    await sleep(150);
    restoreClipboard(savedClip);
    log('[textops] 已自动替换（Ctrl+V）');
    sendCommand({ type: 'bubble', text: '已替换' });
    speak('已替换');
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

/** 语音「搜索X并粘贴到这」意图：返回搜索词，null = 不命中。
 * 例：「把DeepSeek官网粘贴到这」→ 'DeepSeek官网'；「帮我搜索xxx然后粘贴」→ 'xxx'。
 * 提不出有效搜索词时配合 isPasteClipboardIntent 走「粘贴剪贴板」链路。
 */
export function extractSearchPaste(text: string): string | null {
  const t = text.trim().replace(/[。！!？?，,~]+$/g, '');
  if (!t || !/(粘贴|贴|发|填)/.test(t)) return null;
  // 头部功能词可叠加（如「帮我搜索」「查一下」）；交替里长词在前避免被短词截断；
  // 尾部位置词用 + 量词容忍 ASR 重复噪音（「粘贴到此此处」）；「此处/这边」等 ASR 常见转写都在表内
  const HEAD = '(?:把|帮我|给我|请|搜索|搜一下|搜|查一下|查找|查|查询)*';
  const TAIL = '(?:这|这里|这儿|此|此处|这边|当前光标|光标处|光标|输入框|文本框|框里|框内|对话框)+$';
  let m = t.match(new RegExp('^' + HEAD + '(.{1,40}?)(?:给)?(?:粘贴|贴|发|填)(?:到|在|过来)?' + TAIL));
  let q = m ? m[1].trim() : '';
  if (!q) {
    m = t.match(/^(?:把|帮我|给我|请|搜索|搜一下|搜|查一下|查找|查|查询)(.{1,40}?)(?:并|然后|再)?(?:粘贴|贴上?|发|填)$/);
    q = m ? m[1].trim() : '';
  }
  q = q.replace(/^(一下|一个|个)/, '').trim(); // 剥头部残留功能词（「查一下X」→「X」）
  q = q.replace(/^(?:把|帮我|给我|请|搜索|搜一下|搜|查一下|查找|查|查询)+/, '').trim(); // 剥头部词残留（「帮我搜索X」后半截）
  const stop = ['一下', '这段', '这句', '这个', '这段话', '这句话', '内容', '结果', '文本', '它', '剪贴板', '粘', '帮', '把', ''];
  if (!q || stop.includes(q)) return null;
  return q;
}

/** 「把X三个字/N个字/这个词粘贴到这」→ 直接输入文字 X（不需搜索），正则快路径。
 * 返回 null 表示不是明确的「文字本身」表述，交给 LLM 分类或搜索链路。
 */
export function extractInputText(text: string): string | null {
  const t = text.trim().replace(/[。！!？?，,~]+$/g, '');
  if (!t || !/(粘贴|贴|发|填|输入|打)/.test(t)) return null;
  const HEAD = '(?:把|帮我|给我|请|输入|打|搜索)*';
  const TAIL = '(?:这|这里|这儿|此|此处|这边|当前光标|光标处|光标|输入框|文本框|框里|框内|对话框)+$';
  let m = t.match(new RegExp('^' + HEAD + '(.{1,60}?)(?:给)?(?:粘贴|贴|发|填|输入|打)(?:到|在|过来|进|进去)?' + TAIL));
  if (!m) return null;
  const q = m[1].trim().replace(/^(?:把|帮我|给我|请|输入|打)+/, '').trim();
  // 「X三个字/这个词/这段文字」等明确指文字本身的表述
  const wm = q.match(/^(.{1,50}?)(?:这)?(?:一个字|两个字|三个字|四个字|五个字|六个字|七个字|八个字|个字|这几个字|这些字|这个词|这个字|这句话|这段文字)$/);
  if (wm) return wm[1].trim();
  return null;
}

/** 粘贴类模糊意图判定：含粘贴/输入动词且非提问（怎么/如何），才进 LLM 分类 */
export function isPasteIntent(text: string): boolean {
  const t = text.trim().replace(/[。！!？?，,~]+$/g, '');
  if (!t || !/(粘贴|贴|发|填|输入)/.test(t)) return false;
  const ask = ['怎么', '如何', '为什么', '为啥', '什么是'];
  return !ask.some((k) => t.includes(k));
}

interface PasteClassify {
  kind: 'input' | 'search' | 'clipboard';
  text?: string;
  query?: string;
}

/** LLM 意图分类（qwen-turbo）：粘贴类语音的语义细分，替代正则穷举；失败返回 null 由调用方降级旧正则 */
export async function classifyPasteIntent(text: string): Promise<PasteClassify | null> {
  const key = process.env.QWEN_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch(QWEN_TEXT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        // 注：qwen-turbo 在本账号 429 限流（Throttling.RateQuota），用 qwen-plus（实测 ~0.5s）
        model: 'qwen-plus',
        input: {
          messages: [
            {
              role: 'system',
              content:
                '你是桌面助手的语音指令分类器。用户说的话（语音转写，可能有错别字或重复字）想往光标处粘贴东西。分类并只输出 JSON：\n- 用户要粘贴具体文字本身 → {"kind":"input","text":"去掉修饰后的文字"}（如「把我爱你三个字粘贴到此处」→ {"kind":"input","text":"我爱你"}；「把你好输入到框里」→ {"kind":"input","text":"你好"}）\n- 要粘贴需要联网查的信息（官网网址、电话、天气、价格等）→ {"kind":"search","query":"要查的东西"}（如「把DeepSeek官网粘贴到这」→ {"kind":"search","query":"DeepSeek官网"}）\n- 贴剪贴板已有内容 → {"kind":"clipboard"}\n无法判断输出 null。只输出 JSON 本身，不要解释、不要 markdown。',
            },
            { role: 'user', content: text },
          ],
        },
        parameters: { temperature: 0.1 },
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { output?: { text?: string } };
    const raw = (data.output?.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw) as PasteClassify;
    if (parsed && (parsed.kind === 'input' || parsed.kind === 'search' || parsed.kind === 'clipboard')) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** 直接输入文字到光标：写剪贴板 → Ctrl+V → 恢复原剪贴板（语音「把X三个字粘贴到这」链路） */
export async function inputText(text: string): Promise<void> {
  setTrayBusy(true, '正在输入');
  try {
    const savedClip = saveClipboard();
    clipboard.writeText(text);
    sendCtrlCombo(VK.V);
    await sleep(150);
    restoreClipboard(savedClip);
    log('[textops] 已输入文字: ' + text.slice(0, 40));
    sendCommand({ type: 'bubble', text: '已输入：' + text.slice(0, 30) });
    speak('已输入');
  } finally {
    setTrayBusy(false);
  }
}

/** 「粘贴剪贴板」语音意图：用户只说粘贴没说要搜什么（「帮我粘贴到这」），贴剪贴板现有内容。
 * 含提问词（怎么/如何）时不命中，让它走 Agent 提问链路。
 */
export function isPasteClipboardIntent(text: string): boolean {
  const t = text.trim().replace(/[。！!？?，,~]+$/g, '');
  if (!/(粘贴|贴|发|填)/.test(t)) return false;
  const ask = ['怎么', '如何', '为什么', '为啥', '什么是'];
  if (ask.some((k) => t.includes(k))) return false;
  return /(到这|到这里|这儿|一下|粘贴|贴上)/.test(t);
}

// ================= 基础编辑操作（产品转向：教学+执行混合型） =================
// 复制/删除/全选/撤销/重做：明确指令直接执行，动作快路径不占 LLM 工具位。

/** 复制当前划选（Ctrl+C）：复制语义 = 剪贴板保留新内容（不恢复） */
export async function copySelectionNow(): Promise<void> {
  const text = await copySelection();
  log('[textops] 复制: ' + (text ? text.length + '字' : '空'));
  if (!text.trim()) {
    sendCommand({ type: 'bubble', text: '没检测到划选文字' });
    speak('没检测到划选的文字');
    return;
  }
  sendCommand({ type: 'bubble', text: '已复制 ' + text.length + ' 字' });
  speak('已复制');
}

/** 删除当前划选（Delete 键，不动剪贴板）：先探测选区，空则提示——避免误删光标后字符 */
export async function deleteSelectionNow(): Promise<void> {
  const savedClip = saveClipboard();
  const text = await copySelection(); // 探测用：读选区不破坏
  if (!text.trim()) {
    restoreClipboard(savedClip);
    log('[textops] 删除: 无划选');
    sendCommand({ type: 'bubble', text: '没检测到划选文字' });
    speak('没检测到划选的文字');
    return;
  }
  restoreClipboard(savedClip); // 探测结束恢复原剪贴板
  sendKey(VK.DEL);             // Delete 只删选中内容，剪贴板无感
  await sleep(120);
  log('[textops] 已删除: ' + text.length + '字');
  sendCommand({ type: 'bubble', text: '已删除 ' + text.length + ' 字' });
  speak('已删除');
}

/** 全选（Ctrl+A） */
export function selectAllNow(): void {
  sendCtrlCombo(VK.A);
  log('[textops] 已全选');
  sendCommand({ type: 'bubble', text: '已全选' });
  speak('已全选');
}

/** 撤销（Ctrl+Z）：执行型操作的补救入口 */
export function undoNow(): void {
  sendCtrlCombo(VK.Z);
  log('[textops] 已撤销');
  sendCommand({ type: 'bubble', text: '已撤销' });
  speak('已撤销');
}

/** 重做（Ctrl+Y） */
export function redoNow(): void {
  sendCtrlCombo(VK.Y);
  log('[textops] 已重做');
  sendCommand({ type: 'bubble', text: '已重做' });
  speak('已重做');
}

/** 语音「基础编辑操作」意图匹配：明确指令（复制/删除/全选/撤销/重做）返回对应执行函数。
 * 提问词（怎么/如何）不命中走 Agent；「优化一下这段」等含动作词的长句不被锚定正则误伤。
 */
export function matchBasicOp(text: string): (() => void) | null {
  const t = text.trim().replace(/[。！!？?，,~]+$/g, '');
  if (!t) return null;
  const ask = ['怎么', '如何', '为什么', '为啥', '什么是', '什么意思'];
  if (ask.some((k) => t.includes(k))) return null;
  if (/^(?:帮我|请)?(?:复制|拷贝)(?:一下|这段|这个|所选|选中的?|内容|文字)?$/.test(t)) return copySelectionNow;
  if (/^(?:帮我|请)?(?:删除|删掉|删了|去掉|移除)(?:一下|这段|这个|所选|选中的?|内容|文字|它)?$/.test(t)) return deleteSelectionNow;
  if (/^(?:帮我|请)?(?:全选|选择全部|选中全部)(?:一下)?$/.test(t)) return selectAllNow;
  if (/^(?:帮我|请)?(?:撤销|撤回|后退一步|取消上一步|上一步)$/.test(t)) return undoNow;
  if (/^(?:帮我|请)?(?:重做|恢复上一步)$/.test(t)) return redoNow;
  return null;
}

/** 搜索并粘贴到当前光标：百炼联网搜索（enable_search）→ 写剪贴板 → Ctrl+V → 恢复原剪贴板 */
export async function searchAndPaste(query: string): Promise<void> {
  setTrayBusy(true, '正在搜索');
  try {
    await searchAndPasteCore(query);
  } finally {
    setTrayBusy(false);
  }
}

async function searchAndPasteCore(query: string): Promise<void> {
  log('[textops] 搜索粘贴: ' + query);
  const savedClip = saveClipboard();
  sendCommand({ type: 'thinking', text: '搜索中' });
  speak('正在搜索' + query);
  const answer = await searchWeb(query);
  sendCommand({ type: 'clear' });
  if (!answer) {
    log('[textops] 搜索失败（百炼不可用）');
    restoreClipboard(savedClip);
    sendCommand({ type: 'bubble', text: '搜索失败，再试一次' });
    speak('搜索失败，再试一次');
    return;
  }
  clipboard.writeText(answer);
  sendCtrlCombo(VK.V);
  await sleep(150);
  restoreClipboard(savedClip);
  log('[textops] 已粘贴: ' + answer.slice(0, 60));
  sendCommand({ type: 'bubble', text: '已粘贴：' + answer.slice(0, 40) });
  speak('已粘贴');
}

/** 百炼联网搜索：只要核心答案（网址/单条信息）。实测（2026-10-27）响应在 output.text（text-generation 接口，与 multimodal 的 choices 结构不同） */
async function searchWeb(query: string): Promise<string | null> {
  const key = process.env.QWEN_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch(QWEN_TEXT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'qwen-plus',
        input: {
          messages: [
            {
              role: 'system',
              content:
                '你是搜索助手。用户描述想要的东西，你联网搜索后只输出核心答案本身：若要网址只输出网址（https:// 开头）；若要其他信息只输出那一条信息。不要解释、标点或多余文字。',
            },
            { role: 'user', content: query },
          ],
        },
        parameters: { enable_search: true },
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { output?: { text?: string } };
    const raw = (data.output?.text || '').trim();
    if (!raw) return null;
    const m = raw.match(/https?:\/\/[^\s"'）)】<>]+/);
    return (m ? m[0] : raw).replace(/[。，,.!！]+$/, '');
  } catch {
    return null;
  }
}

/** 语音识别文本是否属于「划选优化」意图（而非提问）。
 * 命中动作词（优化/润色/书面化/改写/精炼等）且不含「怎么/如何/为什么」等提问词，
 * 例：「优化一下这段话」→ true；「怎么优化这段代码」→ false（是教学问题）。
 */
export function isPolishIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const action = ['优化', '润色', '书面化', '改写', '精炼', '改一下', '改这段', '改这句'];
  if (!action.some((k) => t.includes(k))) return false;
  const ask = ['怎么', '如何', '为什么', '为啥', '什么是', '什么意思'];
  return !ask.some((k) => t.includes(k));
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
