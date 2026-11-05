import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app, Notification } from 'electron';
import { sendCommand } from './overlay';
import { showReply, getPanel } from './panel';
import { speak } from './tts';
import { setTrayBusy } from './tray';
import { getMemoryBrief, recordTask, learnFromTask } from './userMemory';
import { feishuActive, feishuAuthHeader, getMcp, FEISHU_URL } from './mcpConfig';
import { syncTaskstrip } from './taskstrip';

/**
 * DeepSeek Harness 执行引擎（dsh headless + DeepSeek API）——多 Agent 后台作业版。
 *
 * 官方开源框架 @deepseek-ai/dsh（MIT，「一切皆插件」架构，Cordis 微内核驱动），
 * headless profile 一次性应答任务：答案上 stdout、诊断上 stderr，
 * --json 输出 NDJSON 事件流（session/status/thinking/tool_call/tool_result/text/final）。
 *
 * 与 agent.ts（视觉教学引擎）分工：
 *  - agent.ts：屏幕上的「教我用」——截图、locate、指路，人在回路；
 *  - dshRunner：机器上的「帮我干」——建文件、写代码、跑命令，harness 交付。
 *
 * 多任务模型（v2）：单任务互斥 → 多 Agent 并行后台作业。
 *  - 每个 BgTask 一个独立 dsh 进程（独立模型会话、独立安全闸、独立超时），互不取消；
 *  - 并发上限 MAX_RUNNING（默认 3，CURSORMIND_BG_MAX 可调），超出的排队，完成自动补位；
 *  - 屏幕右上角有后台任务条（taskstrip.ts）实时展示进度；
 *  - 完成反馈低干扰：系统通知 + 语音短播报 + 任务条；面板在看才直接推结果，
 *    面板隐藏时不弹窗打断（点任务条「看结果」再展开）；
 *  - Esc / 新对话 不杀后台任务（后台作业独立生命周期），取消走任务条或托盘。
 *
 * 引擎唤起：项目依赖固化（npm i @deepseek-ai/dsh），spawn node 直调
 * node_modules/@deepseek-ai/dsh/lib/bin.js，跳过 npx 解析层与 cmd /c 外壳；
 * 依赖缺失时降级 npx（首次冷启动慢但可用）。
 *
 * 技能注入：skills 目录下的 <技能名>/SKILL.md（frontmatter 带 name/description/keywords），
 * 任务文本命中关键词的技能拼进 stdin 任务头（对标 heyClicky SynchronizeSkills
 * 的按需加载：不常驻全部，只注入相关的）。
 */

const DSH_PACKAGE = process.env.CURSORMIND_DSH_PACKAGE || '@deepseek-ai/dsh';

/** 若启用飞书 MCP（开关 + token），生成 dsh 配置 patch 文件并返回路径；未启用/未就绪返回 null。
 *  注意：dsh 的 `--patch` 只能「覆盖已存在插件条目」、不能新增插件——要让 lark streamable-http
 *  服务器真正生效，需先把 `@deepseek-ai/dsh-mcp-client` 装进 headless profile（dsh plugin add），
 *  再以 patch 覆盖其 config。该步骤需配合飞书 token 一起调通；当前在 token/插件未就绪前**不注入**，
 *  避免 dsh 因 patch 目标缺失而启动报错。 */
const MCP_PATCH_FILE = path.join(__dirname, '..', '..', '.temp', 'mcp-lark.yml');
function buildMcpPatch(): string | null {
  if (!feishuActive()) return null;
  const auth = feishuAuthHeader();
  const tools = getMcp().feishu.tools;
  if (!auth || !tools) return null;
  // 注入通道未就绪（需先 dsh plugin add @deepseek-ai/dsh-mcp-client 到 headless profile）。
  // 拿到飞书 token 后在此放开注入并端到端验证；放开前返回 null 保证 dsh 启动不受影响。
  logEvent('MCP 已开启（lark token 已配置），注入通道待就绪——暂不注入');
  return null;
}

/** dsh 入口解析：项目依赖直调（快）优先，缺失时降级 npx（慢但可用）。
 *  直调用系统 node（PATH 解析，npm/npx 依赖它必在）；不能用 process.execPath——
 *  Electron 主进程里它是 electron.exe，且本构建 ELECTRON_RUN_AS_NODE 被 fuses 禁用。 */
function resolveDshCommand(): { kind: 'direct' | 'npx'; cmd: string; args: string[] } {
  // dist/main/index.js → ../../node_modules/@deepseek-ai/dsh/lib/bin.js
  const binJs = path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const patch = buildMcpPatch();
  if (fs.existsSync(binJs)) {
    const args = [binJs, '--profile', 'headless', '--json'];
    if (patch) args.push('--patch', patch);
    args.push('-');
    return { kind: 'direct', cmd: 'node', args };
  }
  // 降级：npx 是 .cmd，Node 20+ 禁直 spawn .cmd，经 cmd /c 中转
  const nargs = ['/c', 'npx', '-y', DSH_PACKAGE, '--profile', 'headless', '--json'];
  if (patch) nargs.push('--patch', patch);
  nargs.push('-');
  return { kind: 'npx', cmd: 'cmd.exe', args: nargs };
}

// ── 技能加载（对标 heyClicky SynchronizeSkills：任务时按需挑选，不常驻）──
interface SkillEntry {
  dir: string;
  name: string;
  keywords: string[];
  body: string;
}

/** 扫描 skills 下各技能目录的 SKILL.md，解析 frontmatter；首次读取后缓存（技能文件极少变） */
let skillCache: SkillEntry[] | null = null;
function loadSkills(): SkillEntry[] {
  if (skillCache) return skillCache;
  const skillsRoot = path.join(__dirname, '..', '..', 'skills');
  const entries: SkillEntry[] = [];
  try {
    for (const d of fs.readdirSync(skillsRoot)) {
      const md = path.join(skillsRoot, d, 'SKILL.md');
      if (!fs.existsSync(md)) continue;
      const raw = fs.readFileSync(md, 'utf-8');
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!m) continue;
      const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim() || d;
      const kwLine = (m[1].match(/^keywords:\s*(.+)$/m) || [])[1] || '';
      const keywords = kwLine.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      entries.push({ dir: d, name, keywords, body: m[2].trim() });
    }
  } catch { /* skills 目录不存在：零技能，纯任务直跑 */ }
  skillCache = entries;
  return entries;
}

/** 任务文本命中哪些技能：任一关键词出现在任务里即命中 */
function matchSkills(question: string): SkillEntry[] {
  return loadSkills().filter(s => s.keywords.some(k => k && question.includes(k)));
}

/** 拼接技能上下文与任务文本，作为 stdin 任务头（含用户档案摘要） */
function composeTaskInput(question: string): { task: string; skills: string[] } {
  const hits = matchSkills(question);
  const memory = getMemoryBrief();
  const parts: string[] = [];
  if (memory) parts.push(`【用户档案——按此称呼与偏好行事】\n\n${memory}`);
  if (hits.length > 0) {
    parts.push(`【灵标技能规范——遵循后再干活】\n\n${hits.map(s => `# 技能：${s.name}\n\n${s.body}`).join('\n\n---\n\n')}`);
  }
  parts.push(`【用户任务】\n${question}`);
  return { task: parts.join('\n\n---\n\n'), skills: hits.map(s => s.name) };
}

/** 引擎事件同步落盘（与 hotkey.log 同源，便于无 GUI 验证） */
const logFile = path.join(__dirname, '..', '..', '.temp', 'hotkey.log');
function logEvent(msg: string): void {
  try { fs.appendFileSync(logFile, '[dsh] ' + msg + '\n'); } catch { /* 忽略 */ }
}

/** 任务默认工作目录：桌面下的专属工作目录（用户能直接看到交付物） */
function workspaceDir(): string {
  const dir = path.join(app.getPath('desktop'), '灵标工作区');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function killTree(pid: number): void {
  try {
    // cmd /c npx 是进程树外壳（cmd→node→dsh），只 kill 外壳会留孤儿，须树杀
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } catch { /* 已退出 */ }
}

/** 工作任务意图：直接动手类（写/建/生成 + 文件/脚本/代码等宾语）；「教我/怎么」是教学，走视觉引擎 */
const TASK_RE =
  /(写|创建|生成|新建|做个|做一份|建立一个|整理|导出|批量)(一个|一份|个|一下)?[^。？！?]{0,24}(脚本|代码|文件|文件夹|目录|程序|网页|页面|html|excel|word|txt|json|csv|md|文档|清单|列表|报告|表格|demo|示例)/i;
const TEACH_RE = /(教我|怎么教|怎么用|如何|怎么操作|在哪|哪里|是什么|什么意思|什么用)/;

export function isWorkTaskIntent(t: string): boolean {
  if (TEACH_RE.test(t)) return false; // 「教我怎么写脚本」→ 视觉引导，不代干
  return TASK_RE.test(t);
}

function truncate(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 风险闸：删除/外发类命令。任务文本已明确要求且带「确认」则放行（用户说了就干）。 */
const DANGER_RE = /(Remove-Item|\brm\s+-|\bdel\s+|\brd\s+\/s|format\s+[a-z]:|Clear-Content|Invoke-RestMethod\s+.*-Method\s+Post|Invoke-WebRequest\s+.*-Method\s+Post|curl\s+.*-X\s*POST|Send-MailMessage)/i;

function isConfirmed(t: string): boolean {
  return /确认|已经确认|确认删除|确认发送|同意/.test(t);
}

/** 工具调用摘要给用户看：write→文件名、pwsh→命令、read/glob→目标 */
function toolDigest(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'write':
      return '写文件 ' + path.basename(String(input.file_path || ''));
    case 'read':
      return '读 ' + path.basename(String(input.file_path || ''));
    case 'glob':
      return '找 ' + String(input.pattern || '');
    case 'pwsh':
      return truncate(String(input.command || input.description || ''), 36);
    default:
      return tool;
  }
}

/** 语音朗读前剥掉 markdown 代码围栏（代码块读音会怪） */
function stripCodeFences(text: string): string {
  return (text || '').replace(/```[\s\S]*?```/g, '').trim();
}

// ── 多任务后台作业 ──────────────────────────────────────────

/** 后台任务（多 Agent 作业单元：一个任务 = 一个独立 dsh 进程 = 一个独立模型会话） */
export interface BgTask {
  id: string;
  /** 展示标题（问题截断） */
  title: string;
  /** 原始任务文本（记忆回写与安全闸用） */
  question: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';
  /** 已执行到第几步（tool_call 计数） */
  step: number;
  finalText: string;
  inTok: number;
  outTok: number;
  skills: string[];
  startedAt: number;
  endedAt: number | null;
  /** 进程引用（取消用；不出窗口） */
  proc: ChildProcess | null;
  /** 内部标记：用户请求取消 / 已从列表移除（收尾静默） */
  cancelRequested: boolean;
  removed: boolean;
}

/** 推给任务条的任务视图（剥掉进程引用等主进程内部字段） */
export interface BgTaskView {
  id: string;
  title: string;
  status: BgTask['status'];
  step: number;
  finalText: string;
  inTok: number;
  outTok: number;
  skills: string[];
  startedAt: number;
  endedAt: number | null;
}

/** 任务列表（source of truth）；已完成的留在列表里等用户「清除已完成」 */
const tasks: BgTask[] = [];
/** 并发上限：默认 3 个 dsh 进程并行（各自独立模型会话）；CURSORMIND_BG_MAX 可调 */
const MAX_RUNNING = Math.max(1, Number(process.env.CURSORMIND_BG_MAX || 3));
let nextSeq = 1;

function view(t: BgTask): BgTaskView {
  return {
    id: t.id, title: t.title, status: t.status, step: t.step, finalText: t.finalText,
    inTok: t.inTok, outTok: t.outTok, skills: t.skills, startedAt: t.startedAt, endedAt: t.endedAt,
  };
}

function syncAll(): void {
  syncTaskstrip(tasks.map(view));
}

/** 派发任务（路由入口，签名与旧单任务版一致）：
 *  立即反馈「后台开工」，任务进列表；有空槽位就开跑，满员则排队。 */
export function runDshTask(question: string): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    sendCommand({ type: 'bubble', text: '未配置 DeepSeek API Key' });
    return;
  }
  const running = tasks.filter(t => t.status === 'running').length;
  const queued = running >= MAX_RUNNING;
  const task: BgTask = {
    id: 'bg-' + nextSeq++,
    title: truncate(question, 16),
    question,
    status: 'queued',
    step: 0,
    finalText: '',
    inTok: 0,
    outTok: 0,
    skills: [],
    startedAt: 0,
    endedAt: null,
    proc: null,
    cancelRequested: false,
    removed: false,
  };
  tasks.push(task);
  logEvent('派发 #' + task.id + (queued ? '（排队，' + running + '/' + MAX_RUNNING + ' 满员）' : '')
    + (task.skills.length ? '' : '') + ': ' + truncate(question, 40));
  sendCommand({
    type: 'bubble',
    text: queued ? '收到，排队中：' + task.title : '收到，后台开工：' + task.title,
  });
  dispatchNext();
}

/** 调度：空槽位补位启动排队任务（保持到达顺序） */
function dispatchNext(): void {
  let running = tasks.filter(t => t.status === 'running').length;
  for (const t of tasks) {
    if (running >= MAX_RUNNING) break;
    if (t.status !== 'queued') continue;
    running++;
    void startTask(t);
  }
}

/** 启动一个任务：独立进程跑 dsh headless；直调未连上自动降级 npx 重试一次 */
async function startTask(task: BgTask): Promise<void> {
  task.status = 'running';
  task.startedAt = Date.now();
  setTrayBusy(true, '后台作业');
  const cwd = workspaceDir();
  const { task: input, skills } = composeTaskInput(task.question);
  task.skills = skills;
  logEvent('#' + task.id + ' 启动: ' + (skills.length ? 'skills=' + skills.join(',') : 'skills=无')
    + ' task=' + truncate(task.question, 40));

  let dshCmd = resolveDshCommand();
  let out = await execOnce(task, dshCmd, input, cwd);

  // 直调未连上会话（依赖损坏/插件激活失败）→ 自动降级 npx 重跑一次
  if (!out.sessionLogged && !task.cancelRequested && !task.removed && dshCmd.kind === 'direct') {
    logEvent('#' + task.id + ' 直调未连上，降级 npx 重试');
    const nargs = ['/c', 'npx', '-y', DSH_PACKAGE, '--profile', 'headless', '--json'];
    const patch = buildMcpPatch();
    if (patch) nargs.push('--patch', patch);
    nargs.push('-');
    out = await execOnce(task, { kind: 'npx', cmd: 'cmd.exe', args: nargs }, input, cwd);
  }

  finishTask(task, out);
}

interface DshUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}
interface DshEvent {
  type?: string;
  sessionId?: string;
  phase?: string;
  text?: string;
  callId?: string;
  tool?: string;
  input?: Record<string, unknown>;
  status?: string;
  usage?: DshUsage;
}

interface RunOutcome {
  sessionLogged: boolean; // dsh 是否真正连上（区分「跑完」与「根本没起来」）
  blocked?: boolean; // 安全闸中止
  finalText: string;
  inTok: number;
  outTok: number;
}

/** 单任务 spawn 执行：NDJSON 事件流实时更新任务对象（步骤/结果/token），
 *  安全闸与超时按任务独立；取消经 cancelRequested 标记。 */
function execOnce(
  task: BgTask,
  dshCmd: { kind: 'direct' | 'npx'; cmd: string; args: string[] },
  input: string,
  cwd: string
): Promise<RunOutcome> {
  const cancelled = (): boolean => task.cancelRequested;
  logEvent('#' + task.id + ' spawn ' + dshCmd.kind + '（' + (dshCmd.kind === 'direct' ? 'bin.js直调' : 'npx') + '）');

  return new Promise<RunOutcome>((resolve) => {
    const outcome: RunOutcome = { sessionLogged: false, finalText: '', inTok: 0, outTok: 0 };
    let proc: ChildProcess;
    try {
      task.proc = proc = spawn(dshCmd.cmd, dshCmd.args, {
        cwd, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      logEvent('#' + task.id + ' spawn 异常: ' + truncate(String(e), 60));
      resolve(outcome);
      return;
    }

    const t0 = Date.now();
    try {
      if (proc.stdin) {
        proc.stdin.write(input, 'utf-8');
        proc.stdin.end();
      }
    } catch { /* stdin 关闭异常不阻塞 */ }

    const onLine = (line: string): void => {
      const s = line.trim();
      if (!s.startsWith('{')) return;
      let ev: DshEvent;
      try { ev = JSON.parse(s); } catch { return; }

      switch (ev.type) {
        case 'session':
          outcome.sessionLogged = true;
          logEvent('#' + task.id + ' session ' + (ev.sessionId || ''));
          break;
        case 'tool_call':
          if (ev.tool) {
            task.step++;
            logEvent('#' + task.id + ' 执行: ' + toolDigest(ev.tool, ev.input || {}));
            syncAll(); // 任务条步骤实时更新
            // A4 安全闸：删除/外发类命令且任务未明确确认 → 中止该任务（不影响其他任务）
            const cmd = String((ev.input || {}).command || '');
            if (ev.tool === 'pwsh' && DANGER_RE.test(cmd) && !isConfirmed(task.question)) {
              logEvent('#' + task.id + ' 安全拦截: ' + truncate(cmd, 80));
              outcome.blocked = true;
              if (proc.pid) killTree(proc.pid);
            }
          }
          break;
        case 'text':
          if (ev.text) outcome.finalText = ev.text; // 中间叙述，最终由 final 覆盖
          break;
        case 'final':
          outcome.finalText = ev.text || outcome.finalText;
          logEvent('#' + task.id + ' final: ' + truncate(outcome.finalText, 80));
          break;
        case 'status':
          if (ev.phase === 'step_end' && ev.usage) {
            outcome.inTok += ev.usage.inputTokens || 0;
            outcome.outTok += ev.usage.outputTokens || 0;
          }
          break;
      }
    };

    let buf = '';
    if (proc.stdout) {
      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk: string) => {
        if (cancelled()) return;
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const l of lines) onLine(l);
      });
    }
    if (proc.stderr) {
      proc.stderr.setEncoding('utf-8');
      proc.stderr.on('data', (chunk: string) => {
        const t = (chunk || '').trim();
        if (t) logEvent('#' + task.id + ' stderr: ' + truncate(t, 100));
      });
    }

    // 硬超时：harness 卡死不拖垮精灵（默认 3 分钟，按任务独立）
    const timeoutMs = Number(process.env.CURSORMIND_DSH_TIMEOUT_MS || 180000);
    const timer = setTimeout(() => {
      if (!cancelled() && proc.pid) {
        logEvent('#' + task.id + ' 超时终止');
        killTree(proc.pid);
      }
    }, timeoutMs);

    proc.on('error', (e) => {
      clearTimeout(timer);
      logEvent('#' + task.id + ' 进程错误: ' + truncate(e.message, 60));
      resolve(outcome);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      task.proc = null;
      logEvent('#' + task.id + ' 进程退出: code=' + code + ' 耗时=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      resolve(outcome);
    });
  });
}

/** 任务收尾：归档状态 + 低干扰反馈（系统通知 + 语音短播报 + 任务条；
 *  面板可见才直接推结果，隐藏时不弹窗打断——点任务条「看结果」再看）。 */
function finishTask(task: BgTask, out: RunOutcome): void {
  task.endedAt = Date.now();
  task.finalText = (out.finalText || '').trim();
  task.inTok = out.inTok;
  task.outTok = out.outTok;
  if (task.status === 'running') {
    if (task.cancelRequested) task.status = 'cancelled';
    else if (out.blocked) task.status = 'blocked';
    else if (task.finalText) task.status = 'done';
    else task.status = 'failed';
  }
  logEvent('#' + task.id + ' 收尾: ' + task.status + ' in=' + task.inTok + ' out=' + task.outTok);

  if (task.removed) {
    // 用户已从列表删除：安静收尾，不发通知
    setTrayBusy(false);
    syncAll();
    dispatchNext();
    return;
  }

  const tokens = task.inTok + task.outTok;
  const usageNote = tokens > 0 ? `（${tokens.toLocaleString()} tokens）` : '';

  switch (task.status) {
    case 'done': {
      const full = task.finalText + (usageNote ? `\n\n${usageNote}` : '');
      // 面板在看 → 直接推结果；面板隐藏 → 不弹窗打断，通知 + 语音 + 任务条提示
      const panel = getPanel();
      if (panel && !panel.isDestroyed() && panel.isVisible()) {
        showReply(full);
      }
      notify('后台任务完成：' + task.title, '点任务条可看结果' + (usageNote ? ' ' + usageNote : ''));
      speak('后台任务完成：' + task.title);
      sendCommand({ type: 'bubble', text: truncate('完成：' + task.title, 30) });
      // A1 记忆回写：最近任务同步追记，档案主体异步由 DeepSeek 更新（fire-and-forget）
      recordTask(task.question, stripCodeFences(task.finalText));
      learnFromTask(task.question, task.finalText);
      break;
    }
    case 'blocked':
      notify('后台任务已拦下：' + task.title, '检测到删除或外发操作，该任务已中止');
      sendCommand({ type: 'bubble', text: '检测到删除或外发，任务已拦下' });
      break;
    case 'failed':
      notify('后台任务失败：' + task.title, '引擎未产出结果（检查 node 或依赖）');
      sendCommand({ type: 'bubble', text: truncate('失败：' + task.title, 30) });
      break;
    case 'cancelled':
      sendCommand({ type: 'bubble', text: truncate('已取消：' + task.title, 30) });
      break;
  }

  setTrayBusy(false);
  syncAll();
  dispatchNext(); // 空出槽位，补位排队任务
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title: '灵标 · ' + title, body }).show();
  } catch { /* 通知失败静默 */ }
}

// ── 任务管理（任务条 / 托盘调用）──────────────────────────────

export function getBgTasks(): BgTaskView[] {
  return tasks.map(view);
}

function findTask(id: string): BgTask | null {
  return tasks.find(t => t.id === id) || null;
}

/** 取消单个任务：排队中直接撤，运行中树杀进程（close 回调安静归档） */
export function cancelBgTask(id: string): void {
  const task = findTask(id);
  if (!task) return;
  if (task.status === 'queued') {
    task.status = 'cancelled';
    task.endedAt = Date.now();
    logEvent('#' + id + ' 排队撤销');
    syncAll();
    return;
  }
  if (task.status === 'running') {
    task.cancelRequested = true;
    if (task.proc && task.proc.pid) killTree(task.proc.pid);
    logEvent('#' + id + ' 用户取消');
  }
}

/** 从列表移除（运行中的先取消；收尾静默不通知） */
export function removeBgTask(id: string): void {
  const task = findTask(id);
  if (!task) return;
  task.removed = true;
  if (task.status === 'running') {
    task.cancelRequested = true;
    if (task.proc && task.proc.pid) killTree(task.proc.pid);
  }
  tasks.splice(tasks.indexOf(task), 1);
  logEvent('#' + id + ' 从列表移除');
  syncAll();
}

/** 清除已完成/已取消的任务（运行中与排队中的保留） */
export function clearDoneBgTasks(): void {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const s = tasks[i].status;
    if (s !== 'running' && s !== 'queued') tasks.splice(i, 1);
  }
  syncAll();
}

/** 看结果：用户主动点击 → 展开提问面板展示该任务的完整交付 */
export function viewBgTaskResult(id: string): void {
  const task = findTask(id);
  if (!task) return;
  const tokens = task.inTok + task.outTok;
  const usageNote = tokens > 0 ? `（${tokens.toLocaleString()} tokens）` : '';
  showReply((task.finalText || '（该任务没有产出文本）') + (usageNote ? `\n\n${usageNote}` : ''));
}

/** 全部取消并清空列表（仅退出时调用） */
export function cancelAllBgTasks(): void {
  for (const t of tasks) {
    if (t.status === 'running' || t.status === 'queued') {
      t.cancelRequested = true;
      t.removed = true;
      if (t.proc && t.proc.pid) killTree(t.proc.pid);
    }
  }
  tasks.length = 0;
}
