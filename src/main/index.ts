import { app, globalShortcut, ipcMain, session, Notification } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createOverlay, sendCommand, setOrbVisible, isOrbVisible } from './overlay';
import { createPanel, openSettingsPanel, openSearchPanel } from './panel';
import { Brain } from './brain';
import { features } from './features-data';
import { setVoice } from './tts';
import { textPolish, pasteFromClipboard, setAutoReplace, isPolishIntent, extractSearchPaste, searchAndPaste, extractInputText, inputText, isPasteIntent, classifyPasteIntent, copySelectionNow, deleteSelectionNow, selectAllNow, undoNow, redoNow, matchBasicOp } from './textops';
import { consumeReplaceAction, cancelReplaceAction } from './textcard';
import { isTildeDown } from './win-keys';
import { installMouseTrail, uninstallMouseTrail } from './win-mouse';
import { handleTrail, tryLasso, clearLasso } from './lasso';
import { runDshTask, isWorkTaskIntent, cancelBgTask, removeBgTask, clearDoneBgTasks, viewBgTaskResult, cancelAllBgTasks } from './dshRunner';
import { saveHotwords } from './hotwords';
import { createTaskStrip, setTaskstripHandlers, showTaskStrip, destroyTaskStrip } from './taskstrip';
import { ensureEyeService, closeEyeService, localEyeEnabled } from './localEye';
import { warmupCapture } from './screenshot';
import { transcribe } from './asr';
import { initTray, setTrayBusy } from './tray';
import { createBoard, toggleBoard, showBoard, destroyBoard, startBoardReminderLoop } from './board';
import { loadMcp, getMcp, saveMcp } from './mcpConfig';

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
  createBoard();
  startBoardReminderLoop(); // 待办到期提醒轮询（5s 一查）
  createTaskStrip(); // 后台任务条（无任务时隐藏，有任务自动出现）
  // 任务条操作接线到 dshRunner 的任务管理
  setTaskstripHandlers({
    onCancel: cancelBgTask,
    onView: viewBgTaskResult,
    onRemove: removeBgTask,
    onClearDone: clearDoneBgTasks,
  });
  loadMcp(); // 启动读 MCP 配置（飞书开关 + token）
  // MCP 配置读写（设置面板）
  ipcMain.on('mcp:get', (e) => { fs.appendFileSync(logFile, '[mcp] 面板请求配置\n'); e.sender.send('mcp:data', getMcp()); });
  ipcMain.on('mcp:save', (e, p: unknown) => { e.sender.send('mcp:data', saveMcp(p as Parameters<typeof saveMcp>[0])); });

  brain = new Brain(features);

  // 托盘：任务栏状态区常驻；左键召唤、右键菜单（含设置）；busy 时橙弧旋转暗示正在跑
  initTray({
    onSummon: () => brain.invoke(),
    onNewChat: () => brain.newConversation(),
    onDemo: () => brain.testFly(),
    onSettings: () => openSettingsPanel(),
    onBoard: () => showBoard(),
    onBgTasks: () => showTaskStrip(),
    onQuit: () => app.quit(),
  });

  // 召唤（精灵飞入 + 提问面板） / 退场；Esc 清圈选与面板——后台任务独立作业，不受 Esc 影响
  // （后台任务取消走任务条列表，避免误触丢活）
  globalShortcut.register('Escape', () => {
    clearLasso('Esc');
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
  // ~ 键（Esc 下方）：单击 = 语音胶囊，双击 = 引导下一步（等价 Ctrl+Alt+N），长按 = 打字面板。
  // globalShortcut 只有按下事件，短/长按靠 GetAsyncKeyState 轮询物理键态区分。
  let tildeWatch = false;
  let lastTildeTap = 0;      // 上一次短按松开的时间戳（双击判定用）
  const DOUBLE_TAP_MS = 400; // 双击判定窗口
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
        lastTildeTap = 0; // 长按中断双击序列
        brain.invokeTyping(); // 长按：直达打字（不等松开，反馈即时）
      } else if (!isTildeDown()) {
        clearInterval(timer);
        tildeWatch = false;
        const now = Date.now();
        if (now - lastTildeTap <= DOUBLE_TAP_MS) {
          // 双击：第一击已触发语音态，先让渲染层取消录音，再走下一步引导
          lastTildeTap = 0;
          fs.appendFileSync(logFile, '[hotkey] ~ double-tap → nextStep\n');
          sendCommand({ type: 'dblNext' });
          void brain.nextStep();
        } else {
          lastTildeTap = now;
          sendCommand({ type: 'toggleVoice' }); // 单击：语音胶囊
        }
      }
    }, 25);
  };
  const okTilde = globalShortcut.register('`', () => {
    fs.appendFileSync(logFile, '[hotkey] ~ pressed\n');
    startTildeWatch();
  });
  // 划选优化（Ctrl+Alt+O）与剪切（Ctrl+Alt+X）；基础编辑：复制 C / 删除 D / 撤销 Z；粘贴 Ctrl+Alt+V
  const okPolish = globalShortcut.register('Control+Alt+O', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+O pressed\n');
    void textPolish('polish');
  });
  const okCut = globalShortcut.register('Control+Alt+X', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+X pressed\n');
    void textPolish('cut');
  });
  const okCopy = globalShortcut.register('Control+Alt+C', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+C pressed\n');
    void copySelectionNow();
  });
  const okDelete = globalShortcut.register('Control+Alt+D', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+D pressed\n');
    void deleteSelectionNow();
  });
  const okUndo = globalShortcut.register('Control+Alt+Z', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+Z pressed\n');
    void undoNow();
  });
  const okPaste = globalShortcut.register('Control+Alt+V', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+V pressed\n');
    void pasteFromClipboard();
  });
  // 看板：开关（展开/收起切换；隐藏时显示）
  const okBoard = globalShortcut.register('Control+Alt+B', () => {
    fs.appendFileSync(logFile, '[hotkey] Ctrl+Alt+B pressed\n');
    toggleBoard();
  });
  void okE2; void okN; void okN2; void okTilde; void okPolish; void okCut; void okCopy; void okDelete; void okUndo; void okPaste; void okBoard;
  fs.appendFileSync(logFile, '[hotkeys] startup OK (E=' + okE2 + ',N=' + (okN && okN2) + ',~=' + okTilde + ',O=' + okPolish + ',X=' + okCut + ',C=' + okCopy + ',D=' + okDelete + ',Z=' + okUndo + ',V=' + okPaste + ',B=' + okBoard + ')\n');

  // 提问面板提交：与语音同一条意图路由（打字「优化这段」同样执行而非教学问答）
  ipcMain.on('panel:question', (_e, text: unknown) => {
    const t = String(text || '').trim();
    if (!t) return;
    void routeVoice(t, 'typing');
  });

  // 提问面板：重置对话（清空上下文，开始新对话；不影响后台作业）
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

  // 灵标球可见性开关（设置面板）：隐藏跟随球，语音/指路/优化链路全保留
  ipcMain.on('panel:orb-visible', (_e: Electron.IpcMainEvent, v: unknown) => {
    setOrbVisible(!!v);
  });

  // 语音热词表（设置面板）：逗号分隔保存，ASR 转写后做近似校正
  ipcMain.on('panel:hotwords', (_e: Electron.IpcMainEvent, v: unknown) => {
    const words = String(v || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    saveHotwords(words);
    fs.appendFileSync(logFile, '[hotwords] 保存 ' + words.length + ' 个热词: ' + words.join(',') + '\n');
  });

  // 文字卡片：替换 / 取消
  ipcMain.on('textcard:replace', () => {
    consumeReplaceAction();
  });
  ipcMain.on('textcard:cancel', () => {
    cancelReplaceAction();
  });

  // 语音输入：胶囊态识别完成后提交。打字与语音同一条意图路由（routeVoice）。
  // 意图路由（递进）：①优化（正则快路径）②基础编辑（复制/删除/全选/撤销/重做）
  // ③「X三个字」直接输入 ④粘贴类模糊意图 → LLM 分类，失败降级旧正则 ⑤其余 → brain.ask。
  ipcMain.on('sprite:voice', (_e: Electron.IpcMainEvent, text: unknown) => {
    const t = String(text || '').trim();
    if (!t) return;
    void routeVoice(t, 'voice');
  });

  async function routeVoice(t: string, source: 'voice' | 'typing'): Promise<void> {
    const tag = '[' + source + ']';
    // 圈选优先：有活跃圈选且问题指向圈（"我圈住的东西是什么"）→ vision-exp 一次性 VQA
    if (tryLasso(t)) {
      fs.appendFileSync(logFile, tag + ' 路由到圈选问答: ' + t.slice(0, 40) + '\n');
      return;
    }
    if (isPolishIntent(t)) {
      fs.appendFileSync(logFile, tag + ' 路由到划选优化: ' + t.slice(0, 40) + '\n');
      void textPolish('polish', true);
      return;
    }
    // 基础编辑操作（复制/删除/全选/撤销/重做）：明确指令零延迟直接执行
    const basicOp = matchBasicOp(t);
    if (basicOp) {
      fs.appendFileSync(logFile, tag + ' 路由到基础操作: ' + t.slice(0, 40) + '\n');
      void basicOp();
      return;
    }
    const directText = extractInputText(t);
    if (directText) {
      fs.appendFileSync(logFile, tag + ' 路由到输入文字: ' + t.slice(0, 40) + '\n');
      void inputText(directText);
      return;
    }
    if (isPasteIntent(t)) {
      fs.appendFileSync(logFile, '[voice] 粘贴类意图，LLM 分类中: ' + t.slice(0, 40) + '\n');
      const c = await classifyPasteIntent(t);
      if (c && c.kind === 'input' && c.text) {
        fs.appendFileSync(logFile, tag + ' LLM→输入文字: ' + c.text.slice(0, 30) + '\n');
        void inputText(c.text);
        return;
      }
      if (c && c.kind === 'search' && c.query) {
        fs.appendFileSync(logFile, tag + ' LLM→搜索粘贴: ' + c.query.slice(0, 30) + '\n');
        void searchAndPaste(c.query);
        return;
      }
      if (c && c.kind === 'clipboard') {
        fs.appendFileSync(logFile, tag + ' LLM→粘贴剪贴板\n');
        void pasteFromClipboard();
        return;
      }
      // LLM 不可用/无法判断 → 降级：旧正则兜底，再不行贴剪贴板
      const sq = extractSearchPaste(t);
      if (sq) {
        fs.appendFileSync(logFile, tag + ' LLM失败，正则降级→搜索粘贴: ' + sq.slice(0, 30) + '\n');
        void searchAndPaste(sq);
      } else {
        fs.appendFileSync(logFile, tag + ' LLM失败，降级→粘贴剪贴板\n');
        void pasteFromClipboard();
      }
      return;
    }
    // DeepSeek Harness 执行通道：写脚本/建文件/生成代码这类「帮我干」直接交给 dsh 引擎交付
    if (isWorkTaskIntent(t)) {
      fs.appendFileSync(logFile, tag + ' 路由到 DeepSeek harness: ' + t.slice(0, 40) + '\n');
      void runDshTask(t);
      return;
    }
    void brain.ask(t);
  }

  // 语音识别：渲染层录音 → 百炼 qwen3-asr-flash → 文本回传
  ipcMain.on('sprite:asr', async (_e: Electron.IpcMainEvent, audio: unknown) => {
    const dataUrl = String(audio || '');
    if (!dataUrl.startsWith('data:')) return;
    setTrayBusy(true, '识别语音');
    const [text, err] = await transcribe(dataUrl);
    setTrayBusy(false);
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
  // 引擎自检：CURSORMIND_DSH_TEST=1 时启动后自动跑一个 dsh headless 真任务
  // （「写个脚本」命中 code-writer + cursormind-workspace 双技能，验证注入链路）
  if (process.env.CURSORMIND_DSH_TEST === '1') {
    setTimeout(() => {
      void runDshTask('写个脚本 codex-demo.js，输出「通道验证OK」，然后运行验证。');
    }, 3000);
  }
  // 视觉链路自检：CURSORMIND_VISION_TEST=1 时自动提一个指路问题（验证 vision-exp 主脑 + 本地眼睛）
  if (process.env.CURSORMIND_VISION_TEST === '1') {
    setTimeout(() => {
      void brain.ask('即时通讯在哪');
    }, 40000);
  }
  // 画圈自检：CURSORMIND_LASSO_TEST=1 时（配合 CURSORMIND_ACCEPT_INJECTED=1 + 外部注入画圈脚本）
  // 轮询 .temp/lasso-ask.txt：外部编排确认圈选激活后写入问题 → 触发圈选 VQA
  // （文件触发解耦时序：AI 工具调用间隙不可控，定时器编排会错位）
  if (process.env.CURSORMIND_LASSO_TEST === '1') {
    const askFile = path.join(__dirname, '..', '..', '.temp', 'lasso-ask.txt');
    fs.appendFileSync(logFile, '[lasso-test] 自检模式：等待 .temp/lasso-ask.txt 触发提问\n');
    const askTimer = setInterval(() => {
      try {
        if (fs.existsSync(askFile)) {
          const q = fs.readFileSync(askFile, 'utf-8').trim();
          fs.unlinkSync(askFile);
          if (q) {
            const ok = tryLasso(q);
            fs.appendFileSync(logFile, '[lasso-test] file-ask "' + q.slice(0, 20) + '" tryLasso=' + ok + '\n');
          }
        }
      } catch { /* 轮询失败忽略，下一拍重试 */ }
    }, 500);
    setTimeout(() => clearInterval(askTimer), 180_000); // 3 分钟后停止轮询
  }
  // 本地眼睛：CURSORMIND_LOCAL_EYE=1 时异步预热常驻检测服务（不阻塞启动，模型加载约 6-10s 只发生一次）
  if (localEyeEnabled()) {
    fs.appendFileSync(logFile, '[eye] 本地眼睛启用，后台预热检测服务\n');
    void ensureEyeService().then((ok) => {
      try { fs.appendFileSync(logFile, '[eye] 检测服务就绪: ' + ok + '\n'); } catch { /* 忽略 */ }
    });
  }

  // 截图预热：启动即空跑一次捕获，把 GPU 通道与 JPEG 编码路径热起来（对标 heyClicky DXGI prewarm）
  setTimeout(() => {
    void warmupCapture().then(() => {
      try { fs.appendFileSync(logFile, '[shot] 截屏通道预热完成\n'); } catch { /* 忽略 */ }
    });
  }, 1500);

  // 圈画功能（鼠标画圈识别）：已按用户要求默认停用。
  // 恢复方式：启动环境变量 CURSORMIND_LASSO=1（代码与手势判定保留，随时可开）。
  if (process.env.CURSORMIND_LASSO === '1') {
    let mouseOk = false;
    try {
      mouseOk = installMouseTrail(handleTrail);
    } catch (e) {
      fs.appendFileSync(logFile, '[mouse] 安装异常: ' + (e instanceof Error ? (e.stack || e.message) : String(e)) + '\n');
    }
    fs.appendFileSync(logFile, '[mouse] 轨迹钩子 ' + (mouseOk ? '安装成功' : '安装失败') + '\n');
    // 失败必须用户可见（启动时球在跟随态气泡不显示——用系统通知，heyClicky "失败如实说"）
    if (!mouseOk) {
      try {
        if (Notification.isSupported()) {
          new Notification({ title: '灵标', body: '画圈功能不可用：鼠标钩子安装失败（其余功能不受影响）' }).show();
        }
      } catch { /* 通知失败不影响启动 */ }
    }
  } else {
    fs.appendFileSync(logFile, '[mouse] 圈画功能已停用（CURSORMIND_LASSO 未开启）\n');
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  uninstallMouseTrail();
  closeEyeService();
  destroyBoard();
  destroyTaskStrip();
  cancelAllBgTasks(); // 杀掉在跑的后台 dsh 进程树，不留孤儿
});
