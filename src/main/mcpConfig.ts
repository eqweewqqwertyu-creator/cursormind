/**
 * MCP 配置（当前支持飞书官方远程 MCP）：开关 + 飞书 token。
 * 持久化到 userData/mcp.json（本地单用户文件，与其他配置同目录）。
 *
 * 飞书远程 MCP（streamable-http）：
 *  - URL: https://mcp.feishu.cn/mcp
 *  - 鉴权 Header: X-Lark-MCP-TAT（t- 开头，应用身份）或 X-Lark-MCP-UAT（u- 开头，用户身份）
 *  - X-Lark-MCP-Allowed-Tools: 允许的工具白名单（缺省则无工具可见）
 * token 类型按前缀自动判断：t- → TAT，u- → UAT。
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface FeishuMcp {
  token: string;
  tools: string;
}

export interface McpConfig {
  enabled: boolean;
  feishu: FeishuMcp;
}

/** 常用云文档工具白名单（飞书当前支持「云文档」场景） */
export const DEFAULT_FEISHU_TOOLS =
  'fetch-doc,search-doc,create-doc,update-doc,list-docs,get-user,search-user,get-comments,add-comments';

const FEISHU_URL = 'https://mcp.feishu.cn/mcp';

let cfg: McpConfig = { enabled: false, feishu: { token: '', tools: DEFAULT_FEISHU_TOOLS } };

function cfgFile(): string {
  return path.join(app.getPath('userData'), 'mcp.json');
}

export function loadMcp(): void {
  try {
    if (fs.existsSync(cfgFile())) {
      const j = JSON.parse(fs.readFileSync(cfgFile(), 'utf-8'));
      cfg.enabled = !!j.enabled;
      cfg.feishu.token = String(j.feishu?.token || '');
      cfg.feishu.tools = String(j.feishu?.tools || DEFAULT_FEISHU_TOOLS);
    }
  } catch { /* 保持默认 */ }
}

export function saveMcp(partial: Partial<McpConfig>): McpConfig {
  if (partial.enabled !== undefined) cfg.enabled = !!partial.enabled;
  if (partial.feishu) {
    if (partial.feishu.token !== undefined) cfg.feishu.token = String(partial.feishu.token).trim();
    if (partial.feishu.tools !== undefined) cfg.feishu.tools = String(partial.feishu.tools).trim();
  }
  try {
    fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
    fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2), 'utf-8');
  } catch { /* 保存失败静默 */ }
  return getMcp();
}

export function getMcp(): McpConfig {
  return {
    enabled: cfg.enabled,
    feishu: { token: cfg.feishu.token, tools: cfg.feishu.tools },
  };
}

/** 是否真正启用飞书 MCP（开关开 + 有 token） */
export function feishuActive(): boolean {
  return cfg.enabled && !!cfg.feishu.token;
}

/** 根据 token 前缀判断 Header 名（t- → TAT 应用身份；u- → UAT 用户身份） */
export function feishuAuthHeader(): { name: string; value: string } | null {
  const t = cfg.feishu.token.trim();
  if (!t) return null;
  const name = t.startsWith('u-') ? 'X-Lark-MCP-UAT' : 'X-Lark-MCP-TAT';
  return { name, value: t };
}

export { FEISHU_URL };