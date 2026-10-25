# 灵标（CursorMind）

> 有意识的光标，会指路的精灵——问一句「环切在哪」「微信设置在哪」，它飞过去圈住目标按钮、弹一句话提示，一步步带你操作。**不替你干，只教你下次自己干。**

教学型桌面 Agent：纯视觉方案（截图 + 视觉定位），对屏幕上**任何软件**生效，不要求目标软件开调试端口。

## 快速开始

### 环境要求

- Windows 10/11
- Node.js 18+（建议 20/22）
- DeepSeek API Key + 阿里云百炼（DashScope）API Key

### 三步跑起来

```bash
# 1. 安装依赖（Electron 二进制已配国内镜像，无需科学上网）
npm install

# 2. 配置密钥：复制模板，填入你自己的两个 key
cp .env.example .env    # Windows CMD 用: copy .env.example .env

# 3. 编译并启动
npm start
```

`.env` 内容（**每人自己的 key，此文件不进仓库**）：

```ini
DEEPSEEK_API_KEY=sk-...        # https://platform.deepseek.com
QWEN_API_KEY=sk-...            # https://bailian.console.aliyun.com
```

没有 key 也能启动，但会降级为本地知识库兜底，不是真 Agent。

### 使用

| 热键 | 作用 |
|---|---|
| `Ctrl+Alt+E` | 召唤精灵 + 弹出提问面板 |
| `Enter` | 提交问题 |
| `Ctrl+Alt+N` | **连续引导**：做完当前一步后按它，精灵重新看屏、指下一步 |
| `Ctrl+R` / 面板 `↺` | 重置对话，开始新任务 |
| `Esc` | 精灵退场 |

典型用法：问「帮我找到微信的设置界面」→ 精灵圈住微信图标 → 你双击打开 → 按 `Ctrl+Alt+N` → 它看到微信已开、圈住左下角菜单 → 你点开 → 再按 N → 指到「设置」项 → 任务完成。

## 架构（纯视觉双模型）

```
提问 → 自动全屏截图
  → deepseek-flash（大脑）：意图理解、多步引导决策、教学话术
  → 需要指路 → qwen3-vl-plus（眼睛）：截图找目标 → bbox（控件级精度）
  → 精灵飞到 bbox + 高亮圈 + 气泡
  → 视觉定位失败 → POINT 协议（deepseek 估坐标）粗指兜底
```

```
src/
├── main/                 # Electron 主进程
│   ├── agent.ts          # ReAct 循环 + 工具调用 + 连续引导
│   ├── vlm-locator.ts    # Qwen3-VL 视觉定位（0-1000 相对坐标换算）
│   ├── point-protocol.ts # [POINT:x,y:label] 协议（借鉴 Clicky，MIT）
│   ├── brain.ts          # 热键编排
│   ├── overlay.ts        # 透明置顶覆盖层 + 点击穿透
│   └── screenshot.ts     # desktopCapturer 截图
├── renderer/             # Canvas 精灵渲染 + 提问面板
└── shared/types.ts       # 共享类型
```

技术决策与完整需求见《项目概述.md》。参考过 MudrikNow（Auto-Guide 状态机思路）与 Clicky（POINT 协议、取消模型）两个 MIT 项目，均为借鉴未 fork。

## 协作约定

- **开工先 `git pull`，完工马上 `git add → commit → push`**
- 小团队直接推 `main`；要并行改同一文件时开分支（`git switch -c feat-xxx`），合并回 main
- `.env` 永远不提交（`.gitignore` 已挡）；泄露过的 key 立刻去平台吊销换新
- 提交信息用中文说清楚改了什么

## 常用命令

```bash
npm run build   # 仅编译 TS → dist/
npm start       # 编译 + 启动
npm run dev     # 直接启动（不重编译）
```

> AI生成
