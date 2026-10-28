// 屏幕坐标矩形（像素）
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 应用上下文（适配器上报）
export interface AppContext {
  app: 'chrome' | 'blender' | 'unknown';
  url?: string;
  title?: string;
  version?: string;
  mode?: string;
}

// 定位规格：如何找到某个控件
export interface LocateSpec {
  kind: 'selector' | 'text' | 'region_offset';
  selector?: string; // CSS 选择器（Chrome）
  text?: string; // 文本匹配
  region?: string; // Blender 区域名
  offset?: { x: number; y: number };
}

// 知识库功能条目
export interface Feature {
  id: string;
  names: string[]; // 别名
  app: 'chrome' | 'blender';
  requires_mode?: string;
  shortcut?: string;
  menu_path?: string[];
  search_keyword?: string;
  bubble: string; // 气泡文案（<=30 字）
  prereq?: string[];
  locate?: LocateSpec;
}

// 精灵指令（主进程 → 覆盖层渲染进程）
export type SpriteCommand =
  | { type: 'flyIn'; fromEdge?: 'left' | 'right' | 'top' | 'bottom' }
  | { type: 'flyTo'; rect: Rect; bubble: string }
  | { type: 'highlight'; rect: Rect; bubble: string }
  | { type: 'flyToPosition'; position: { x: number; y: number }; bubble: string }
  | { type: 'thinking'; text?: string }
  | { type: 'bubble'; text: string }
  | { type: 'clear' }
  | { type: 'flyOut' }
  | { type: 'idle' }
  // 液态玻璃环境帧：低分辨率屏幕快照，渲染层用于折射采样（球迁 DOM 后已弃用，保留兼容）
  | { type: 'envFrame'; dataUrl: string; w: number; h: number }
  // 语音胶囊态切换（~ 键短按；长按为打字，走 invokeTyping）
  | { type: 'toggleVoice' }
  // ~ 键双击：取消语音态并进入「引导下一步」（等价 Ctrl+Alt+N）
  | { type: 'dblNext' }
  // 语音识别结果（百炼 qwen3-asr-flash，主进程回推）
  | { type: 'asrResult'; text: string };

// 用户动作（适配器 → 主进程）
export interface UserAction {
  kind: 'click' | 'scroll' | 'input' | 'key' | 'dismiss';
  detail?: string;
}

// 页面上可交互的元素（供 Agent 理解当前界面）
export interface PageElement {
  text: string;
  tag: string;
  selector: string;
}

// 适配器统一接口（两个软件共用）
export interface Adapter {
  readonly app: 'chrome' | 'blender';
  connect(): Promise<void>;
  getContext(): Promise<AppContext>;
  locate(feature: Feature): Promise<Rect | null>;
  /** 按选择器定位（Agent 用） */
  locateBySelector?(selector: string): Promise<Rect | null>;
  /** 读取当前页面可交互元素（Agent 用） */
  getPageElements?(): Promise<PageElement[]>;
  onUserAction(cb: (e: UserAction) => void): void;
}
