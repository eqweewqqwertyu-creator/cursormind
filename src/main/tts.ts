/**
 * 语音输出：调阿里百炼 Qwen-TTS 合成语音，推送到面板渲染层播放。
 * 无 Key 或失败时静默降级（纯文字回复），符合"无 Key 走兜底"的项目原则。
 */
import { getPanel } from './panel';

const TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const TTS_MODEL = 'qwen3-tts-flash';

interface TtsResponse {
  output?: { audio?: { url?: string; data?: string } };
}

let voiceOn = true; // 设置面板开关（默认开）

export function setVoice(on: boolean): void {
  voiceOn = on;
}

export function isVoiceOn(): boolean {
  return voiceOn;
}

/** 播放音频：data: URL 直接推；http URL 让渲染层播（sandbox 无 Node，不能用主进程下载文件） */
export function speak(text: string): void {
  const t = (text || '').trim();
  if (!t || !voiceOn) return;
  const key = process.env.QWEN_API_KEY;
  if (!key) return; // 无 Key 静默降级：文字已有，不播语音

  void synthesize(t)
    .then((audio) => {
      if (audio) pushAudio(audio);
    })
    .catch(() => {
      /* 合成失败静默：文字回复已在屏幕上 */
    });
}

async function synthesize(text: string): Promise<string | null> {
  try {
    const resp = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key()}`,
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: {
          text: truncateForTts(text, 120), // 长文截断：TTS 按字符计费且演示场景短句为主
        },
        parameters: { voice: 'Cherry' },
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as TtsResponse;
    const url = data.output?.audio?.url || '';
    const dataUrl = data.output?.audio?.data || '';
    return url || dataUrl || null;
  } catch {
    return null;
  }
}

function pushAudio(src: string): void {
  const panel = getPanel();
  if (!panel || panel.isDestroyed()) return;
  panel.webContents.send('panel:audio', src);
}

function key(): string {
  return process.env.QWEN_API_KEY || '';
}

function truncateForTts(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) : clean;
}
