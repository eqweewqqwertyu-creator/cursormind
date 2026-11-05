import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/**
 * 用户记忆（完整动态档案）：对标 heyClicky 的 user-memory 机制。
 *
 * - 档案存 userData/user-memory.md（人可读可改），结构：身份/角色背景/目标/常用工具/习惯/沟通风格/当前焦点/最近任务
 * - 注入：dsh 任务头拼「档案摘要」（≤500 字，控制 token）
 * - 回写：每轮任务完成 → 同步追加「最近任务」；异步调 DeepSeek 更新档案主体（fire-and-forget，失败静默）
 * - 原则：只写有依据的信息（任务文本/交付结果/用户明说），标注推断来源；不存任何密钥
 */

const MAX_BRIEF_CHARS = 500;
const MAX_RECENT_TASKS = 10;
const MAX_DOC_CHARS = 3000;

function memPath(): string {
  return path.join(app.getPath('userData'), 'user-memory.md');
}

const DEFAULT_DOC = `# 灵标知道的关于你的事

## 身份
- （等你告诉我称呼、身份或偏好，我会记在这里）

## 角色与背景
- 

## 目标
- 

## 常用工具与应用
- 

## 使用习惯
- 

## 沟通风格
- 

## 当前焦点
- 

## 最近任务
`;

export function loadMemory(): string {
  try {
    const p = memPath();
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, DEFAULT_DOC, 'utf-8');
      return DEFAULT_DOC;
    }
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function saveMemory(doc: string): void {
  try {
    fs.mkdirSync(path.dirname(memPath()), { recursive: true });
    fs.writeFileSync(memPath(), doc.length > MAX_DOC_CHARS ? doc.slice(0, MAX_DOC_CHARS) : doc, 'utf-8');
  } catch { /* 记忆写失败不影响主链路 */ }
}

/** 注入用摘要：去掉「最近任务」章节（任务历史单独控制条数），截断到上限 */
export function getMemoryBrief(): string {
  const doc = loadMemory();
  if (!doc) return '';
  const withoutRecent = doc.split('## 最近任务')[0].trim();
  const brief = withoutRecent.replace(/^# 灵标知道的关于你的事\s*/, '').trim();
  // 全是空模板（没有实质内容）就不注入，省 token
  const meaningful = brief.replace(/[#\-\s（）()等。]/g, '');
  if (meaningful.length < 10) return '';
  return brief.length > MAX_BRIEF_CHARS ? brief.slice(0, MAX_BRIEF_CHARS) + '…' : brief;
}

/** 同步追加「最近任务」条目（轻量，不调模型）；保留最近 10 条 */
export function recordTask(task: string, result: string): void {
  try {
    const doc = loadMemory();
    const line = `- [${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}] ${task.slice(0, 40)} → ${result.replace(/\s+/g, ' ').slice(0, 60)}`;
    const parts = doc.split('## 最近任务');
    const head = parts[0];
    const tail = parts[1] || '';
    const lines = (tail || '\n').split('\n').filter((l) => l.trim().startsWith('-'));
    lines.push(line);
    const kept = lines.slice(-MAX_RECENT_TASKS);
    saveMemory(head + '## 最近任务\n' + kept.join('\n') + '\n');
  } catch { /* 忽略 */ }
}

/**
 * 异步学习：把本轮任务交给 DeepSeek 更新档案主体（身份/目标/习惯等）。
 * fire-and-forget：不阻塞任务交付；失败只写不進日志也不报错。
 */
export function learnFromTask(task: string, result: string): void {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return;
  const baseUrl = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
  const model = process.env.DEEPSEEK_MEMORY_MODEL || 'deepseek-chat';
  const doc = loadMemory();
  const prompt = [
    '你是用户档案管理员。根据本轮任务更新下面这份用户档案，只保留你的确有依据的信息；没有依据的字段保持原样或留空。',
    '规则：',
    '1. 只写从任务文本或交付结果能确认的事实；从桌面/文件名推断的信息要标注（推断）。',
    '2. 不记录密钥、密码、身份证号等敏感信息。',
    '3. 档案总长不超过 2000 字，超出时压缩旧的「最近任务」而非删掉身份类信息。',
    '4. 输出完整的更新后档案 markdown 全文，不要任何解释。',
    '',
    '【当前档案】',
    doc,
    '',
    '【本轮任务】',
    task,
    '',
    '【交付结果】',
    result.slice(0, 800),
  ].join('\n');

  void (async () => {
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1200,
        }),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const updated = data.choices?.[0]?.message?.content?.trim();
      if (updated && updated.includes('## ')) saveMemory(updated);
    } catch { /* 静默 */ }
  })();
}
