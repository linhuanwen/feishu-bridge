"""
配置加载器 - Pydantic 模型 + YAML 文件 + 环境变量覆盖。
三层优先级：环境变量 > YAML文件 > Pydantic默认值
"""
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
import yaml


# ─── 配置模型 ─────────────────────────────────────────

class DingTalkConfig(BaseModel):
    """钉钉机器人配置。"""
    webhook_url: str = ""
    secret: str = ""              # 加签密钥
    enabled: bool = True
    rate_limit_per_minute: int = 20
    retry_times: int = 3
    retry_seconds: float = 5.0


class FeishuBitableConfig(BaseModel):
    """飞书多维表格配置。"""
    app_token: str = ""
    table_id: str = ""


class FeishuSettings(BaseModel):
    """飞书应用配置。"""
    app_id: str = ""
    app_secret: str = ""
    webhook_url: str = ""
    bot_name: str = "工作管家"
    encrypt_key: str = ""
    verification_token: str = ""
    chat_app_id: str = ""       # 推送专用应用 ID（用于发消息到群）
    chat_app_secret: str = ""   # 推送专用应用 Secret
    target_chat_name: str = ""  # 目标推送群聊名称（自动查找 chat_id）
    target_chat_id: str = ""    # 目标推送群聊 ID（直接指定，跳过查找）
    bitable: FeishuBitableConfig = Field(default_factory=FeishuBitableConfig)


class LLMSettings(BaseModel):
    """LLM API 配置 — 默认对接 DeepSeek。"""
    api_key: str = ""
    model: str = "deepseek-chat"
    max_tokens: int = 4096
    temperature: float = 0.3
    api_base: str = "https://api.deepseek.com/v1"


class AgentConfig(BaseModel):
    """单个 Agent 的运行时配置。"""
    enabled: bool = True
    schedule: str = ""          # cron 表达式
    description: str = ""       # 中文描述
    config: dict = Field(default_factory=dict)  # Agent 专属配置


class GlobalSettings(BaseSettings):
    """全局设置，支持环境变量 SWI_ 前缀覆盖。"""
    model_config = SettingsConfigDict(
        env_prefix="SWI_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 项目路径
    project_dir: Path = Path(__file__).parent.parent.parent
    config_dir: Path = Path("config")
    data_dir: Path = Path("data")
    log_dir: Path = Path("logs")

    # 日志
    log_level: str = "INFO"

    # 调度器
    scheduler_timezone: str = "Asia/Shanghai"

    # 仪表盘
    dashboard_host: str = "127.0.0.1"
    dashboard_port: int = 8080


# ─── 配置加载函数 ─────────────────────────────────────

def _resolve_path(base_dir: Path, path: Path) -> Path:
    """如果 path 是相对路径，用 base_dir 解析。"""
    if path.is_absolute():
        return path
    return base_dir / path


def load_yaml(filepath: Path) -> dict:
    """加载 YAML 文件，文件不存在返回空字典。"""
    if not filepath.exists():
        return {}
    with open(filepath, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data or {}


class ConfigManager:
    """
    统一配置管理器。
    用法：
        cm = ConfigManager(project_dir=Path("."))
        settings = cm.settings
        agents = cm.agents        # dict[str, AgentConfig]
        dingtalk = cm.dingtalk    # DingTalkConfig
    """

    def __init__(self, project_dir: Path):
        self.project_dir = Path(project_dir).resolve()

        # 解析配置目录
        self.config_dir = self.project_dir / "config"
        self.data_dir = self.project_dir / "data"
        self.log_dir = self.project_dir / "logs"

        # 确保必要目录存在
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # 加载
        self.settings = self._load_settings()
        self.agents = self._load_agents()
        self.dingtalk = self._load_dingtalk()
        self.feishu = self._load_feishu()
        self.llm = self._load_llm()

    def _load_settings(self) -> GlobalSettings:
        """加载全局设置。"""
        yaml_data = load_yaml(self.config_dir / "settings.yaml")
        return GlobalSettings(
            project_dir=self.project_dir,
            config_dir=self.config_dir,
            data_dir=self.data_dir,
            log_dir=self.log_dir,
            **{k: v for k, v in yaml_data.items() if k in GlobalSettings.model_fields},
        )

    def _load_agents(self) -> dict[str, AgentConfig]:
        """加载 Agent 配置，按 agent_id 索引。"""
        raw = load_yaml(self.config_dir / "agents.yaml")
        if not raw or "agents" not in raw:
            return {}
        result = {}
        for agent_id, cfg in raw["agents"].items():
            result[agent_id] = AgentConfig(**cfg)
        return result

    def _load_dingtalk(self) -> DingTalkConfig:
        """加载钉钉配置。"""
        raw = load_yaml(self.config_dir / "dingtalk.yaml")
        return DingTalkConfig(**raw) if raw else DingTalkConfig()

    def _load_feishu(self) -> FeishuSettings:
        """加载飞书配置。"""
        raw = load_yaml(self.config_dir / "feishu.yaml")
        if not raw:
            return FeishuSettings()
        # bitable 是嵌套结构，先提取再展开
        bitable_raw = raw.pop("bitable", {})
        return FeishuSettings(
            bitable=FeishuBitableConfig(**bitable_raw) if bitable_raw else FeishuBitableConfig(),
            **raw,
        )

    def _load_llm(self) -> LLMSettings:
        """加载 LLM 配置。"""
        raw = load_yaml(self.config_dir / "llm.yaml")
        return LLMSettings(**raw) if raw else LLMSettings()
