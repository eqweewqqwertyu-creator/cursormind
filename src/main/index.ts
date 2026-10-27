import { app, globalShortcut, ipcMain, session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createOverlay, sendCommand } from './overlay';
import { createPanel } from './panel';
import { Brain } from './brain';
import { features } from './features-data';
import { setVoice } from './tts';
import { textPolish, pasteFromClipboard, setAutoReplace } from './textops';
import { consumeReplaceAction, cancelReplaceAction } from './textcard';
import { isTildeDown } from './win-keys';
import { transcribe } from './asr';

/** 读取项目根目录的 .env（避免把 key 写死在代码里） */
function loadEnv(): void {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
      }
    }
  } catch {
    // .env 读取失败不阻塞启动
  }
}
loadEnv();

// 同步热键日志（console.log 重定向到文件有缓冲，会骗人）
const logFile = path.join(__dirname, '..', '..', '.temp', 'hotkey.log');
try { fs.writeFileSync(logFile, ''); } catch { /* 忽略 */ }

let brain: Brain;

app.whenReady().then(() => {
  // 麦克风权限：getUserMedia 需显式放行（session 只能 app ready 后访问）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  createOverlay();
  createPanel();

  brain = new Brain(features);

  // 召唤（精灵飞入 + 提问面板） / 退场
  globalShortcut.register('Escape', () => {
    brain.cancel();
  });
  // 连续引导："我做完了这一步，继续"（Clicky 的语音入口等价物：全局可用）
  const okN = globalShortcut.register('Control+Alt+K', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+K pressed\n');
    void brain.nextStep();
  });
  const okN2 = globalShortcut.register('Control+Alt+N', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+N pressed\n');
    void brain.nextStep();
  });
  const okE2 = globalShortcut.register('Control+Alt+E', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+E pressed\n');
    brain.invoke();
  });
  // ~ 键（Esc 下方）：短按 = 语音胶囊，长按 = 直接展开打字面板。
  // globalShortcut 只有按下事件，短/长按靠 GetAsyncKeyState 轮询物理键态区分。
  let tildeWatch = false;
  const startTildeWatch = (): void => {
    if (tildeWatch) return;
    tildeWatch = true;
    const LONG_PRESS_MS = 450;
    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= LONG_PRESS_MS) {
        clearInterval(timer);
        tildeWatch = false;
        brain.invokeTyping(); // 长按：直达打字（不等松开，反馈即时）
      } else if (!isTildeDown()) {
        clearInterval(timer);
        tildeWatch = false;
        sendCommand({ type: 'toggleVoice' }); // 短按已松开：语音胶囊
      }
    }, 25);
  };
  const okTilde = globalShortcut.register('`', () => {
    fs.appendFileSync(logFile, '[hotkey] ~ pressed\n');
    startTildeWatch();
  });
  // 划选优化（Ctrl+Alt+O）与剪切（Ctrl+Alt+X）；剪切后到目标位置 Ctrl+Alt+V 粘贴
  const okPolish = globalShortcut.register('Control+Alt+O', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+O pressed\n');
    void textPolish('polish');
  });
  const okCut = globalShortcut.register('Control+Alt+X', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+X pressed\n');
    void textPolish('cut');
  });
  const okPaste = globalShortcut.register('Control+Alt+V', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+V pressed\n');
    void pasteFromClipboard();
  });
  void okE2; void okN; void okN2; void okTilde; void okPolish; void okCut; void okPaste;
  fs.appendFileSync(logFile, '[hotkeys] startup OK (E=' + okE2 + ',N=' + (okN && okN2) + ',~=' + okTilde + ',O=' + okPolish + ',X=' + okCut + ',V=' + okPaste + ')\n');

  // 提问面板：用户提交问题
  ipcMain.on('panel:question', (_e, text: unknown) => {
    void brain.ask(String(text || '').trim());
  });

  // 提问面板：重置对话（清空上下文，开始新对话）
  ipcMain.on('panel:reset', () => {
    brain.newConversation();
  });

  // 设置面板：精灵自检按钮
  ipcMain.on('panel:test', () => {
    brain.testFly();
  });

  // 语音输出开关（设置面板）
  ipcMain.on('panel:voice', (_e: Electron.IpcMainEvent, v: unknown) => {
    setVoice(!!v);
  });

  // 划选优化：自动替换开关（设置面板；关 = 卡片确认模式）
  ipcMain.on('panel:auto-replace', (_e: Electron.IpcMainEvent, v: unknown) => {
    setAutoReplace(!!v);
  });

  // 文字卡片：替换 / 取消
  ipcMain.on('textcard:replace', () => {
    consumeReplaceAction();
  });
  ipcMain.on('textcard:cancel', () => {
    cancelReplaceAction();
  });

  // 语音输入：胶囊态识别完成后提交（走与打字相同的 Agent 链路）
  ipcMain.on('sprite:voice', (_e: Electron.IpcMainEvent, text: unknown) => {
    const t = String(text || '').trim();
    if (t) void brain.ask(t);
  });

  // 语音识别：渲染层录音 → 百炼 qwen3-asr-flash → 文本回传
  ipcMain.on('sprite:asr', async (_e: Electron.IpcMainEvent, audio: unknown) => {
    const dataUrl = String(audio || '');
    if (!dataUrl.startsWith('data:')) return;
    const [text, err] = await transcribe(dataUrl);
    sendCommand({ type: 'asrResult', text: text || '' });
    fs.appendFileSync(logFile, '[asr] ' + (text ? 'OK: ' + text.slice(0, 60) : 'FAILED: ' + (err || 'unknown')) + '\n');
  });

  ipcMain.on('sprite:ready', () => {
    // 渲染进程就绪
    fs.appendFileSync(logFile, '[renderer] sprite:ready\n');
  });
  // 渲染层错误上报 → 同步落盘（renderer.js 无 Node 环境，只能走 IPC）
  ipcMain.on('sprite:error', (_e: Electron.IpcMainEvent, msg: unknown) => {
    fs.appendFileSync(logFile, '[renderer] ' + String(msg) + '\n');
  });
  ipcMain.on('sprite:dismiss', () => {
    brain.cancel();
  });

  // 自检模式：CURSORMIND_TEST=1 时启动后自动演示飞行 + 圈 + 气泡
  if (process.env.CURSORMIND_TEST === '1') {
    setTimeout(() => brain.testFly(), 2000);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
