import { app, globalShortcut, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createOverlay } from './overlay';
import { createPanel } from './panel';
import { Brain } from './brain';
import { features } from './features-data';

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
  void okE2; void okN; void okN2;
  fs.appendFileSync(logFile, '[hotkeys] startup OK\n');

  // 提问面板：用户提交问题
  ipcMain.on('panel:question', (_e, text: unknown) => {
    void brain.ask(String(text || '').trim());
  });

  // 提问面板：重置对话（清空上下文，开始新对话）
  ipcMain.on('panel:reset', () => {
    brain.newConversation();
  });

  ipcMain.on('sprite:ready', () => {
    // 渲染进程就绪
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
