# 灵标 CursorMind · 复刻 heyClicky 总体方针与项目计划

> 版本 v1.0 ｜ 2026-10-28 ｜ 作者：枸杞子 × TeleAgent
> 背景：对 heyClicky Windows 版（v1.1.3，安装目录逆向分析）的架构研究后，制定灵标的对标计划。
> 纪律：只学架构与提示词模式，不反编译业务代码、不搬实现、不碰其商业产品内部配置。

---

## 一、对标结论（一句话）

heyClicky = **WinUI3 壳 + 云端 OpenAI 兼容代理 + 开源 Codex CLI 作 harness + SKILL.md 工具生态**。
灵标复刻 = **Electron 壳 + DeepSeek 本地直连 + 自研 ReAct harness（agent.ts）+ 同款 SKILL.md 生态**，
差异化押注三点：**中文全链路语音、覆盖任意 Windows 应用、教学+执行混合哲学**。

---

## 二、竞品架构还原（逆向所得，作为设计输入）

```
HeyClicky.exe（WinUI3 壳：语音/overlay/画笔/UI）
 └─ AgentService（编排中枢）
     ├─ AgentWorkerApi ──→ 云端（鉴权 / 计费租约 / Composio 连接器 / 用户记忆）
     ├─ 语音 → 生成任务 brief
     ├─ AgentHarnessRunnerProcess → 隔离进程 clicky-harness.exe
     │    └─ CodexSession → CodexRpcClient(JSON-RPC) → codex.exe（GPT-6-Luna）
     │         ├─ AgentHarnessMcpServer（工具生态全跑 MCP）
     │         │    ├─ browser → nativeMessaging → 扩展 → chrome.debugger(CDP)
     │         │    ├─ shell → codex-windows-sandbox-setup.exe（进程沙箱）
     │         │    └─ routines（定时例程）
     │         └─ skills：SynchronizeSkills 同步 SKILL.md 给 harness
     ├─ Steer / Interrupt / Resume（回合转向、中断、续线程）
     └─ 最终消息 → TTS 念首句 + overlay 展示
```

关键配置（其 codex-home/config.toml 实测）：
`base_url=api.heyclicky.com/agent/openai/v1`、`wire_api=responses`、
`approval_policy=never`、`sandbox_mode=danger-full-access`、`multi_agent=true`、
`model_auto_compact_token_limit=160000`。

**安全哲学对比**：heyClicky 客户端全放开（danger-full-access + 永不询问），
安全押在云端 guardian 分类器；灵标反着来——**本地分级确认**（读随便、写要干、
删除/外发/花钱先问）。两条路线都成立，灵标选本地确认是因为不依赖云端守卫、
且比赛场景演示「AI 有分寸」更直观。

---

## 三、总体方针（六条铁律）

### 1. 壳是自己的，agent 是自己的，只换模型
不嵌入 codex / 不嵌 OpenCode / 不嵌任何第三方运行时。
agent.ts 自研 ReAct 循环就是灵标的 harness——与 heyClicky 用 codex 同构，但代码 100% 自有。
换模型 = 换 .env 里一个 base_url，这是架构红利，坚持住。

### 2. 「同一块玻璃」延续到 agent 时代
壳的视觉已统一（球→胶囊→透镜→面板→气泡 全玻璃）。
新增的 agent 相关 UI（任务进度、plan 展示、例程列表）必须继续玻璃语言，
不许出现「第二个软件的浮窗」。

### 3. 教学+执行混合，边界由确认分级守
- 读类（截图/搜索/读文件）：直接干，零确认
- 写类（粘贴/替换/建文件）：执行，气泡+语音报账
- 高危类（删除用户没让删的 / 外发 / 花钱）：先问，一批问完（学它「one bundled set of questions」）
- 红线：永远不假称做过了；永不编造事实；never invent user facts

### 4. 中文全链路是护城河，不是可选项
ASR（qwen3-asr-flash）→ 意图路由（qwen-plus 分类）→ 行动（DeepSeek）→ 播报（qwen3-tts-flash）。
heyClicky 中文体验差（GPT Realtime + 英文优先），这是演示和答辩的第一差异点。

### 5. skill 生态三处互通
SKILL.md 格式与 heyClicky、TeleAgent 三方兼容。
灵标加载 skill = 按关键词把 SKILL.md 注入 system prompt（学它 SynchronizeSkills 的按需加载，
不常驻）。长期：灵标既是 skill 消费者，也可把「指路教学」技能开放回平台。

### 6. 体积与依赖克制
heyClicky 898MB（.NET 运行时 + 60 语言包 + 本地 ONNX + V8 嵌入）。
灵标目标 <300MB：Electron 壳 + 百炼云端推理，本地模型（ONNX/NPU）列为 M2 可选不做承诺。

---

## 四、架构映射表（它 → 灵标）

| heyClicky 组件 | 灵标实现 | 状态 |
|---|---|---|
| WinUI3 壳 + 语音 + 画笔 overlay | Electron + 玻璃球 + canvas | ✅ 已有 |
| CodexSession + GPT-6（云端代理） | agent.ts ReAct + DeepSeek 直连 | ✅ 已有 |
| 语音→brief | routeVoice 意图路由（更直接） | ✅ 已有 |
| clicky-harness.exe 隔离进程 | （同进程） | 📋 M1 评估 |
| AgentWorkerApi 云端记忆 | 无云端，本地 AGENTS.md 式工作簿 | 📋 M1 |
| SynchronizeSkills + skills/*.md | resources/skills/ 按关键词注入 | 🔨 M0 做 |
| AgentHarnessMcpServer 工具生态 | 工具注册表（locate/answer/…） | 🔨 M0 精简版 |
| clicky-browser 扩展 + chrome.debugger | Chrome CDP 适配器（原计划） | 📋 M1（正解已找到：扩展+CDP 免端口） |
| integration-skills ×11（Composio） | 不做（比赛无场景） | ❌ |
| Routines 定时例程 | 灵标侧 TeleAgent scheduler 已有；应用内 M2 | 📋 M2 |
| guardian 云端安全分类 | 本地确认分级 + 执行日志 | ✅ 哲学不同、已实现 |
| 租约计费 | 不做（比赛免费） | ❌ |
| Velopack 更新 / Sentry | bat 启动器 + hotkey.log | 📋 M2 |

---

## 五、项目计划

### M0 · 赛前演示版（11-04 预选赛前，预算 2 个工作日）

目标：答辩故事成立 + 30 秒录屏里出现「agent 干活」的镜头。

| # | 任务 | 验收 | 估时 |
|---|---|---|---|
| 1 | skills 目录机制：resources/skills/*/SKILL.md，brain 按关键词注入 | 新增一个 skill 文件，重启即生效，无代码改动 | 0.5 天 |
| 2 | system prompt 升级：确认分级 + 结果先行 + 禁黑话（学其指令纪律） | 对照 heyClicky 指令逐条落进 brain.ts | 0.25 天 |
| 3 | 工具位扩展：read_screen（描述指针周围）/ write_note（AGENTS.md 式工作簿） | Agent 能「看指针处」并留下持久笔记 | 0.5 天 |
| 4 | 演示脚本定稿 + 录屏（话术：消灭 AI 绕道） | 30 秒成片 | 0.5 天 |
| 5 | DeepSeek harness 命令行（独立实验，不入库）：开源 codex CLI + DeepSeek config | 一条命令跑通 agent 回合 | 0.25 天（可选） |

M0 明确不做：harness 隔离进程、MCP、浏览器扩展、本地模型。

### M1 · 真正的 harness（赛后 2-3 周）

| # | 任务 | 说明 |
|---|---|---|
| 1 | harness 隔离进程 | agent 循环挪出主进程（参考 AgentHarnessRunnerProcess：预热/中断/续回合） |
| 2 | 持久工作簿 | 每个对话任务一个工作文件夹 + AGENTS.md 笔记（学其 notes 纪律），跨会话恢复 |
| 3 | 上下文自动压缩 | 学 model_auto_compact_token_limit=160000 的落点设计，超限前存 checkpoint |
| 4 | Chrome 适配器（扩展 + chrome.debugger） | 免 --remote-debugging-port，解学习通 Chrome for Testing 的死结 |
| 5 | 回合转向 Steer | 任务运行中用户插话改需求（它有 SteerAsync/InterruptAsync，体验杀手锏） |

### M2 · 生态与分发（赛后 1-2 月）

| # | 任务 | 说明 |
|---|---|---|
| 1 | 定时例程（应用内） | RoutineScheduler 对标；与 TeleAgent scheduler 打通 |
| 2 | 本地小模型可选包 | ONNX Runtime + DirectML（它已验证 Win11 NPU 路线），离线 ASR/意图 |
| 3 | 打包分发 + 自动更新 | electron-builder + Velopack 同类方案 |
| 4 | skill 市场 | 灵标技能开放回 TeleAgent 平台，双向生态 |
| 5 | 多 agent（可选） | 它 multi_agent=true；灵标「主球+分身」形态天然契合 |

---

## 六、风险与不追清单

**风险**
1. M0 范围膨胀——skills+prompt 已够演示，工具位加 2 个封顶
2. DeepSeek 上下文 128K < codex 160K 压缩线——压缩策略照抄落点，超限即 checkpoint
3. 执行型操作破坏用户数据——确认分级是护栏，执行前快照剪贴板/选区已有，M1 补文件级回收站
4. 比赛前换架构 = 自杀——M0 只做增量，agent.ts 主干不动

**不追清单（明确不做，防止范围爬）**
- 不嵌任何第三方 agent 运行时（codex/OpenCode/Claude Code）
- 不做云端计费/租约/账号体系
- 不做 Composio 式连接器矩阵
- 不做原生 WinUI/DirectX 重写（898MB 换性能，不值）
- 不做 guardian 式云端安全审查（本地分级足够，且是差异点）

---

## 七、答辩话术锚点（背诵用）

1. 「DeepMind 说指针是意图的自然入口，heyClicky 用光标做了 agent 入口——我们把**同一套洞察**带进了
   Windows 桌面，且**覆盖任意应用**、**中文全链路**、**教而不代**。」
2. 「heyClicky 的 agent 是嵌的开源 Codex；我们的 harness 是自研 ReAct，模型层一根环境变量就能换——
   这不是套壳，是**壳与脑分离**的架构红利。」
3. 「工具生态我们押 SKILL.md：heyClicky、TeleAgent、灵标三方同格式，一份技能三处能跑。」
4. 「它客户端全放开、云端守；我们本地分级确认——AI 有分寸，是产品哲学不是合规补丁。」

> AI生成
