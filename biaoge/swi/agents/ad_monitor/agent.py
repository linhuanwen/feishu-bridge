"""
广告监控 Agent — 自动检查 WB 各店广告表现，异常即时告警。

检测规则：
  1. CTR < 0.3%（老广告） → 警告
  2. CTR < 0.1% → 紧急告警
  3. 日花费超预算20%且0单 → 告警
  4. 展示高但零点击 → 检查主图
"""
from datetime import datetime
from swi.core.agent_base import BaseAgent, AgentResult
from swi.core.event_types import Event, EventType


class AdMonitorAgent(BaseAgent):
    """WB 广告监控。"""

    agent_id = "ad_monitor"
    agent_name = "广告监控"
    schedule = "0 */3 * * *"                  # 每3小时
    description = "自动检查各店广告CTR/花费/订单，异常即时告警"

    # 阈值（可在 agents.yaml 中覆盖）
    CTR_WARNING = 0.3       # CTR 低于此值警告
    CTR_CRITICAL = 0.1      # CTR 低于此值紧急
    SPEND_NO_ORDER_RATIO = 1.2  # 花费超预算比例且0单
    MIN_IMPRESSIONS = 100    # 最少展示数才判断

    def __init__(self, config: dict = None):
        super().__init__(config)
        self._client = None
        # 用 config 覆盖默认阈值
        if config:
            self.CTR_WARNING = float(config.get("ctr_warning", self.CTR_WARNING))
            self.CTR_CRITICAL = float(config.get("ctr_critical", self.CTR_CRITICAL))
            self.SPEND_NO_ORDER_RATIO = float(config.get("spend_no_order_ratio", self.SPEND_NO_ORDER_RATIO))

    async def initialize(self):
        """初始化 WB 客户端。"""
        from swi.integrations.wb_client import WBClient, WBConfig

        wb_config = WBConfig(
            api_key=self._config.get("api_key", ""),
            data_dir=self._config.get("data_dir", "data/imports"),
            stores=self._config.get("stores", ["默认店铺"]),
        )
        self._client = WBClient(wb_config)
        self.logger.info(f"WB客户端就绪 | API={'已配置' if wb_config.api_key else '未配置，使用CSV模式'}")

    async def execute(self) -> AgentResult:
        """检查广告数据，检测异常。"""
        if not self._client:
            return self.fail("WB客户端未初始化")

        metrics_list = await self._client.fetch_metrics()
        if not metrics_list:
            return self.warn("没有广告数据，请确认：\n1. WB后台导出CSV放入 data/imports/\n2. 或配置 WB API Key")

        anomalies = self._detect(metrics_list)
        total_campaigns = len(set(m.campaign_id for m in metrics_list))
        total_spend = sum(m.spend for m in metrics_list)
        total_orders = sum(m.orders for m in metrics_list)

        summary = f"检查 {total_campaigns} 个广告活动 | 花费 ¥{total_spend:.0f} | 订单 {total_orders}"

        if anomalies:
            # 钉钉 + 桌面通知
            alert_text = f"**广告异常 ({len(anomalies)}项)**\n\n" + "\n\n".join(anomalies)
            await self.notify("广告预警", alert_text, priority=1)
            # 桌面紧急弹窗（有严重问题时）
            if any("紧急" in a for a in anomalies):
                await self.notify("广告紧急预警", alert_text, priority=2)

            summary += f" | 异常: {len(anomalies)}项"

        return self.ok(
            summary=summary,
            campaigns=total_campaigns,
            spend=total_spend,
            orders=total_orders,
            anomalies=len(anomalies),
        )

    def _detect(self, metrics: list) -> list[str]:
        """检测广告异常，返回告警文本列表。"""
        alerts = []

        # 按 campaign 聚合
        from collections import defaultdict
        camp_data = defaultdict(lambda: {"impressions": 0, "clicks": 0, "spend": 0, "orders": 0, "ctr_values": []})

        for m in metrics:
            d = camp_data[m.campaign_id]
            d["store"] = m.store
            d["name"] = m.campaign_name or m.campaign_id
            d["product"] = m.product_name
            d["impressions"] += m.impressions
            d["clicks"] += m.clicks
            d["spend"] += m.spend
            d["orders"] += m.orders
            if m.ctr > 0:
                d["ctr_values"].append(m.ctr)

        for camp_id, d in camp_data.items():
            name = d["name"] or camp_id
            product = d["product"]
            store = d["store"]
            impressions = d["impressions"]
            clicks = d["clicks"]
            spend = d["spend"]
            orders = d["orders"]

            if impressions < self.MIN_IMPRESSIONS:
                continue

            # 计算平均 CTR
            avg_ctr = sum(d["ctr_values"]) / len(d["ctr_values"]) if d["ctr_values"] else 0

            # 1. CTR 检查
            if avg_ctr > 0:
                if avg_ctr < self.CTR_CRITICAL:
                    alerts.append(
                        f"**紧急 | CTR极低**\n"
                        f"店铺: {store}\n"
                        f"活动: {name} ({camp_id[:12]}...)\n"
                        f"产品: {product}\n"
                        f"CTR: {avg_ctr:.2f}% (阈值 {self.CTR_CRITICAL}%)\n"
                        f"花费: ¥{spend:.0f}\n"
                        f"建议: 立即检查主图吸引力，暂停无效投放"
                    )
                elif avg_ctr < self.CTR_WARNING:
                    alerts.append(
                        f"**CTR偏低**\n"
                        f"店铺: {store}\n"
                        f"活动: {name}\n"
                        f"产品: {product}\n"
                        f"CTR: {avg_ctr:.2f}% (阈值 {self.CTR_WARNING}%)\n"
                        f"花费: ¥{spend:.0f}\n"
                        f"建议: 检查关键词精准度，优化主图"
                    )

            # 2. 花费高但零订单
            if spend > 50 and orders == 0 and impressions > 500:
                alerts.append(
                    f"**花钱没单**\n"
                    f"店铺: {store}\n"
                    f"活动: {name}\n"
                    f"花费: ¥{spend:.0f} | 展示: {impressions} | 订单: 0\n"
                    f"建议: 检查产品定价、转化率、关键词相关性"
                )

            # 3. 展示高但零点击
            if impressions > 1000 and clicks == 0:
                alerts.append(
                    f"**展示高但没人点**\n"
                    f"店铺: {store}\n"
                    f"活动: {name}\n"
                    f"展示: {impressions}次 | 点击: 0\n"
                    f"建议: 主图或标题不够吸引人，或投放人群不匹配"
                )

        return alerts
