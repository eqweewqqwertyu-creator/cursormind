/**
 * 语音识别（ASR）：百炼 qwen3-asr-flash 原生 multimodal-generation 接口。
 * 渲染层录音转 16k wav → base64 data URL 直传（本地录音无需公网 URL）→ 单次调用返回文本。
 * 与 Web Speech API（走 Google，国内不可达）不同，百炼国内直连。
 * 实测（2026-10-27，TTS 合成语音验证）：
 * - content item 必须是 { type:'audio', audio:dataUrl }；input_audio 是 OpenAI 兼容模式字段，原生接口不认。
 * - 响应文本在 output.choices[0].message.content（数组 [{text}] 或字符串）；
 *   文档写的 output.output.sentence.text 结构不对。
 */

const ASR_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const ASR_MODEL = process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash';

interface AsrResponse {
  output?: {
    choices?: Array<{
      message?: {
        content?: string | Array<{ text?: string }>;
      };
    }>;
  };
}

/** 成功返回 [识别文本, null]，失败返回 [null, 失败原因]（由调用方写日志） */
export async function transcribe(audioDataUrl: string): Promise<[string | null, string | null]> {
  const key = process.env.QWEN_API_KEY;
  if (!key) return [null, '无 QWEN_API_KEY'];
  if (!audioDataUrl.startsWith('data:')) return [null, '音频非 data URL'];
  try {
    const resp = await fetch(ASR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'X-DashScope-SSE': 'disable',
      },
      body: JSON.stringify({
        model: ASR_MODEL,
        input: {
          messages: [
            {
              role: 'user',
              content: [{ type: 'audio', audio: audioDataUrl }],
            },
          ],
        },
        parameters: { format: 'wav', sample_rate: '16000' },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return [null, `HTTP ${resp.status}: ${body.slice(0, 300)}`];
    }
    const data = (await resp.json()) as AsrResponse;
    const raw = data.output?.choices?.[0]?.message?.content;
    const text = (
      Array.isArray(raw)
        ? raw.map((c) => c.text || '').join('')
        : raw || ''
    ).trim();
    if (!text) return [null, '接口 200 但无文本（可能没录到声音）'];
    return [text, null];
  } catch (e) {
    return [null, '异常: ' + (e instanceof Error ? e.message : String(e))];
  }
}
