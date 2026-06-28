# Feishu Bridge

通过飞书 Bot 远程操控 Windows 电脑——浏览文件、执行脚本、Claude Code 编程，安全且低成本。

- [AGENTS.md](AGENTS.md) — AI 编码代理使用说明
- [PRD](.scratch/feishu-remote-control/PRD.md) — 产品需求文档

## 快速开始

1. 复制环境变量模板并填入飞书自建应用的凭证：

   ```bash
   cp .env.example .env
   # 编辑 .env，填入 FEISHU_APP_ID 和 FEISHU_APP_SECRET
   ```

2. 安装依赖：

   ```bash
   npm install
   ```

3. 安装 Ollama 并拉取模型：

   ```bash
   # Windows: 从 https://ollama.com/download 下载安装程序
   # 安装完成后，运行：
   ollama pull qwen2.5:7b
   ```

4. 启动服务：

   ```bash
   npm start
   ```

   启动后，在飞书向 Bot 发送任意消息，Bot 会先进行意图分类并回复：

   ```
   分类为：simple
   ```

5. 运行测试：

   ```bash
   npm test
   ```

## 项目结构

```
src/
  main.ts                       # 服务入口
  createFeishuBridge.ts         # 飞书 SDK 连接与事件注册
  createMessagePipeline.ts      # 消息处理管道
  classifyIntent.ts             # Ollama 意图分类
  createOllamaClassifier.ts     # Ollama HTTP 客户端
  handleClassifiedMessage.ts    # 分类后消息分发
  executeSimpleCommand.ts       # 简单指令执行
  executeInquire.ts             # 文件查询执行
  createPermissionGate.ts       # 高危操作确认门
  getSystemStatus.ts            # 系统状态查询
  captureScreenshot.ts          # 桌面截图
  listDirectory.ts              # 目录浏览
  programManager.ts             # 程序启停管理
  createRotatingLogger.ts       # 日志轮转
  createHealthChecker.ts        # 健康检查
  createStartupManager.ts       # 开机自启
  withAutoRestart.ts            # 崩溃重启
  formatErrorMessage.ts         # 错误格式化
```

## 意图分类

本地 Ollama（默认 `qwen2.5:7b`）把消息分为三类：

- `simple` — 目录浏览、系统状态、截图、程序启停等，本地直接执行
- `inquire` — 文件内容读取，通过 Claude Code 单次查询处理
- `task` — 多轮对话的复杂任务（代码审查、重构等），使用 Claude Code 会话续接

## 安全

- **身份白名单**：仅预配置的飞书用户可触发操作
- **高危确认门**：删除文件、运行脚本等高危操作需飞书二次确认
- 低危操作（查状态、截图、列目录）直接执行
