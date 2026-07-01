"""
Wildberries 客户端 — API 对接 + CSV 导入兜底。

WB API 文档: https://open.wb.ru/
"""
import csv
import io
from pathlib import Path
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from loguru import logger
import httpx


@dataclass
class WBConfig:
    """WB API 配置。"""
    api_key: str = ""             # WB API Key (JWT)
    api_url: str = "https://advert-api.wb.ru"
    content_api_url: str = "https://content-api.wb.ru"  # 内容/统计API
    stores: list[str] = field(default_factory=list)  # 店铺名列表
    data_dir: str = "data/imports"  # CSV 导入目录


@dataclass
class AdMetrics:
    """单条广告指标。"""
    store: str = ""               # 店铺名
    campaign_id: str = ""         # 广告活动ID
    campaign_name: str = ""
    product_name: str = ""        # 产品名
    date: str = ""                # YYYY-MM-DD
    impressions: int = 0          # 展示次数
    clicks: int = 0               # 点击次数
    ctr: float = 0.0             # 点击率 (%)
    spend: float = 0.0           # 花费
    orders: int = 0              # 订单数
    revenue: float = 0.0         # 销售额

    @classmethod
    def from_api_row(cls, store: str, row: dict) -> "AdMetrics":
        """从 WB API 响应构造。"""
        return cls(
            store=store,
            campaign_id=str(row.get("advertId", row.get("campaignId", ""))),
            campaign_name=row.get("name", row.get("campaignName", "")),
            product_name=row.get("subject", {}).get("name", "") if isinstance(row.get("subject"), dict) else "",
            date=row.get("date", str(datetime.now().date())),
            impressions=int(row.get("views", 0)),
            clicks=int(row.get("clicks", 0)),
            ctr=float(row.get("ctr", 0)),
            spend=float(row.get("sum", 0)),
            orders=int(row.get("orders", 0)),
            revenue=float(row.get("sum_price", 0)),
        )

    @classmethod
    def from_csv_row(cls, store: str, row: dict) -> "AdMetrics":
        """从 CSV 行构造。字段名兼容 WB 广告报表导出格式。"""
        def _get(*keys):
            for k in keys:
                v = row.get(k, "")
                if v:
                    return v
            return ""

        def _num(val, default=0):
            try:
                return float(str(val).replace(",", ".").replace(" ", ""))
            except (ValueError, TypeError):
                return default

        return cls(
            store=store,
            campaign_id=_get("campaign_id", "advertId", "广告活动ID", "№"),
            campaign_name=_get("campaign_name", "name", "广告活动名称", "Название"),
            product_name=_get("product_name", "subject", "产品名称", "Предмет"),
            date=_get("date", "日期", "Дата"),
            impressions=int(_num(_get("impressions", "views", "展示次数", "Показы"))),
            clicks=int(_num(_get("clicks", "点击次数", "Клики"))),
            ctr=_num(_get("ctr", "CTR", "点击率"), 0.0),
            spend=_num(_get("spend", "sum", "花费", "Затраты")),
            orders=int(_num(_get("orders", "订单数", "Заказы"))),
            revenue=_num(_get("revenue", "sum_price", "销售额", "Выручка")),
        )


class WBClient:
    """Wildberries 数据客户端。优先 API，回退 CSV。"""

    def __init__(self, config: WBConfig):
        self.config = config
        self._http = httpx.AsyncClient(timeout=30)

    @property
    def api_ready(self) -> bool:
        return bool(self.config.api_key)

    # ─── 数据获取 ──────────────────────────────

    async def fetch_metrics(self, date_from: str = None) -> list[AdMetrics]:
        """获取广告指标。优先 API，没有则读 CSV。"""
        if self.api_ready:
            return await self._fetch_from_api(date_from)
        return self._fetch_from_csv()

    async def _fetch_from_api(self, date_from: str = None) -> list[AdMetrics]:
        """通过 WB Advertising API 获取数据。"""
        if not date_from:
            from datetime import timedelta
            date_from = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d")

        date_to = datetime.now().strftime("%Y-%m-%d")
        results = []
        headers = {
            "Authorization": self.config.api_key,
            "Accept": "application/json",
        }

        try:
            # Step 1: 获取活跃广告活动列表
            resp = await self._http.get(
                f"{self.config.api_url}/adv/v1/promotions",
                headers=headers,
                params={"status": "active", "limit": 100},
            )
            if resp.status_code != 200:
                logger.error(f"WB API 获取活动列表失败: {resp.status_code} {resp.text[:200]}")
                return self._fetch_from_csv()

            campaigns = resp.json()
            if not isinstance(campaigns, list):
                campaigns = campaigns.get("adverts", campaigns.get("promotions", []))

            logger.info(f"WB API: 获取到 {len(campaigns)} 个活跃广告活动")

            # Step 2: 逐个获取统计数据
            for camp in campaigns[:50]:
                camp_id = camp.get("advertId") or camp.get("id") or camp.get("advert_id")
                camp_name = camp.get("name", "")
                product_name = ""
                if isinstance(camp.get("subject"), dict):
                    product_name = camp["subject"].get("name", "")
                elif "subjectName" in camp:
                    product_name = camp["subjectName"]

                try:
                    stats_resp = await self._http.get(
                        f"{self.config.api_url}/adv/v2/fullstats",
                        headers=headers,
                        params={
                            "advertId": camp_id,
                            "from": date_from,
                            "to": date_to,
                            "interval": "day",
                        },
                    )
                    if stats_resp.status_code == 200:
                        stats_data = stats_resp.json()
                        days = stats_data if isinstance(stats_data, list) else stats_data.get("days", [])
                        for day in days:
                            metrics = AdMetrics(
                                store=self.config.stores[0] if self.config.stores else "WB",
                                campaign_id=str(camp_id),
                                campaign_name=camp_name,
                                product_name=product_name,
                                date=str(day.get("date", "")),
                                impressions=int(day.get("views", 0)),
                                clicks=int(day.get("clicks", 0)),
                                ctr=float(day.get("ctr", 0)),
                                spend=float(day.get("sum", 0)),
                                orders=int(day.get("orders", 0)),
                                revenue=float(day.get("sum_price", 0)),
                            )
                            results.append(metrics)
                except Exception as e:
                    logger.debug(f"获取活动 {camp_id} 统计失败: {e}")
                    continue

        except Exception as e:
            logger.error(f"WB API 请求失败: {e}")
            return self._fetch_from_csv()

        logger.info(f"WB API: 获取到 {len(results)} 条广告统计数据")
        return results if results else self._fetch_from_csv()

    def _fetch_from_csv(self) -> list[AdMetrics]:
        """从本地 CSV 文件读取广告数据。"""
        import_dir = Path(self.config.data_dir)
        if not import_dir.exists():
            logger.warning(f"CSV 导入目录不存在: {import_dir}")
            return []

        results = []
        for csv_file in import_dir.glob("*.csv"):
            store_name = csv_file.stem  # 文件名作为店铺名
            try:
                with open(csv_file, "r", encoding="utf-8-sig") as f:
                    # 跳过 WB 报表头几行
                    reader = csv.DictReader(f)
                    for row in reader:
                        if not any(str(v).strip() for v in row.values()):
                            continue
                        metrics = AdMetrics.from_csv_row(store=store_name, row=row)
                        if metrics.campaign_id:
                            results.append(metrics)
            except Exception as e:
                logger.error(f"CSV 读取失败 [{csv_file}]: {e}")

        logger.info(f"CSV 读取到 {len(results)} 条广告数据 (来自 {sum(1 for _ in import_dir.glob('*.csv'))} 个文件)")
        return results

    async def close(self):
        await self._http.aclose()
