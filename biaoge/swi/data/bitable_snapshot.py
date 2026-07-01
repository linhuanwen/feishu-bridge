"""
飞书多维表格本地快照模块。

每天拉取数据后保存 JSON 快照到本地，按日期分目录：
  data/bitable_snapshots/{YYYY-MM-DD}/{table_name}.json

快照格式:
  {
    "snapshot_id": "2026-07-01_海外仓库存数据",
    "fetched_at": "2026-07-01T09:00:05+08:00",
    "base_token": "...",
    "table_id": "tbl...",
    "table_name": "海外仓库存数据",
    "field_names": ["SKU", "库存数量", ...],
    "record_count": 90,
    "records": { "rec_xxx": { "SKU": "ABC", ... }, ... }
  }
"""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional

# 北京时间
CST = timezone(timedelta(hours=8))


def _cst_now() -> datetime:
    return datetime.now(CST)


def _today_str() -> str:
    return date.today().isoformat()


def snapshot_dir(base_dir: Path, date_str: Optional[str] = None) -> Path:
    """返回指定日期的快照目录。"""
    return base_dir / (date_str or _today_str())


def snapshot_path(base_dir: Path, table_name: str, date_str: Optional[str] = None) -> Path:
    """返回指定日期的某个表的快照文件路径。"""
    safe_name = _safe_filename(table_name)
    return snapshot_dir(base_dir, date_str) / f"{safe_name}.json"


def _safe_filename(name: str) -> str:
    """将表名转换为安全的文件名。"""
    return (
        name.replace("/", "_")
        .replace("\\", "_")
        .replace(":", "_")
        .replace(" ", "_")
    )


def list_snapshot_dates(base_dir: Path) -> list[str]:
    """列出所有有快照的日期，按日期降序排列。"""
    if not base_dir.exists():
        return []
    dates = sorted(
        [d.name for d in base_dir.iterdir() if d.is_dir()],
        reverse=True,
    )
    return dates


def find_previous_snapshot_date(
    base_dir: Path,
    current_date: Optional[str] = None,
) -> Optional[str]:
    """找到最近一个早于 current_date 的快照日期。"""
    dates = list_snapshot_dates(base_dir)
    target = current_date or _today_str()
    for d in dates:
        if d < target:
            return d
    return None


def save_snapshot(
    base_dir: Path,
    table_name: str,
    table_id: str,
    base_token: str,
    field_names: list[str],
    records: list[dict[str, Any]],
    date_str: Optional[str] = None,
) -> Path:
    """
    保存表快照到本地 JSON 文件。

    参数:
        base_dir: 快照根目录
        table_name: 表名（用于文件名）
        table_id: 飞书 table_id
        base_token: 飞书 app_token
        field_names: 字段名列表
        records: 原始记录列表 [{"record_id": "...", "fields": {...}}, ...]
        date_str: 日期字符串，默认今天

    返回:
        保存的文件路径
    """
    day = date_str or _today_str()
    dir_path = snapshot_dir(base_dir, day)
    dir_path.mkdir(parents=True, exist_ok=True)

    # 将 records 转为 {record_id: fields} 字典，方便对比
    records_dict: dict[str, dict[str, Any]] = {}
    for rec in records:
        rid = rec.get("record_id", "")
        fields = rec.get("fields", {})
        if rid:
            records_dict[rid] = fields

    snapshot = {
        "snapshot_id": f"{day}_{table_name}",
        "fetched_at": _cst_now().isoformat(),
        "base_token": base_token,
        "table_id": table_id,
        "table_name": table_name,
        "field_names": field_names,
        "record_count": len(records_dict),
        "records": records_dict,
    }

    file_path = snapshot_path(base_dir, table_name, day)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)

    return file_path


def load_snapshot(
    base_dir: Path,
    table_name: str,
    date_str: str,
) -> Optional[dict[str, Any]]:
    """
    加载指定日期的表快照。

    返回:
        快照 dict，或 None（文件不存在时）
    """
    file_path = snapshot_path(base_dir, table_name, date_str)
    if not file_path.exists():
        return None

    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)  # type: ignore[no-any-return]


def list_tables_in_snapshot(
    base_dir: Path,
    date_str: str,
) -> list[str]:
    """列出某天快照目录下所有的表名。"""
    dir_path = snapshot_dir(base_dir, date_str)
    if not dir_path.exists():
        return []
    tables = []
    for f in sorted(dir_path.iterdir()):
        if f.suffix == ".json":
            # 从文件名还原表名
            name = f.stem.replace("_", " ")
            tables.append(name)
    return tables


def get_snapshot_info(
    base_dir: Path,
    date_str: Optional[str] = None,
) -> dict[str, Any]:
    """获取指定日期的快照概览信息。"""
    day = date_str or _today_str()
    dir_path = snapshot_dir(base_dir, day)
    tables = list_tables_in_snapshot(base_dir, day)
    total_records = 0
    table_details = []

    for table_name in tables:
        snap = load_snapshot(base_dir, table_name, day)
        if snap:
            count = snap.get("record_count", 0)
            total_records += count
            table_details.append({
                "table_name": table_name,
                "record_count": count,
                "field_count": len(snap.get("field_names", [])),
                "fetched_at": snap.get("fetched_at", ""),
            })

    return {
        "date": day,
        "table_count": len(tables),
        "total_records": total_records,
        "tables": table_details,
    }
