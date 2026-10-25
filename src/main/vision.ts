/**
 * 视觉 / 意图理解：deepseek-flash（文本）。有 API key 时启用，
 * 否则 Brain 降级到知识库关键词匹配。图像理解（视觉只做语义）阶段 3 接入。
 */
export class Vision {
  private apiKey = process.env.DEEPSEEK_API_KEY || '';
  private baseUrl = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
  private model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  get enabled(): boolean {
    return !!this.apiKey;
  }

  /** 把用户问句分类到候选功能 id 之一；失败返回 null */
  async classifyIntent(question: string, candidates: string[]): Promise<string | null> {
    if (!this.apiKey || candidates.length === 0) return null;
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
            {
              role: 'system',
              content:
                '你是软件功能意图分类器。用户会描述想找的功能，你从候选功能中选一个最匹配的，只返回它的 id，不要任何解释或标点。',
            },
            { role: 'user', content: `问题：${question}\n候选 id：${candidates.join(', ')}` },
          ],
          temperature: 0,
          max_tokens: 16,
        }),
      });
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) return null;
      const hit = candidates.find((c) => text.toLowerCase().includes(c.toLowerCase()));
      return hit || null;
    } catch {
      return null;
    }
  }
}
