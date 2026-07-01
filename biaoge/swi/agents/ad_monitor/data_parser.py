"""
广告数据解析器 — 从钉钉消息中直接提取广告数据。

支持格式（灵活，不需要严格规范）:

格式1：产品名 + 指标
  投影仪 CTR0.19 花费87 订单0 展示5200
  玩具收纳架 CTR0.92 花费124 订单3

格式2：带店铺标签
  晋兴-投影仪 CTR0.19 花费87.5 订单0
  惠扬-打孔器 CTR0.38 花费45 订单1

格式3：简单数字（按顺序：展示/点击/CTR/花费/订单）
  投影仪 5200 10 0.19 87.5 0
  玩具收纳架 3800 35 0.92 124 3

格式4：表格式（直接粘贴WB报表片段）
  产品 | 展示 | 点击 | CTR | 花费 | 订单
  投影仪 | 5200 | 10 | 0.19 | 87.5 | 0
"""
import re
from datetime import datetime
from dataclasses import dataclass, field


@dataclass
class ParsedAdData:
    """解析后的单条广告数据。"""
    product_name: str = ""
    store: str = ""
    impressions: int = 0
    clicks: int = 0
    ctr: float = 0.0
    spend: float = 0.0
    orders: int = 0
    raw: str = ""  # 原始输入


def is_ad_data(text: str) -> bool:
    """判断一条消息是否包含广告数据。"""
    indicators = ["ctr", "花费", "展示", "点击", "订单", "spend", "impression",
                  "impressions", "clicks", "orders", "流量", "消耗", "成交",
                  "%", "р", "₽"]
    text_lower = text.lower()
    if any(kw in text_lower for kw in indicators):
        return True
    # 纯数字格式：产品名后跟 3+ 个数字
    import re
    numbers = re.findall(r'\d+[.,]?\d*', text)
    return len(numbers) >= 3


def parse_ad_data(text: str, default_store: str = "") -> list[ParsedAdData]:
    """
    从钉钉消息中解析广告数据。
    返回解析后的数据列表。
    """
    results = []

    # 清理：去掉 @机器人、多余空格
    text = re.sub(r'@\S+', '', text).strip()

    # 按行拆分
    lines = [l.strip() for l in text.split('\n') if l.strip()]

    for line in lines:
        # 跳过纯说明行
        if re.match(r'^[#\-\*＝=]+$', line):
            continue
        if re.match(r'^(产品|商品|店铺|日期|时间|报告)', line):
            continue

        data = ParsedAdData(raw=line)

        # 尝试提取数字
        numbers = re.findall(r'[\d,.]+', line)
        numbers_float = []
        for n in numbers:
            try:
                numbers_float.append(float(n.replace(',', '.')))
            except ValueError:
                continue

        # 提取产品名
        # 格式: "产品名 CTR0.19..." 或 "产品名 5200 10..."
        # 第一个非数字词通常是产品名
        words = line.split()
        name_parts = []
        for w in words:
            if re.match(r'^[\d,.]+$', w) or re.match(r'^(ctr|花费|展示|点击|订单|impression|clicks|orders|spend)', w.lower()):
                break
            name_parts.append(w)
        data.product_name = ' '.join(name_parts).strip(':-：:').strip()

        # 提取店铺名
        for store_kw in ["晋兴", "惠扬", "茹云", "店铺"]:
            if store_kw in line:
                data.store = store_kw
                data.product_name = data.product_name.replace(store_kw, '').strip(':-：:-').strip()
                break
        if not data.store:
            data.store = default_store

        # 提取各指标
        patterns = {
            "ctr":        r'(?:ctr|CTR|点击率)\s*[:：]?\s*([\d,.]+)',
            "spend":      r'(?:花费|消耗|花费|spend|затраты)\s*[:：]?\s*([\d,.]+)',
            "orders":     r'(?:订单|成交|orders|заказы)\s*[:：]?\s*([\d,.]+)',
            "impressions": r'(?:展示|曝光|impressions|показы)\s*[:：]?\s*([\d,.]+)',
            "clicks":     r'(?:点击|clicks|клики)\s*[:：]?\s*([\d,.]+)',
        }

        for key, pat in patterns.items():
            m = re.search(pat, line, re.IGNORECASE)
            if m:
                val = float(m.group(1).replace(',', '.'))
                if key == "ctr":
                    data.ctr = val
                elif key == "spend":
                    data.spend = val
                elif key == "orders":
                    data.orders = int(val)
                elif key == "impressions":
                    data.impressions = int(val)
                elif key == "clicks":
                    data.clicks = int(val)

        # 如果上面都没匹配到，尝试用位置匹配（产品名后的数字序列）
        if data.ctr == 0 and data.spend == 0 and len(numbers_float) >= 3:
            idx = 0
            if data.impressions == 0 and len(numbers_float) >= 4:
                data.impressions = int(numbers_float[idx]); idx += 1
            if data.clicks == 0 and len(numbers_float) >= 4:
                data.clicks = int(numbers_float[idx]); idx += 1
            if data.ctr == 0 and len(numbers_float) > idx:
                data.ctr = numbers_float[idx]; idx += 1
            if data.spend == 0 and len(numbers_float) > idx:
                data.spend = numbers_float[idx]; idx += 1
            if data.orders == 0 and len(numbers_float) > idx:
                data.orders = int(numbers_float[idx])

        # 至少要有一个有效指标
        if data.ctr > 0 or data.spend > 0 or data.impressions > 0:
            results.append(data)

    return results


def ad_data_to_alert(results: list[ParsedAdData]) -> str:
    """将解析结果转化为可读的告警文本。"""
    if not results:
        return ""

    alerts = []
    for d in results:
        issues = []
        if d.ctr > 0 and d.ctr < 0.3:
            issues.append(f"CTR偏低: {d.ctr:.2f}%")
        if d.spend > 50 and d.orders == 0:
            issues.append(f"花费¥{d.spend:.0f}但0订单")
        if d.impressions > 1000 and d.clicks == 0:
            issues.append(f"展示{d.impressions}次但0点击")

        if issues:
            alerts.append(
                f"**{d.product_name or '未知产品'}**\n"
                + f"店铺: {d.store or '未指定'}\n"
                + f"展示: {d.impressions} | 点击: {d.clicks} | CTR: {d.ctr:.2f}%\n"
                + f"花费: ¥{d.spend:.0f} | 订单: {d.orders}\n"
                + f"⚠️ {' | '.join(issues)}"
            )
        else:
            alerts.append(
                f"**{d.product_name or '未知产品'}**\n"
                + f"CTR: {d.ctr:.2f}% | 花费: ¥{d.spend:.0f} | 订单: {d.orders} ✅ 正常"
            )

    return "\n\n".join(alerts)
