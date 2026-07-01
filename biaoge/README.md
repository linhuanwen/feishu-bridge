# 超级工作个体 (Super Work Individual)

AI 智能体工作管家，通过飞书实时交互。

---

## 快速开始

### 1. 安装
```powershell
# 双击 setup.bat 或手动：
pip install -r requirements.txt
python run.py init
```

### 2. 配置
编辑 `config/feishu.yaml`，填入飞书 App 凭证和 Webhook 地址。

### 3. 启动
```powershell
python run.py start
```

---

## 目录结构

```
├── swi/
│   ├── core/                  # 框架核心（Agent基类、调度器、消息总线）
│   ├── agents/                # 智能体（每个一个文件夹）
│   │   ├── hello_agent/       # 心跳检测
│   │   └── ad_monitor/        # 广告监控
│   ├── integrations/          # 外部集成
│   │   ├── feishu/            # 飞书（消息+表格）
│   │   ├── dingtalk/          # 钉钉（保留）
│   │   └── desktop/           # 桌面通知
│   ├── services/              # 业务服务（任务管理器）
│   ├── dashboard/             # Web仪表盘
│   ├── data/                  # 数据库
│   └── utils/                 # 工具
├── config/                    # 配置文件
├── run.py                     # 入口
└── setup.bat                  # 一键安装
```

---

## 命令行

| 命令 | 说明 |
|---|---|
| `python run.py start` | 启动系统 |
| `python run.py status` | 查看Agent状态 |
| `python run.py trigger <id>` | 手动触发Agent |
| `python run.py test-desktop` | 测试桌面通知 |
| `python run.py init` | 初始化数据库 |

---

## 添加新 Agent

1. 复制 `swi/agents/_template/` → `swi/agents/<你的Agent>/`
2. 编辑 `agent.py`：设置 `agent_id`、`agent_name`、`schedule`，实现 `execute()`
3. 在 `config/agents.yaml` 注册
