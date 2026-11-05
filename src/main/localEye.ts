import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ScreenShot } from './screenshot';

/**
 * 本地眼睛（离线元素层）：OmniParser V2 YOLO 检测 + Windows 自带 OCR 标签。
 *
 * 七步计划定位：
 *  - 截图复用 electron desktopCapturer（不再折腾 DXGI）；
 *  - 检测器 = OmniParser V2 的 YOLO（MIT，本地 CPU 推理，200-500ms）；
 *  - 标签 = Windows.Media.Ocr（免装重型 OCR 依赖，中文可用）；
 *  - 用途：VlmLocator 前置快检——命中直接返回，未命中回落 Qwen3-VL。
 *
 * 启用：环境变量 CURSORMIND_LOCAL_EYE=1（默认关闭，失败自动回落，不影响主链路）。
 * 目录：CURSORMIND_LOCAL_EYE_DIR > <项目根>/tools/local-eye > <项目根>/.temp/omniparser
 */

export interface LocalElement {
  label: string;
  x1: number; // 相对坐标 0-1000
  y1: number;
  x2: number;
  y2: number;
  conf: number;
}

const ROOT = path.join(__dirname, '..', '..');

function eyeDir(): string | null {
  const cands = [
    process.env.CURSORMIND_LOCAL_EYE_DIR,
    path.join(ROOT, 'tools', 'local-eye'),
    path.join(ROOT, '.temp', 'omniparser'),
  ].filter(Boolean) as string[];
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'detect.py')) && fs.existsSync(path.join(d, 'weights', 'icon_detect.pt'))) {
      return d;
    }
  }
  return null;
}

function venvPython(dir: string): string {
  const p = path.join(dir, '.venv', 'Scripts', 'python.exe');
  return fs.existsSync(p) ? p : 'python';
}

export function localEyeEnabled(): boolean {
  return process.env.CURSORMIND_LOCAL_EYE === '1' && eyeDir() !== null;
}

// ── 常驻检测服务（serve.py）：模型只加载一次，之后每帧 300-500ms ──
const SERVICE_PORT = 7788;
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
let serviceProc: import('child_process').ChildProcess | null = null;
let serviceReady: Promise<boolean> | null = null;

async function pingHealth(timeoutMs = 800): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`${SERVICE_URL}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/** 懒启动常驻服务并等待就绪（模型加载约 6-10s，只发生一次） */
export function ensureEyeService(): Promise<boolean> {
  if (serviceReady) return serviceReady;
  serviceReady = (async () => {
    const dir = eyeDir();
    if (!dir) return false;
    if (await pingHealth()) return true; // 已有实例在跑
    try {
      serviceProc = spawn(venvPython(dir), [path.join(dir, 'serve.py')], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
      });
      serviceProc.on('exit', () => { serviceProc = null; serviceReady = null; });
    } catch {
      return false;
    }
    // 轮询就绪（最多 30s）
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await pingHealth()) return true;
      if (!serviceProc) return false;
    }
    return false;
  })();
  return serviceReady;
}

/** 退出时清理常驻服务 */
export function closeEyeService(): void {
  if (serviceProc && serviceProc.pid) {
    try {
      // Python 子进程树：taskkill 树杀防残留
      spawn('taskkill', ['/PID', String(serviceProc.pid), '/T', '/F'], { windowsHide: true });
    } catch { /* 已退出 */ }
  }
  serviceProc = null;
  serviceReady = null;
}

interface RawBox {
  x1: number; y1: number; x2: number; y2: number; conf: number; label?: string;
}

/** 通过常驻服务解析（快路径，带 OCR 标签）；服务不可用返回 null */
async function parseViaService(shot: ScreenShot): Promise<RawBox[] | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const resp = await fetch(`${SERVICE_URL}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: shot.dataUrl, conf: 0.3 }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { items?: RawBox[] };
    return Array.isArray(data.items) ? data.items : null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
    p.stdout?.setEncoding('utf-8');
    p.stderr?.setEncoding('utf-8');
    p.stdout?.on('data', (d: string) => { out += d; });
    p.stderr?.on('data', (d: string) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: String(e) }); });
  });
}

/** 解析一次截图，返回带标签的元素清单（相对坐标 0-1000） */
export async function listElements(shot: ScreenShot): Promise<LocalElement[]> {
  const dir = eyeDir();
  if (!dir) return [];

  // 快路径：常驻服务（已预热时 300-500ms）
  const quick = await parseViaService(shot);

  const tmp = path.join(os.tmpdir(), `cursormind-eye-${Date.now()}.png`);
  try {
    const b64 = shot.dataUrl.replace(/^data:image\/(png|jpeg);base64,/, '');
    fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));

    let boxes: RawBox[] = [];
    if (quick) {
      boxes = quick;
    } else {
      // 慢路径：单次脚本（冷启动 ~9s，服务拉不起来时兜底）
      const det = await run(venvPython(dir), [path.join(dir, 'detect.py'), tmp, '--conf', '0.3'], 20000);
      if (det.code !== 0) return [];
      try {
        const d = JSON.parse(det.stdout.trim().split(/\r?\n/).pop() || '{}');
        boxes = Array.isArray(d.items) ? d.items : [];
      } catch { /* 检测输出异常 → 空 */ }
    }

    // 服务端已做 OCR（quick 非 null），不再重复跑；仅慢路径补 OCR
    const needOcr = !quick;
    if (needOcr) {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'ocr.ps1'), '-ImagePath', tmp, '-OutJson', tmp + '.ocr.json'], 12000);
    }

    // OCR 行（图片像素坐标）→ 相对坐标，按框归类补标签
    const ocrLines: Array<{ text: string; x1: number; y1: number; x2: number; y2: number }> = [];
    try {
      // PowerShell 5.1 的 UTF8 写文件带 BOM，必须先剥掉再 JSON.parse
      const rawTxt = fs.readFileSync(tmp + '.ocr.json', 'utf-8').replace(/^\uFEFF/, '');
      const raw = JSON.parse(rawTxt) as { lines?: Array<{ text: string; x: number; y: number; w: number; h: number }> };
      for (const l of raw.lines || []) {
        ocrLines.push({
          // Windows OCR 对中文会逐字加空格（「新 建 任 务」），合并成词
          text: l.text.replace(/\s+/g, ''),
          x1: (l.x / shot.width) * 1000, y1: (l.y / shot.height) * 1000,
          x2: ((l.x + l.w) / shot.width) * 1000, y2: ((l.y + l.h) / shot.height) * 1000,
        });
      }
    } catch { /* OCR 缺失 → 无标签 */ }

    const center = (b: { x1: number; y1: number; x2: number; y2: number }) => ({ cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2 });
    return boxes.map((b) => {
      if (b.label) return { label: b.label, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, conf: b.conf };
      const c = center(b);
      // 找中心落在框内、且最小的 OCR 行做标签（避免把整个面板文字全贴上）
      let label = '';
      let best = Infinity;
      for (const l of ocrLines) {
        const lc = center(l);
        if (lc.cx >= b.x1 && lc.cx <= b.x2 && lc.cy >= b.y1 && lc.cy <= b.y2) {
          const area = (l.x2 - l.x1) * (l.y2 - l.y1);
          if (area < best) { best = area; label = l.text; }
        }
      }
      return { label, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, conf: b.conf };
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp + '.ocr.json'); } catch { /* ignore */ }
  }
}

/** 本地预检：目标词模糊匹配元素标签，命中返回相对坐标框。
 *  模型常传长句（「左侧导航栏中的"即时通讯"菜单项」）：先提取引号内文本，
 *  再剥离方位/界面类描述词，最后用双向包含打分。 */
export function matchElement(target: string, elements: LocalElement[]): LocalElement | null {
  let t = target.trim();
  // ① 引号内优先（「即时通讯」/"Send"/'转发'）
  const quoted = t.match(/[「“"'']([^」”"'']{2,})[」”"'']/);
  if (quoted) t = quoted[1];
  // ② 剥离方位/界面类虚词（这些词不会出现在按钮文字里）
  t = t
    .replace(/(左侧|右侧|上方|下方|顶部|底部|左上角|右上角|左下角|右下角|导航栏|侧边栏|侧栏|菜单栏|菜单项|工具栏|状态栏|地址栏|标签页|按钮|图标|选项|栏目|中的|里的|中间的|上面的|下面的|请|帮我|找|定位|点击|一下|这个|那个)/g, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  if (!t) return null;

  let best: LocalElement | null = null;
  let bestScore = 0;
  for (const el of elements) {
    const label = (el.label || '').replace(/\s+/g, '');
    if (!label) continue;
    // 双向包含：目标串在标签里，或标签在目标串里（≥2 字才比，防单字误命中）
    let score = 0;
    if (label.includes(t) || (t.length >= 2 && t.includes(label) && label.length >= 2)) score = Math.min(label.length, t.length);
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}
