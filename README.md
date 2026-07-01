# Feishu Bridge（飞书桥）

通过飞书消息远程操控 Windows 电脑 —— 本地命令执行、单次 AI 查询、多轮 AI 编程会话。

- [AGENTS.md](AGENTS.md) — AI 编码代理使用说明
- [PRD](.scratch/feishu-remote-control/PRD.md) — 产品需求文档

---

## 目录

- [快速理解](#快速理解)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [用户使用指南](#用户使用指南)
  - [三类消息](#三类消息)
  - [完整命令参考](#完整命令参考)
  - [会话管理](#会话管理)
  - [权限确认](#权限确认)
- [消息处理流程](#消息处理流程)
- [架构概览](#架构概览)
- [源文件地图](#源文件地图)
- [故障排查](#故障排查)
- [维护与变更](#维护与变更)

---

## 快速理解

你在飞书群里发一条消息，Bridge 自动判断意图并执行：

| 类型 | 干什么 | 举个例子 | 调 AI 吗 |
|---|---|---|---|
| **simple** | 本地操作，秒回 | `截图`、`打开 notepad`、`ls` | ❌ 不调 |
| **inquire** | 单次问答，一问一答 | `读取 README.md`、`搜索 TODO`、`解释代码` | ✅ 调一次 |
| **task** | 多轮对话，持续协作 | `审查 d:\myproject 的代码`、`重构 src/utils.ts` | ✅ 多轮会话 |

核心区别：
- **simple** 由 Bridge 自己处理（纯本地执行，零延迟）。
- **inquire** 和 **task** 都进入 Claude Code。区别是 inquire 一问一答不保留上下文，task 保留上下文、支持续接、可多轮对话。
- **DeepSeek** 负责意图分类和 AI 任务执行。不可用时自动降级到正则匹配。

---

## 环境要求

| 组件 | 用途 | 必需 |
|---|---|---|
| Node.js ≥ 18 | 运行 Bridge | ✅ |
| Claude Code（VSCode 扩展或 CLI） | 执行 AI 任务 | ✅（inquire/task 需要） |
| 飞书自建应用（WebSocket 长连接） | 消息收发 | ✅ |
| DeepSeek API | 意图分类 + AI 执行 | ✅（inquire/task 需要） |

---

## 快速开始

**1. 配置环境变量**

复制 `.env.example` 并填入飞书自建应用的凭证：

```bash
cp .env.example .env
# 编辑 .env，填入 FEISHU_APP_ID 和 FEISHU_APP_SECRET
```

**2. 安装依赖**

```bash
npm install
```

**3. 启动服务**

```bash
npm start        # 生产模式
npm run dev      # 开发模式（TS 热重载）
start.bat        # Windows 双击启动
```

启动后向飞书 Bot 发送消息即可使用。

**4. 运行测试**

```bash
npm test
```

---

## 环境变量

```bash
# ── 必填 ──
FEISHU_APP_ID=cli_xxxxx              # 飞书应用 App ID
FEISHU_APP_SECRET=xxxxx              # 飞书应用 App Secret

# ── 白名单（逗号分隔的 open_id）──
FEISHU_ALLOWED_OPEN_IDS=ou_xxx,ou_yyy

# ── 可选 ──
CLAUDE_CLI_PATH=C:\path\to\claude.exe     # Claude CLI 路径（不设则自动发现）
FEISHU_TASK_TIMEOUT_MS=900000             # task 超时毫秒数（默认 15 分钟）
FEISHU_NOTIFY_CHAT_ID=oc_xxx              # 系统通知目标群（健康检查/崩溃通知/权限卡片）
FEISHU_PERMISSION_PORT=19384              # 权限桥 HTTP 端口
FEISHU_LOG_DIR=./logs                     # 日志目录
FEISHU_AUTO_STARTUP=true                  # 设为 true 则开机自启
FEISHU_HIGH_RISK_ACTIONS=delete,install   # 高风险操作（需飞书确认）
FEISHU_LOW_RISK_ACTIONS=list_dir,read_file # 低风险操作（直接执行）
```

---

## 用户使用指南

### 三类消息

#### ① simple — 本地命令

直接操作电脑，**不经过 AI**，秒级响应。

```
截图                       → 截取当前屏幕
ls / dir                   → 列出当前目录
系统状态 / 状态             → CPU、内存、磁盘信息
打开 notepad / 关闭 notepad → 启停程序
日期 / 时间                 → 当前日期时间
ping baidu.com             → 网络测试
```

> 高风险操作（删除文件、运行脚本等）会弹出飞书确认卡片，需点击按钮确认后才执行。

#### ② inquire — 单次查询

调用 Claude Code 进行一次问答，**不保留上下文**，60 秒超时。

```
读取 d:\tool\yuancheng\README.md       → 查看文件内容
搜索 src/ 中的 TODO                     → 代码搜索
解释一下 src/main.ts 的启动流程          → 代码解释
```

#### ③ task — 多轮任务

调用 Claude Code 创建/续接会话，**保留上下文**，支持多轮对话。消息中必须包含项目路径。

```
在 d:\tool\yuancheng 审查代码            → 创建新会话，审查代码
重构 d:\tool\yuancheng\src\utils.ts      → 指定项目目录，开始多轮对话
d:\myproject 帮我加一个登录功能            → 新项目新会话
```

发送第一条 task 消息后，**同群后续消息会自动续接该会话**，无需再次指定路径。

---

### 完整命令参考

#### 本地命令（simple）

| 命令 | 说明 |
|---|---|
| `截图` / `拍照` / `屏幕` | 截取当前屏幕 |
| `ls` / `dir` / `列出` / `目录` | 列出文件 |
| `打开 <程序>` / `启动 <程序>` | 打开应用（如 `打开 notepad`） |
| `关闭 <程序>` / `停止 <程序>` | 关闭应用 |
| `系统状态` / `状态` | CPU、内存、磁盘 |
| `日期` / `时间` / `现在几点` | 当前时间 |
| `ping <地址>` / `ipconfig` | 网络工具 |
| `帮助` / `help` / `怎么用` | 显示帮助 |

#### 会话管理（task）

| 命令 | 说明 |
|---|---|
| `列出对话` / `对话列表` | 显示所有已知会话 |
| `列出对话 <关键词>` | 按项目名筛选（如 `列出对话 yuancheng`） |
| `进入对话 <序号>` | 切换到指定会话（序号来自列表） |
| `进入对话 <UUID前8位>` | 按 UUID 精确进入 |
| `新对话` | 离开当前会话，下次消息创建新会话 |
| `当前对话` | 查看当前活跃会话详情 |
| `切换项目 <路径>` | 切换到新项目目录 |
| `/compact` / `/clear` 等 | Claude Code 内置命令 |

---

### 会话管理

**每个飞书群对应一个活跃会话。** 同群内的消息都续接到同一会话。

```
新消息(含项目路径)
  │
  ▼
创建会话 ──→ 自动生成 .claude/settings.json（权限 hook 配置）
  │
  ▼
执行任务 ──→ 首次完成后发现 Claude Code 真实 UUID，更新注册表
  │
  ▼
后续消息 ──→ 自动 --resume 续接同一会话
  │
  ├── 30 分钟无活动 → 注册表过期清理（磁盘文件仍保留）
  │
  └── 通过「列出对话」→「进入对话」可随时找回
```

关键行为：
- **项目路径来自消息**：Bridge 自动从消息中提取 `盘符:\路径` 格式的 Windows 绝对路径。
- **首次后纠正 UUID**：Bridge 先用临时 ID 发起调用，完成后从磁盘发现 Claude Code 的真实 UUID 并更新注册表。
- **--resume 失败自动重建**：会话过期或损坏时，Bridge 自动创建新会话（回退到 `-p` 模式），不丢任务。

---

### 权限确认

高危操作通过飞书交互卡片确认：

```
Claude Code 要执行危险操作（Bash 命令、写文件等）
  │
  ▼
PreToolUse hook 触发 permissionBridge.js
  │
  ▼
HTTP POST → Bridge 本地 HTTP Server (19384)
  │
  ▼
Bridge 发送飞书卡片（三个按钮）
  │
  ├── ✅ 允许一次   → 执行本次操作
  ├── 📌 始终允许   → 执行 + 写入项目白名单，后续同类操作自动放行
  └── ❌ 拒绝       → 拒绝本次操作
  │
  ▼
卡片更新为确认结果
```

**默认高风险操作**：`delete`、`system_config`、`install`、`uninstall`、`registry_write`、`run_script`

可通过环境变量调整：
```bash
FEISHU_HIGH_RISK_ACTIONS=delete,install,run_script
FEISHU_LOW_RISK_ACTIONS=list_dir,read_file,screenshot
```

---

## 消息处理流程

```
┌─ 飞书消息到达 ───────────────────────────────────────────────┐
│                                                               │
│  1. 过滤：Bot 消息忽略；SWI 命令转发/跳过                       │
│  2. 提取文本：解析 JSON 取 text，去 @mention                    │
│  3. 白名单校验：不在白名单 → 回复拒绝并给出 open_id              │
│  4. 意图分类：                                                 │
│     ├─ 正则快速匹配（明显命令直接分类，不调 AI）                  │
│     └─ DeepSeek 回退（正则无法确定时调用，API 挂掉则默认 task） │
│                                                               │
│  5. 路由执行：                                                 │
│     ├─ simple                                                  │
│     │   └─ 低风险直接执行 / 高风险飞书卡片确认后执行              │
│     │                                                         │
│     ├─ inquire                                                │
│     │   └─ runClaudeInteractive(PTY) 单次，60s 超时             │
│     │                                                         │
│     └─ task                                                   │
│         ├─ 元命令（列出对话/进入对话/切换项目）→ 本地处理         │
│         └─ 任务消息 → callClaudeForTask(PTY, --resume), 15min 超时 │
│                                                               │
│  6. 回复：文本/富文本/图片 + 撤回临时状态消息                    │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 三种路径的本质区别

| | simple | inquire | task |
|---|---|---|---|
| 调用 Claude Code | ❌ | ✅ 单次 | ✅ 多轮 |
| 会话上下文 | 无 | 无 | 有（--resume） |
| 超时 | 秒级 | 60s | 15min（可配） |
| 触发权限卡片 | simple 自身有门禁 | ✅ PTY → PreToolUse | ✅ PTY → PreToolUse |
| 典型场景 | ls、截图、打开程序 | 读文件、搜索、解释代码 | 重构、写功能、多轮编程 |

---

## 架构概览

```
┌──────────────────────────────────────────────────────┐
│                     飞书服务器                         │
└──────────────────────┬───────────────────────────────┘
                       │ WebSocket
┌──────────────────────▼───────────────────────────────┐
│                   Feishu Bridge                       │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ 意图分类器    │  │ 消息管道      │  │ 会话注册表  │  │
│  │ 正则+DeepSeek│  │ 三类路由      │  │ 内存+磁盘   │  │
│  │             │  │              │  │ 30min 过期  │  │
│  └─────────────┘  └──────┬───────┘  └─────────────┘  │
│                          │                            │
│         ┌────────────────┼────────────────┐          │
│         ▼                ▼                ▼          │
│   本地命令执行      Claude Code        Claude Code    │
│   (无需 AI)      单次调用 (PTY)     会话 (PTY)       │
│         │                │                │          │
│         └────────────────┼────────────────┘          │
│                          │                            │
│              ┌───────────▼───────────┐               │
│              │   权限桥 HTTP Server   │               │
│              │   port 19384          │               │
│              │   ← permissionBridge  │               │
│              └───────────┬───────────┘               │
│                          │                            │
└──────────────────────────┼────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │   飞书确认卡片   │
                  │ ✅允许 📌始终 ❌拒绝 │
                  └─────────────────┘
```

---

## 源文件地图

| 文件 | 职责 |
|---|---|
| `src/main.ts` | 启动入口，组装所有依赖，HTTP 权限服务器，健康检查 |
| `src/handleClassifiedMessage.ts` | 消息路由分发（所有消息的入口函数） |
| `src/classifyIntent.ts` | 意图分类（正则快速匹配 + DeepSeek 回退） |
| `src/createDeepSeekClassifier.ts` | DeepSeek API 客户端（意图分类） |
| `src/executeSimpleCommand.ts` | 本地命令执行（ls/截图/启停程序/运行脚本） |
| `src/executeInquire.ts` | 单次 Claude 查询（构建 prompt + 60s 超时） |
| `src/executeTask.ts` | 多轮会话管理与执行（元命令 + --resume 续接） |
| `src/runClaude.ts` | Claude Code CLI 调用（PTY 交互模式 / `-p` 打印模式） |
| `src/sessionRegistry.ts` | 会话注册表（内存 Map + sessions.json 持久化） |
| `src/createMessagePipeline.ts` | 管道组装（注入依赖 + 权限门包装） |
| `src/createPermissionGate.ts` | 权限门禁（低风险直接放行，高风险飞书确认） |
| `src/permissionBridge.ts` | Claude Code PreToolUse hook 脚本（桥接到 Bridge HTTP） |
| `src/createFeishuBridge.ts` | 飞书 SDK WebSocket 连接与事件注册 |
| `src/createPermissionLogger.ts` | 权限决策日志 |
| `src/createClaudeSettingsWriter.ts` | 自动生成项目 .claude/settings.json |
| `src/createHealthChecker.ts` | 定期健康检查（DeepSeek + Claude CLI） |
| `src/withAutoRestart.ts` | 崩溃自动重启（最多 3 次） |
| `src/discoverClaudeSessions.ts` | 扫描磁盘发现所有 Claude Code 会话 |

---

## 故障排查

### 服务不响应

1. 检查日志：`logs/` 目录下的最新文件
2. 确认启动日志有 `✅ Feishu Bridge 已在线`
3. 确认白名单包含发送者的 `open_id`

### AI 任务失败

1. **Claude Code CLI 不可用**：确认 VSCode 安装了 Claude Code 扩展，或设置 `CLAUDE_CLI_PATH`
2. **DeepSeek API 不可用**：不影响核心功能，分类降级到正则 + 默认 task
3. **task 超时**：调大 `FEISHU_TASK_TIMEOUT_MS`（默认 900000 = 15 分钟）

### 权限卡片不弹出

1. 确认 `FEISHU_NOTIFY_CHAT_ID` 已配置
2. 确认日志有 `权限桥 HTTP 服务器已启动: http://127.0.0.1:19384`
3. 确认目标项目的 `.claude/settings.json` 包含 `PreToolUse` hook（首次 task 自动生成）

### 会话恢复失败

- **正常行为**：Bridge 自动捕获 `--resume` 失败并回退到 `-p` 模式创建新会话
- 旧会话仍保留在磁盘，可通过 `列出对话` → `进入对话` 找回

---

## 维护与变更

### 添加新的本地命令

1. 在 `src/commands.config.json` 中添加命令别名
2. 在 `src/classifyIntent.ts` 的 `SIMPLE_PATTERNS` 中添加匹配正则
3. 如需新操作类型，在 `src/executeSimpleCommand.ts` 中实现并注册

### 调整意图分类

- **正则规则**：修改 `src/classifyIntent.ts` 中的 `SIMPLE_PATTERNS` / `INQUIRE_PATTERNS` / `SESSION_PATTERNS`
- **DeepSeek prompt**：修改 `src/createDeepSeekClassifier.ts` 中的 `buildClassifierPrompt()`
- **切换 DeepSeek 模型**：修改 `src/createDeepSeekClassifier.ts` 中的默认模型

### 调整权限规则

- 高低风险操作列表：环境变量 `FEISHU_HIGH_RISK_ACTIONS` / `FEISHU_LOW_RISK_ACTIONS`
- 权限确认超时：`src/main.ts` 中 `requestPermissionViaCard` 的定时器（默认 120s）
- 项目自动白名单：用户通过「始终允许」按钮写入 `addToProjectAllowlist()`

### 更新本文档

以下变更需要同步更新本 README：
- 新增/删除消息分类类型
- 新增/删除环境变量
- 会话管理行为变更
- 权限模型变更
- 启动方式变更
- 新增/删除模块文件
