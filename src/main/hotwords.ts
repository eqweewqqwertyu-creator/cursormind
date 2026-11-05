import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/**
 * 语音热词表：对标 heyClicky 的 dictation_custom_words。
 *
 * qwen3-asr-flash 原生接口不开放动态热词，采用「转写后近似校正」：
 * 对每个热词，在识别文本里找等长且编辑距离 ≤1 的片段，命中即替换为热词。
 * 只对长度 ≥2 的热词生效（单字误伤率太高）。
 */

const DEFAULT_HOTWORDS = ['枸杞子', '灵标', 'CursorMind'];

function hotPath(): string {
  return path.join(app.getPath('userData'), 'voice-hotwords.json');
}

export function loadHotwords(): string[] {
  try {
    const p = hotPath();
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(DEFAULT_HOTWORDS, null, 2), 'utf-8');
      return [...DEFAULT_HOTWORDS];
    }
    const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(arr) ? arr.filter((w) => typeof w === 'string' && w.trim()) : [];
  } catch {
    return [...DEFAULT_HOTWORDS];
  }
}

export function saveHotwords(words: string[]): void {
  try {
    fs.mkdirSync(path.dirname(hotPath()), { recursive: true });
    const clean = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
    fs.writeFileSync(hotPath(), JSON.stringify(clean, null, 2), 'utf-8');
  } catch { /* 忽略 */ }
}

/** 编辑距离（仅算 ≤1 的快速判定：0 或 1 个字符差异） */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  if (i < a.length || j < b.length) diff++;
  return diff <= 1;
}

/** 热词近似校正：返回修正后的文本 */
export function correctHotwords(text: string): string {
  if (!text) return text;
  let out = text;
  for (const word of loadHotwords()) {
    if (word.length < 2) continue;
    if (out.includes(word)) continue; // 已准确，无需校正
    const L = word.length;
    // 滑窗找等长近似片段
    for (let i = 0; i + L <= out.length; i++) {
      const seg = out.slice(i, i + L);
      if (withinOneEdit(seg, word)) {
        out = out.slice(0, i) + word + out.slice(i + L);
        break;
      }
    }
  }
  return out;
}
