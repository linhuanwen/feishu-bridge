"""
多维表格对比分析引擎。

对比今天 vs 昨天的快照，产出结构化差异报告：
- 记录数量变化
- 新增/删除的记录
- 字段值变更
- 关键指标的趋势（上升/下降/持平）

输出可直接嵌入 LLM 日报提示词中。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class FieldChange:
    """单个字段的变更详情。"""
    field_name: str
    old_value: Any
    new_value: Any


@dataclass
class RecordDiff:
    """一条记录的完整差异。"""
    record_id: str
    change_type: str  # "added" | "removed" | "modified"
    changes: list[FieldChange] = field(default_factory=list)


@dataclass
class TableComparison:
    """单表的对比结果。"""
    table_name: str
    table_id: str
    today_date: str
    yesterday_date: str
    today_count: int
    yesterday_count: int
    count_delta: int
    count_delta_pct: float  # 变化百分比，如 5.0 表示 +5%
    added_record_ids: list[str] = field(default_factory=list)
    removed_record_ids: list[str] = field(default_factory=list)
    modified_record_ids: list[str] = field(default_factory=list)
    field_changes: dict[str, list[FieldChange]] = field(default_factory=dict)
    # 字段级别的统计对比（用于数值型字段的趋势分析）
    field_stats: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def total_changes(self) -> int:
        return len(self.added_record_ids) + len(self.removed_record_ids) + len(self.modified_record_ids)

    @property
    def has_changes(self) -> bool:
        return self.total_changes > 0


def compare_snapshots(
    table_name: str,
    table_id: str,
    today_snapshot: dict[str, Any],
    yesterday_snapshot: dict[str, Any],
) -> TableComparison:
    """
    对比两份快照，返回结构化差异。

    参数:
        table_name: 表名
        table_id: 飞书 table_id
        today_snapshot: 今天的快照
        yesterday_snapshot: 昨天的快照

    返回:
        TableComparison 对象
    """
    today_records: dict[str, dict[str, Any]] = today_snapshot.get("records", {})
    yesterday_records: dict[str, dict[str, Any]] = yesterday_snapshot.get("records", {})

    today_ids = set(today_records.keys())
    yesterday_ids = set(yesterday_records.keys())

    # 新增的记录（今天有，昨天没有）
    added_ids = today_ids - yesterday_ids
    # 删除的记录（昨天有，今天没有）
    removed_ids = yesterday_ids - today_ids
    # 共同存在的记录（可能被修改）
    common_ids = today_ids & yesterday_ids

    # 检查修改
    modified_ids: list[str] = []
    field_changes: dict[str, list[FieldChange]] = {}

    for rid in common_ids:
        today_fields = today_records[rid]
        yesterday_fields = yesterday_records[rid]
        changes: list[FieldChange] = []

        # 检查所有字段（合并两天的字段名）
        all_fields = set(today_fields.keys()) | set(yesterday_fields.keys())
        for fname in all_fields:
            old_val = _normalize(yesterday_fields.get(fname))
            new_val = _normalize(today_fields.get(fname))
            if old_val != new_val:
                changes.append(FieldChange(
                    field_name=fname,
                    old_value=old_val,
                    new_value=new_val,
                ))

        if changes:
            modified_ids.append(rid)
            field_changes[rid] = changes

    # 计算记录数变化
    yesterday_count = len(yesterday_records)
    today_count = len(today_records)
    count_delta = today_count - yesterday_count
    count_delta_pct = (
        round(count_delta / yesterday_count * 100, 1)
        if yesterday_count > 0
        else (100.0 if today_count > 0 else 0.0)
    )

    # 字段级别的数值统计（用于趋势分析）
    field_stats = _compute_field_stats(
        yesterday_records, today_records, today_snapshot.get("field_names", [])
    )

    return TableComparison(
        table_name=table_name,
        table_id=table_id,
        today_date=today_snapshot.get("fetched_at", "")[:10],
        yesterday_date=yesterday_snapshot.get("fetched_at", "")[:10],
        today_count=today_count,
        yesterday_count=yesterday_count,
        count_delta=count_delta,
        count_delta_pct=count_delta_pct,
        added_record_ids=sorted(added_ids),
        removed_record_ids=sorted(removed_ids),
        modified_record_ids=modified_ids,
        field_changes=field_changes,
        field_stats=field_stats,
    )


def format_comparison_for_llm(comp: TableComparison) -> str:
    """
    将对比结果格式化为 LLM 友好的文本，嵌入到日报提示词中。

    输出 Markdown 格式，便于 LLM 理解和生成报告。
    """
    lines: list[str] = []

    lines.append(f"## 📊 对比昨日：{comp.table_name}")
    lines.append("")

    # ── 记录数变化 ──
    delta_symbol = "↑" if comp.count_delta > 0 else ("↓" if comp.count_delta < 0 else "→")
    lines.append(
        f"- **记录总数**: {comp.yesterday_count} → {comp.today_count} "
        f"({delta_symbol}{abs(comp.count_delta)} 条, {comp.count_delta_pct:+.1f}%)"
    )

    # ── 新增记录 ──
    if comp.added_record_ids:
        lines.append(f"- **新增记录**: {len(comp.added_record_ids)} 条")
        # 最多列出 5 条，避免 token 浪费
        show_ids = comp.added_record_ids[:5]
        lines.append(f"  - ID: {', '.join(show_ids)}")
        if len(comp.added_record_ids) > 5:
            lines.append(f"  - ... 还有 {len(comp.added_record_ids) - 5} 条")

    # ── 删除记录 ──
    if comp.removed_record_ids:
        lines.append(f"- **删除记录**: {len(comp.removed_record_ids)} 条")
        show_ids = comp.removed_record_ids[:5]
        lines.append(f"  - ID: {', '.join(show_ids)}")
        if len(comp.removed_record_ids) > 5:
            lines.append(f"  - ... 还有 {len(comp.removed_record_ids) - 5} 条")

    # ── 修改记录 ──
    if comp.modified_record_ids:
        lines.append(f"- **修改记录**: {len(comp.modified_record_ids)} 条")
        # 列出前 3 条修改的详情
        for rid in comp.modified_record_ids[:3]:
            changes = comp.field_changes.get(rid, [])
            change_strs = [
                f"{ch.field_name}: {_truncate(ch.old_value)} → {_truncate(ch.new_value)}"
                for ch in changes[:5]
            ]
            lines.append(f"  - `{rid[:12]}...`: {', '.join(change_strs)}")
            if len(changes) > 5:
                lines.append(f"    - ... 还有 {len(changes) - 5} 个字段变更")
        if len(comp.modified_record_ids) > 3:
            lines.append(f"  - ... 还有 {len(comp.modified_record_ids) - 3} 条修改")

    # ── 字段统计变化（数值型字段的趋势）──
    if comp.field_stats:
        lines.append("")
        lines.append("### 📈 字段趋势")
        lines.append("")
        for fname, stats in comp.field_stats.items():
            if stats.get("type") == "numeric":
                old_total = stats.get("yesterday_total", 0)
                new_total = stats.get("today_total", 0)
                old_avg = stats.get("yesterday_avg", 0)
                new_avg = stats.get("today_avg", 0)
                total_delta = new_total - old_total
                total_symbol = "↑" if total_delta > 0 else ("↓" if total_delta < 0 else "→")
                lines.append(
                    f"- **{fname}**: 合计 {old_total} → {new_total} "
                    f"({total_symbol}{abs(total_delta)}), "
                    f"均值 {old_avg} → {new_avg}"
                )
            elif stats.get("type") == "categorical":
                lines.append(
                    f"- **{fname}**: 唯一值数 {stats.get('yesterday_unique', 0)} → "
                    f"{stats.get('today_unique', 0)}"
                )

    if not comp.has_changes:
        lines.append("")
        lines.append("✅ 与昨日相比无变化。")

    return "\n".join(lines)


def format_all_comparisons_for_llm(
    comparisons: list[TableComparison],
) -> str:
    """将所有表的对比结果合并为一个 LLM 友好的文本块。"""
    if not comparisons:
        return ""

    blocks: list[str] = []
    blocks.append("---")
    blocks.append("")
    blocks.append("## 🔍 昨日对比数据")
    blocks.append("")
    blocks.append(
        "以下是与昨日快照的对比结果，请在报告中体现数据趋势和关键变化。"
    )
    blocks.append("")

    for comp in comparisons:
        blocks.append(format_comparison_for_llm(comp))
        blocks.append("")

    blocks.append("---")
    return "\n".join(blocks)


# ── 内部辅助 ──


def _normalize(val: Any) -> Any:
    """规范化值用于比较。"""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return val
    if isinstance(val, bool):
        return val
    return str(val)


def _truncate(val: Any, max_len: int = 30) -> str:
    """截断过长的值用于显示。"""
    s = str(val) if val is not None else "(空)"
    if len(s) > max_len:
        return s[:max_len - 3] + "..."
    return s


def _compute_field_stats(
    yesterday_records: dict[str, dict[str, Any]],
    today_records: dict[str, dict[str, Any]],
    field_names: list[str],
) -> dict[str, dict[str, Any]]:
    """
    计算字段级别的统计变化。

    对数值型字段计算合计/均值变化，对分类字段计算唯一值数变化。
    """
    stats: dict[str, dict[str, Any]] = {}

    for fname in field_names:
        yesterday_vals = [
            rec.get(fname)
            for rec in yesterday_records.values()
            if rec.get(fname) is not None
        ]
        today_vals = [
            rec.get(fname)
            for rec in today_records.values()
            if rec.get(fname) is not None
        ]

        if not yesterday_vals and not today_vals:
            continue

        # 判断字段类型
        numeric_count = sum(
            1 for v in yesterday_vals + today_vals
            if isinstance(v, (int, float)) and not isinstance(v, bool)
        )
        total_count = len(yesterday_vals) + len(today_vals)

        if total_count > 0 and numeric_count / total_count > 0.5:
            # 按数值字段处理
            numeric_yesterday = [v for v in yesterday_vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
            numeric_today = [v for v in today_vals if isinstance(v, (int, float)) and not isinstance(v, bool)]

            stats[fname] = {
                "type": "numeric",
                "yesterday_count": len(numeric_yesterday),
                "today_count": len(numeric_today),
                "yesterday_total": sum(numeric_yesterday) if numeric_yesterday else 0,
                "today_total": sum(numeric_today) if numeric_today else 0,
                "yesterday_avg": round(sum(numeric_yesterday) / len(numeric_yesterday), 2) if numeric_yesterday else 0,
                "today_avg": round(sum(numeric_today) / len(numeric_today), 2) if numeric_today else 0,
            }
        elif yesterday_vals or today_vals:
            # 按分类字段处理
            stats[fname] = {
                "type": "categorical",
                "yesterday_unique": len(set(str(v) for v in yesterday_vals)),
                "today_unique": len(set(str(v) for v in today_vals)),
            }

    return stats
