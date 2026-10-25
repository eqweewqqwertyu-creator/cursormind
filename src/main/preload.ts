import { contextBridge, ipcRenderer } from 'electron';

// 通过 contextBridge 暴露给渲染进程的窄接口
// overlay（精灵）与 panel（提问）共用同一份 preload
contextBridge.exposeInMainWorld('cursormind', {
  // —— 覆盖层 / 精灵 ——
  onCommand(cb: (cmd: unknown) => void): void {
    ipcRenderer.on('sprite:command', (_e, cmd) => cb(cmd));
  },
  ready(): void {
    ipcRenderer.send('sprite:ready');
  },

  // —— 提问面板 ——
  onPanelOpen(cb: () => void): void {
    ipcRenderer.on('panel:open', () => cb());
  },
  onPanelReply(cb: (text: string) => void): void {
    ipcRenderer.on('panel:reply', (_e, text) => cb(text));
  },
  submitQuestion(text: string): void {
    ipcRenderer.send('panel:question', text);
  },
  resetConversation(): void {
    ipcRenderer.send('panel:reset');
  },

  // —— 通用 ——
  dismiss(): void {
    ipcRenderer.send('sprite:dismiss');
  },
});
