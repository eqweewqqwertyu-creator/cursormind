import type { Rect } from '../shared/types';
import { sendCommand } from './overlay';
import { showReply } from './panel';
import { captureScreen } from './screenshot';
import { parsePointing } from './point-protocol';
import type { VlmLocator } from './vlm-locator';

/** 长回答：显示在提问面板上方的回复条（不截断）；气泡只放一句短摘要 */
function finalAnswer(text: string): void {
  const t = (text || '').trim();
  if (!t) return;
  showReply(t);
  sendCommand({ type: 'bubble', text: truncate(t, 30) });
}

interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatResponse {
  choices?: Array<{ message?: ChatMessage }>;
}

const SYSTEM_PROMPT = `你是"灵标"，一个教学型鼠标精灵助手。你收到一张当前屏幕的截图（带尺寸标注），帮用户找到某个功能并指给他看。

工作流程（重要）：
1. 看截图理解用户当前在哪个应用/界面、处于什么状态。
2. 用户想找屏幕上的某个功能/按钮/面板时：先调用 locate(target) 让专职视觉模型精确定位，再根据返回结果组织回答。
3. locate 返回成功：精灵会自己飞过去圈住目标，你的回答只需补充"怎么用"的操作要点。
4. locate 返回 null（没找到）：如实用文字描述位置（"在屏幕左上角导航栏"等），若需要粗略指路，可在回复最末尾追加坐标标签 [POINT:x,y:标签]（坐标系 = 截图标签注明的像素尺寸，原点左上，x向右y向下）。
5. 闲聊或知识类问题：直接用 answer 回答，不指路，若用户提到了屏幕元素才需要 locate。
6. 你只指路和讲解，绝不替用户点击或输入。教学为先：告诉用户"是什么、在哪、下一步点什么"。

连续引导（多步任务，重要）：
- 用户的请求往往需要多步操作才能完成（如"找到微信的设置界面"需要：双击图标 → 打开微信 → 点左下角设置）。
- 每次只指【当前这一步】。指完后在回复末尾明确告诉用户："完成后按 Ctrl+Alt+N 继续"。
- 【必须先指后说】每一步的具体目标（按钮/图标/菜单项）都要先调用 locate(target) 让精灵飞过去圈住，再用文字补充说明。不要只给文字描述——用户需要看到框才知道点哪。只有纯知识性回答才允许不带 locate。
- 用户按 Ctrl+Alt+N 后，系统会重新截图并附上"[用户已完成上一步]"发给你。你要：
  a) 看截图确认上一步是否真的完成（用户可能点错了，如没完成就再指一遍纠正）；
  b) 完成了就继续指下一步（同样先 locate 再说话）；
  c) 看到目标已达成（如设置界面已打开），明确说"任务完成"，不再要求按 N。
- 每一步都基于【当前截图的真实状态】判断，不要死板依赖预设步骤：用户抄近路了就顺着来，点错了就纠正。

文风：简洁、像朋友提醒，不说教，不用 emoji。answer 的 text 控制在 80 字内，说要点。`;

export class Agent {
  private locator: VlmLocator;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private history: ChatMessage[] = [];
  private tools: ToolDef[];
  /** 单任务模型：新一轮开始时取消上一轮 */
  private generation = 0;
  /** 本轮截图（工具执行时可复用） */
  private currentShot: Awaited<ReturnType<typeof captureScreen>> = null;

  constructor(locator: VlmLocator) {
    this.locator = locator;
    this.apiKey = process.env.DEEPSEEK_API_KEY || '';
    this.baseUrl = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
    this.tools = buildTools();
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  reset(): void {
    this.history = [];
    this.generation++; // 使旧循环失效
    this.currentShot = null;
  }

  /** 引导循环中（连续引导会话进行时） */
  get inGuideSession(): boolean {
    return this.history.length > 0;
  }

  /** 连续引导：用户按 Ctrl+Alt+N，表示已完成上一步，继续指下一步 */
  async nextStep(): Promise<void> {
    if (!this.enabled) return;
    if (this.history.length === 0) {
      sendCommand({ type: 'bubble', text: '没有进行中的引导，先提问吧' });
      return;
    }
    // 不清历史（引导会话延续上下文），只取消可能在跑的旧轮次
    await this.run('[用户已完成上一步，按了 Ctrl+Alt+N] 请看最新截图：确认上一步是否完成，然后继续指下一步，或宣布任务完成。');
  }

  /** ReAct 主循环：思考 → 调工具 → 观察 → 再思考 */
  async run(question: string): Promise<void> {
    if (!this.enabled) {
      sendCommand({ type: 'bubble', text: '未配置 DeepSeek API Key' });
      return;
    }

    const gen = ++this.generation; // 新一轮：旧循环全部失效
    const cancelled = (): boolean => gen !== this.generation;

    this.history.push({ role: 'user', content: question });
    if (this.history.length > 20) {
      this.history = this.history.slice(-20);
    }

    // 思考中反馈：提交即触发，让用户知道正在处理
    sendCommand({ type: 'thinking', text: '思考中' });

    // 自动截图：让模型看到真实屏幕；尺寸写进文本，作为坐标系自描述
    const shot = await captureScreen();
    if (cancelled()) return; // 检查点：截图之后
    this.currentShot = shot;
    if (shot) {
      this.history[this.history.length - 1] = {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: shot.dataUrl } },
          {
            type: 'text',
            text: `${question}\n\n[截图尺寸: ${shot.width}x${shot.height} 像素，作为坐标指路的空间]`,
          },
        ],
      };
    }

    for (let step = 0; step < 8; step++) {
      const resp = await this.chat();
      if (cancelled()) return; // 检查点：API 响应之后
      if (!resp) return;
      const msg = resp.choices?.[0]?.message;
      if (!msg) return;

      let contentStr = '';
      if (typeof msg.content === 'string') contentStr = msg.content;

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length > 0) {
        // 历史防污染：入历史的文本剥离 POINT 标签
        this.history.push({ ...msg, content: stripPointTag(contentStr) });
        for (const tc of toolCalls) {
          // 视觉定位阶段提示更新
          if (tc.function.name === 'locate') {
            sendCommand({ type: 'thinking', text: '看屏幕找' });
          }
          const result = await this.executeTool(tc.function.name, tc.function.arguments);
          if (cancelled()) return; // 检查点：工具执行之后
          this.history.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue;
      }

      // 无工具调用 → 最终回答
      if (contentStr) {
        this.applyFinal(contentStr);
      }
      return;
    }

    sendCommand({ type: 'bubble', text: '想得有点久，先停一下' });
  }

  /** 最终回答处理：locate 已指路则只补充话术；否则解析 POINT 粗指路兜底 */
  private applyFinal(text: string): void {
    const parsed = parsePointing(text);

    // POINT 粗指路（locate 失败时的兜底路径）
    if (parsed.coordinate && this.currentShot) {
      const shot = this.currentShot;
      const p = {
        x: (parsed.coordinate.x / shot.width) * shot.screenWidth,
        y: (parsed.coordinate.y / shot.height) * shot.screenHeight,
      };
      const label = parsed.elementLabel || '';
      sendCommand({
        type: 'flyToPosition',
        position: { x: Math.round(p.x), y: Math.round(p.y) },
        bubble: truncate(`${label}大概在这`, 30),
      });
    }

    finalAnswer(parsed.spokenText);
    // 历史存剥离标签后的文本（防污染）
    const last = this.history[this.history.length - 1];
    if (last && last.role === 'assistant' && typeof last.content === 'string') {
      last.content = parsed.spokenText;
    }
  }

  private async chat(): Promise<ChatResponse | null> {
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history],
          tools: this.tools,
          tool_choice: 'auto',
          temperature: 0.2,
        }),
      });
      if (!resp.ok) {
        sendCommand({ type: 'bubble', text: '模型调用失败（' + resp.status + '）' });
        return null;
      }
      return (await resp.json()) as ChatResponse;
    } catch {
      sendCommand({ type: 'bubble', text: '模型连接失败' });
      return null;
    }
  }

  private async executeTool(name: string, argsStr: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsStr || '{}');
    } catch {
      // 参数解析失败就用空对象
    }
    try {
      switch (name) {
        case 'locate':
          return await this.toolLocate(String(args.target || ''));
        case 'answer':
          finalAnswer(String(args.text || ''));
          return 'ok';
        default:
          return '未知工具: ' + name;
      }
    } catch (e) {
      return '工具执行失败: ' + (e instanceof Error ? e.message : String(e));
    }
  }

  /** 视觉定位：调 Qwen3-VL 拿 bbox → 精灵精确指路 */
  private async toolLocate(target: string): Promise<string> {
    if (!target) return '缺少 target 参数';
    if (!this.locator.enabled) return 'LOCATOR_UNAVAILABLE: 视觉定位模型未配置（QWEN_API_KEY），请用文字描述位置';
    if (!this.currentShot) return 'LOCATOR_UNAVAILABLE: 本轮没有截图，请用文字描述位置';

    const result = await this.locator.locate(target, this.currentShot);
    if (!result) return 'NOT_FOUND: 截图里没找到该元素。请如实用文字描述它的大致位置（如"在屏幕左上角导航栏"），或用文末 [POINT:x,y:标签] 粗指。';

    // 指路：小目标画框，大目标只飞中心
    const { rect, label } = result;
    const area = rect.width * rect.height;
    const screenArea = this.currentShot.screenWidth * this.currentShot.screenHeight;
    if (area < screenArea * 0.4) {
      sendCommand({ type: 'flyTo', rect, bubble: truncate(label || target, 30) });
    } else {
      sendCommand({
        type: 'flyToPosition',
        position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        bubble: truncate(`${label || target}在这片`, 30),
      });
    }
    return `FOUND: 已定位 "${label || target}"，bbox=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}。精灵已圈住它，你的回答只需说明这是什么、下一步怎么操作。`;
  }
}

function stripPointTag(text: string): string {
  return text.replace(/\s*\[POINT:[^\]]*\]\s*$/, '').trim();
}

function truncate(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

function buildTools(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'locate',
        description:
          '调用专职视觉模型在当前截图中精确定位一个 UI 元素（按钮/菜单/面板/输入框等），精灵会飞过去圈住它。用户想找屏幕上的任何东西时先调用这个工具。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '要定位的目标描述，如 "微信发送按钮"、"浏览器地址栏"' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'answer',
        description:
          '不需要指路时（闲聊、知识问答），用一段文字直接回答用户。若用户问的是屏幕元素位置，应先调 locate。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '回答内容，80 字内，说要点' },
          },
          required: ['text'],
        },
      },
    },
  ];
}
