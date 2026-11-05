/**
 * 鼠标画圈（lasso）：轨迹 → 手势判定 → 圈选激活（截图裁剪暂存）
 * → 语音/打字问「我圈住的东西是什么」→ vision-exp 一次性 VQA。
 *
 * 与 Agent（教学 ReAct 循环）刻意分开：圈选问答是单轮 VQA，
 * 不需要 locate/指路工具，走最短路径省 token。
 *
 * 状态生命周期：激活 → 60s 超时 / 被消费（一次问答）/ Esc / 新圈覆盖。
 */
import * as fs from 'fs';
import * as path from 'path';
import { sendCommand } from './overlay';
import { captureRegionImage } from './screenshot';
import { showReply } from './panel';
import { speak } from './tts';
import { setTrayBusy } from './tray';
import {
  isCircleGesture,
  simplifyTrail,
  trailBox,
  type TrailBox,
  type TrailPoint,
} from './gesture';

const logFile = path.join(__dirname, '..', '..', '.temp', 'hotkey.log');
function lassoLog(msg: string): void {
  try { fs.appendFileSync(logFile, '[lasso] ' + msg + '\n'); } catch { /* 忽略 */ }
}

/** 圈住状态有效期（ms）：画完圈不问，60 秒后自动失效 */
const LASSO_TTL_MS = 60_000;
/** 裁剪外扩边距（DIP px）：圈内内容为主、带一点上下文 */
const CROP_PAD = 8;
const JPEG_QUALITY = 92;

interface LassoShot {
  dataUrl: string;
  width: number;
  height: number;
  /** 圈包围盒（DIP，与屏幕坐标一致，供渲染/日志） */
  rect: TrailBox;
}

let lassoShot: LassoShot | null = null;
let ttlTimer: NodeJS.Timeout | null = null;

/** 轨迹入口（win-mouse 抬笔回调）：判定画圈 → 激活圈选；普通拖动静默 */
export function handleTrail(pts: TrailPoint[]): void {
  const verdict = isCircleGesture(pts);
  if (!verdict.closed) {
    // 静默：绝大多数轨迹都是普通拖动/划选，不打扰
    if (verdict.reason && verdict.pathLength && verdict.pathLength > 600) {
      // 只记录"像要画圈但没成功"的轨迹，便于调阈值（纯短拖不刷日志）
      lassoLog('未判为圈: ' + verdict.reason + ' len=' + Math.round(verdict.pathLength));
    }
    return;
  }
  lassoLog(
    '画圈成立 转角=' + Math.round(verdict.totalAngleDeg || 0) +
    '° 路径=' + Math.round(verdict.pathLength || 0) + 'px 点数=' + pts.length
  );
  void activateLasso(pts, verdict.totalAngleDeg || 0);
}

/**
 * 激活圈选：判定通过即画圈（~1ms 反馈，heyClicky "progress at milestones" 哲学），
 * 截图裁剪并行后台跑（VQA 等用户提问，不急于那 ~600ms）。
 * 代令牌防覆盖：连续画圈时，旧圈的迟到截图结果作废。
 */
let activateGen = 0;
async function activateLasso(pts: TrailPoint[], angleDeg: number): Promise<void> {
  const box = trailBox(pts);
  const gen = ++activateGen;

  // ① 立即反馈：橙圈笔迹 + 气泡（不等截图）
  sendCommand({
    type: 'lasso',
    rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    points: simplifyTrail(pts, 240),
    bubble: '圈好了，问它吧',
  });
  lassoLog(
    '圈住 区域=' + Math.round(box.width) + 'x' + Math.round(box.height) + '@' +
    Math.round(box.x) + ',' + Math.round(box.y) + '（反馈已画，截图并行）'
  );

  // ② 截图裁剪（原生位图直裁，省双重 JPEG 编解码）
  const tShot = Date.now();
  const crop = await captureRegionImage(box);
  if (gen !== activateGen) {
    lassoLog('截图落地时已被新圈取代，丢弃');
    return;
  }
  if (!crop) {
    lassoLog('截图/裁剪失败，圈选未就绪');
    sendCommand({ type: 'bubble', text: '圈选截图失败，重新画一下' });
    return;
  }

  lassoShot = { dataUrl: crop.dataUrl, width: crop.width, height: crop.height, rect: box };
  if (ttlTimer) clearTimeout(ttlTimer);
  ttlTimer = setTimeout(() => {
    clearLasso('超时');
  }, LASSO_TTL_MS);
  lassoLog('圈选就绪 裁剪=' + crop.width + 'x' + crop.height + ' 耗时=' + (Date.now() - tShot) + 'ms');
}

/** handleTrail 已算过的转角复用（避免二次计算，仅日志用） */
let lastAngle = 0;
function verdictAngle(_pts: TrailPoint[]): number {
  return lastAngle;
}

/** 是否有活跃圈选 */
export function hasLasso(): boolean {
  return lassoShot !== null;
}

/** 圈指代命中（问题里提到圈/这/那/它 等指代词——有圈时短指代默认指向圈内） */
const LASSO_QUESTION_RE = /(圈|这块|这个|这里|里面|区域内|选的|划的|那是|那是啥|它是|它是什么|那个东西|该区域)/;

/**
 * 路由入口（routeVoice 最前）：有活跃圈选且问题指向圈 → 回答。
 * 圈选在回答成功后才清除（失败保留可重问——heyClicky "never say it happened unless it did"）。
 * @returns true 表示已接管该问题
 */
export function tryLasso(question: string): boolean {
  if (!lassoShot) return false;
  if (!LASSO_QUESTION_RE.test(question)) return false;
  void answerLasso(question, lassoShot);
  return true;
}

/** 清除圈选（Esc / 超时 / 消费 / 新圈覆盖） */
export function clearLasso(reason: string): void {
  const had = lassoShot !== null;
  lassoShot = null;
  if (ttlTimer) {
    clearTimeout(ttlTimer);
    ttlTimer = null;
  }
  if (had) {
    sendCommand({ type: 'lassoClear' });
    lassoLog('圈选清除: ' + reason);
  }
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const LASSO_SYSTEM_PROMPT =
  '你是"灵标"，一个桌面小精灵。用户在屏幕上画了一个圈，圈住了一块屏幕区域（截图见消息）。' +
  '回答用户关于这块区域的问题：第一句直接给结论（这是什么/叫什么/干什么用），之后只补充有用的话，不铺垫不重复问题。' +
  '若是其他问题就针对圈内内容直接回答。回答基于圈内可见内容，看不清或不确定就如实说，不臆测不虚构。' +
  '简洁口语，80 字内，不说教，不用 emoji。';

/** 圈选问答：vision-exp 单轮 VQA（无工具循环，最短路径） */
async function answerLasso(question: string, shot: LassoShot): Promise<void> {
  setTrayBusy(true, '看圈里的东西');
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY || '';
    const baseUrl = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
    const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
    if (!apiKey) {
      sendCommand({ type: 'bubble', text: '未配置 DeepSeek API Key' });
      return;
    }

    sendCommand({ type: 'thinking', text: '看圈里' });
    const tChat = Date.now();
    let text = '';
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: LASSO_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: shot.dataUrl } },
                {
                  type: 'text',
                  text: `${question}\n\n[用户画的圈圈住了这块区域，截图尺寸 ${shot.width}x${shot.height} 像素]`,
                },
              ],
            },
          ],
          temperature: 0.2,
        }),
      });
      if (!resp.ok) {
        sendCommand({ type: 'bubble', text: '模型调用失败（' + resp.status + '）' });
        return;
      }
      const data = (await resp.json()) as ChatResponse;
      text = String(data.choices?.[0]?.message?.content || '').trim();
    } catch {
      sendCommand({ type: 'bubble', text: '模型连接失败' });
      return;
    } finally {
      sendCommand({ type: 'clear' });
    }
    lassoLog('问答 ' + (Date.now() - tChat) + 'ms model=' + model + ' 回复=' + text.replace(/\s+/g, ' ').slice(0, 60));

    if (!text) {
      // 失败：圈保留（可重问），如实告知
      sendCommand({ type: 'bubble', text: '没看明白，再问一次或重新画圈' });
      return;
    }
    showReply(text);
    speak(text);
    sendCommand({ type: 'bubble', text: text.replace(/\s+/g, ' ').slice(0, 30) });
    // 成功后清圈：答案已给，语境消费完毕
    clearLasso('消费');
  } finally {
    setTrayBusy(false);
  }
}
