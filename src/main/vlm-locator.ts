import type { Rect } from '../shared/types';
import type { ScreenShot } from './screenshot';

/**
 * 视觉定位器：Qwen3-VL-8B（DashScope API，OpenAI 兼容）。
 * 输入截图 + 目标描述，输出元素 bbox（控件级精度）。
 *
 * Qwen3-VL 的 grounding 输出为 0-1000 相对坐标（归一化），
 * 客户端按实际图宽高换算回像素 —— 天然免疫 DPI/分辨率差异。
 */

interface QwenBox {
  bbox_2d?: [number, number, number, number];
  label?: string;
}

export interface LocateResult {
  rect: Rect; // 屏幕 DIP 坐标矩形
  label: string | null;
}

const SYSTEM_PROMPT = `You are a GUI grounding assistant. Find the UI element the user describes in the screenshot and return its bounding box.

Rules:
- Reply ONLY with a JSON array. No markdown, no explanation.
- Each item: {"bbox_2d": [x1, y1, x2, y2], "label": "short name"}
- Coordinates are relative: 0-1000 on both axes, origin at top-left, x rightward, y downward.
- Return exactly one most-matching element unless the user asks for several.
- If nothing matches, return [].`;

export class VlmLocator {
  private apiKey = '';
  private baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  // 百炼可用的视觉模型：qwen3-vl-plus（8B 级 404，plus 为当前可用档）
  private model = 'qwen3-vl-plus';

  constructor() {
    this.apiKey = process.env.QWEN_API_KEY || '';
    const m = process.env.QWEN_MODEL;
    if (m) this.model = m;
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  /**
   * 在截图中定位目标。
   * @param target 目标描述（如 "微信发送按钮"、"Issues 标签"）
   * @returns 屏幕 DIP 矩形；未找到 / 调用失败返回 null
   */
  async locate(target: string, shot: ScreenShot): Promise<LocateResult | null> {
    if (!this.apiKey) return null;
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: shot.dataUrl } },
                { type: 'text', text: `Find: ${target}` },
              ],
            },
          ],
          temperature: 0,
        }),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) return null;
      const boxes = this.parseBoxes(text);
      if (boxes.length === 0) return null;

      // 相对坐标(0-1000) → 截图像素 → 屏幕 DIP
      const b = boxes[0].bbox_2d;
      if (!b || b.length !== 4) return null;
      const [rx1, ry1, rx2, ry2] = b.map((v) => Math.max(0, Math.min(1000, v)));
      const x1 = (rx1 / 1000) * shot.screenWidth;
      const y1 = (ry1 / 1000) * shot.screenHeight;
      const x2 = (rx2 / 1000) * shot.screenWidth;
      const y2 = (ry2 / 1000) * shot.screenHeight;
      const rect: Rect = {
        x: Math.round(x1),
        y: Math.round(y1),
        width: Math.max(8, Math.round(x2 - x1)),
        height: Math.max(8, Math.round(y2 - y1)),
      };
      return { rect, label: boxes[0].label || null };
    } catch {
      return null;
    }
  }

  /** 解析模型输出（容忍 ```json 围栏与前后杂文本） */
  private parseBoxes(text: string): QwenBox[] {
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    try {
      const arr = JSON.parse(t.slice(start, end + 1));
      return Array.isArray(arr) ? (arr as QwenBox[]) : [];
    } catch {
      return [];
    }
  }
}
