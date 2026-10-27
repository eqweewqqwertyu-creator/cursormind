import { sendCommand } from './overlay';
import { showPanel, hidePanel, collapsePanel, openSearchPanel } from './panel';
import { Agent } from './agent';
import { VlmLocator } from './vlm-locator';
import { captureScreen } from './screenshot';
import type { Feature } from '../shared/types';

/**
 * 引导大脑（纯视觉方案）：热键 → 提问 → DeepSeek 意图理解 → Qwen3-VL 视觉定位 → 指路。
 * 保留"教你"内核：Agent 只指路，不代操作。
 */
export class Brain {
  private agent: Agent;
  private locator: VlmLocator;
  private features: Feature[];

  constructor(features: Feature[]) {
    this.features = features;
    this.locator = new VlmLocator();
    this.agent = new Agent(this.locator);
  }

  /** 召唤：精灵飞入 + 弹出提问面板 */
  invoke(): void {
    this.agent.reset();
    sendCommand({ type: 'flyIn', fromEdge: 'left' });
    showPanel();
  }

  /** 长按 ~ ：召唤并直接展开提问输入框（打字模式） */
  invokeTyping(): void {
    this.agent.reset();
    sendCommand({ type: 'flyIn', fromEdge: 'left' });
    openSearchPanel();
  }

  /** 用户提交问题：收回面板（窗口隐藏，回复到达时若在召唤态自动再展开） */
  async ask(question: string): Promise<void> {
    if (this.agent.enabled) {
      // 先收面板再跑（提问后视线回到球上，面板让位）
      collapsePanel();
      await this.agent.run(question);
    } else {
      collapsePanel();
      await this.answerFallback(question);
    }
  }

  /** 连续引导："我做完了这一步，继续"（Ctrl+Alt+N） */
  async nextStep(): Promise<void> {
    if (this.agent.enabled) {
      await this.agent.nextStep();
    }
  }

  /** 无 API Key 时的本地知识库兜底（仅文本提示） */
  private async answerFallback(question: string): Promise<void> {
    const feature = this.matchFeature(question);
    if (!feature) {
      sendCommand({ type: 'bubble', text: '没听懂，且未配置模型 Key' });
      return;
    }
    sendCommand({ type: 'bubble', text: feature.bubble });
  }

  private matchFeature(question: string): Feature | null {
    const q = question.toLowerCase();
    let best: Feature | null = null;
    let bestScore = 0;
    for (const f of this.features) {
      for (const name of f.names) {
        const n = name.toLowerCase();
        if (q.includes(n) && n.length > bestScore) {
          bestScore = n.length;
          best = f;
        }
      }
    }
    return best;
  }

  /** 重置对话：清空历史、取消进行中的轮次，开始新对话 */
  newConversation(): void {
    this.agent.reset(); // generation++ 使旧循环静默失效
    sendCommand({ type: 'clear' });
    sendCommand({ type: 'bubble', text: '新对话已开始' });
    setTimeout(() => {
      sendCommand({ type: 'clear' });
    }, 1600);
  }

  /** 退场（Esc 触发） */
  cancel(): void {
    hidePanel();
    sendCommand({ type: 'flyOut' });
    this.agent.reset();
  }

  /** 自检模式：不依赖模型，验证视觉链路 */
  testFly(): void {
    sendCommand({ type: 'flyIn', fromEdge: 'left' });
    setTimeout(() => {
      sendCommand({ type: 'flyTo', rect: { x: 680, y: 260, width: 460, height: 220 }, bubble: '先点这儿' });
    }, 1000);
  }
}
