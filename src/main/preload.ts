import { contextBridge, ipcRenderer } from 'electron';

// 通过 contextBridge 暴露给渲染进程的窄接口
// overlay（精灵）与 panel（提问/设置 dock）共用同一份 preload
contextBridge.exposeInMainWorld('cursormind', {
  // —— 覆盖层 / 精灵 ——
  onCommand(cb: (cmd: unknown) => void): void {
    ipcRenderer.on('sprite:command', (_e, cmd) => cb(cmd));
  },
  ready(): void {
    ipcRenderer.send('sprite:ready');
  },
  /** 全局鼠标位置（主进程 60Hz 推送，用于惯性跟随） */
  onCursor(cb: (p: { x: number; y: number }) => void): void {
    ipcRenderer.on('cursor', (_e, p) => cb(p));
  },
  /** 语音胶囊态识别完成后提交问题（走 Agent 链路） */
  submitVoice(text: string): void {
    ipcRenderer.send('sprite:voice', text);
  },
  /** 录音数据送主进程识别（百炼 qwen3-asr-flash） */
  sendAsrAudio(dataUrl: string): void {
    ipcRenderer.send('sprite:asr', dataUrl);
  },

  // —— 提问/设置 dock ——
  onPanelOpen(cb: () => void): void {
    ipcRenderer.on('panel:open', () => cb());
  },
  /** 长按 ~ 直达打字：直接展开提问输入框 */
  onPanelSearch(cb: () => void): void {
    ipcRenderer.on('panel:search', () => cb());
  },
  /** 托盘右键菜单「设置」：展开设置面板 */
  onPanelSettings(cb: () => void): void {
    ipcRenderer.on('panel:settings', () => cb());
  },
  /** 面板收回动画完成：请求主进程隐藏窗口（dock 已删，无常驻形态） */
  requestHide(): void {
    ipcRenderer.send('panel:request-hide');
  },
  onPanelReply(cb: (text: string) => void): void {
    ipcRenderer.on('panel:reply', (_e, text) => cb(text));
  },
  onPanelCollapse(cb: () => void): void {
    ipcRenderer.on('panel:collapse', () => cb());
  },
  onPanelMeta(cb: (meta: string) => void): void {
    ipcRenderer.on('panel:meta', (_e, meta) => cb(meta));
  },
  submitQuestion(text: string): void {
    ipcRenderer.send('panel:question', text);
  },
  resetConversation(): void {
    ipcRenderer.send('panel:reset');
  },
  testFly(): void {
    ipcRenderer.send('panel:test');
  },
  /** 语音开关（设置面板） */
  setVoice(on: boolean): void {
    ipcRenderer.send('panel:voice', on);
  },
  /** 接收主进程推送的 TTS 音频并播放 */
  onPanelAudio(cb: (src: string) => void): void {
    ipcRenderer.on('panel:audio', (_e, src) => cb(src));
  },
  /** 透明区域穿透切换（v=true 穿透给下层应用） */
  setIgnore(v: boolean): void {
    ipcRenderer.send('panel:set-ignore', v);
  },

  // —— 文字操作卡片 ——
  onTextCard(cb: (data: string) => void): void {
    ipcRenderer.on('textcard:show', (_e, data) => cb(data));
  },
  onTextCardHide(cb: () => void): void {
    ipcRenderer.on('textcard:hide', () => cb());
  },
  textCardReplace(): void {
    ipcRenderer.send('textcard:replace');
  },
  textCardCancel(): void {
    ipcRenderer.send('textcard:cancel');
  },
  /** 划选自动替换开关（设置面板） */
  setAutoReplace(on: boolean): void {
    ipcRenderer.send('panel:auto-replace', on);
  },

  // —— 通用 ——
  dismiss(): void {
    ipcRenderer.send('sprite:dismiss');
  },
  /** 渲染层错误上报（主进程写日志，用于诊断） */
  reportError(msg: string): void {
    ipcRenderer.send('sprite:error', String(msg).slice(0, 4000));
  },
});
