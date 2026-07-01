"""
飞书多维表格日报 Agent — 每天读取 Bitable 全量数据，AI 分析后生成报告。

v2: 新增本地数据快照 + 日间对比功能。
每天拉取数据后自动保存 JSON 快照到 data/bitable_snapshots/{日期}/，
并与前一天快照对比，生成带趋势分析的对比日报。
"""
from datetime import datetime
from pathlib import Path
from swi.core.agent_base import BaseAgent, AgentResult
from swi.core.event_types import Event, EventType

# 快照根目录（biaoge 项目 data 目录下）
_SNAPSHOT_BASE = Path(__file__).resolve().parent.parent.parent / "data" / "bitable_snapshots"


class TableReporterAgent(BaseAgent):
    """飞书多维表格日报助手。"""

    agent_id = "table_reporter"
    agent_name = "表格日报"
    schedule = "0 9 * * *"
    description = "每日读取飞书多维表格全量数据，通过 AI 生成中文分析报告，自动对比昨日数据"

    def __init__(self, config: dict = None):
        super().__init__(config)
        self._feishu_client = None       # 由 Runner 注入
        self._llm_client = None          # initialize() 中创建
        self._llm_config = None          # 由 Runner 注入

        # 从 agents.yaml config 读取可覆盖参数
        cfg = config or {}
        self._base_token = cfg.get("base_token", "")
        self._report_prompt = cfg.get("report_prompt", "")
        self._model = cfg.get("model", "")

    async def initialize(self):
        """初始化飞书客户端引用和 LLM 客户端。"""
        # FeishuClient 由 Runner 在 _discover_agents() 中注入
        self._feishu_client = getattr(self, "_feishu_client", None)
        if not self._feishu_client:
            self.logger.warning("飞书客户端未注入，bitable 读取将失败")

        # LLM 配置也由 Runner 注入
        self._llm_config = getattr(self, "_llm_config", None)
        from swi.integrations.llm_client import LLMClient, LLMConfig
        if self._llm_config is None:
            self._llm_config = LLMConfig(
                api_key=self._config.get("llm_api_key", ""),
                model=self._model or "deepseek-chat",
            )

        self._llm_client = LLMClient(self._llm_config)
        self.logger.info(
            "LLM 客户端就绪" if self._llm_client.is_available
            else "LLM API Key 未配置 — 将输出原始数据摘要"
        )

        await super().initialize()

    async def execute(self, table_name: str = None, table_id: str = None) -> AgentResult:
        """核心流程：读取表格 → 保存快照 → 对比昨日 → AI 分析 → 发送报告。

        Args:
            table_name: 指定表名则只分析该表（模糊匹配，支持部分名称）
            table_id: 指定 table_id 则只分析该表（精确匹配）
        """
        from swi.data.bitable_snapshot import (
            save_snapshot,
            load_snapshot,
            find_previous_snapshot_date,
            _today_str,
        )
        from swi.data.bitable_comparison import (
            compare_snapshots,
            format_all_comparisons_for_llm,
        )

        # 确定 base_token（优先 agent config，其次 feishu.yaml）
        base_token = self._base_token or self._config.get("base_token", "")
        if not base_token:
            return self.fail(
                "未配置 base_token。请在 agents.yaml 的 table_reporter.config 中设置，"
                "或在 feishu.yaml 的 bitable.app_token 中设置。"
            )

        if not self._feishu_client:
            return self.fail("飞书客户端未初始化")

        single_table_mode = bool(table_name or table_id)

        # ── 1. 列出所有表格 ──
        try:
            all_tables = await self._feishu_client.list_tables(base_token)
        except Exception as e:
            return self.fail(f"获取表格列表失败: {e}")

        if not all_tables:
            return self.warn("未在 base 中找到任何表格，请检查 base_token 是否正确。")

        # ── 2. 单表模式：按名称或 ID 筛选 ──
        if single_table_mode:
            tables = self._filter_tables(all_tables, table_name, table_id)
            if not tables:
                hint = table_name or table_id
                available = ', '.join(t['name'] for t in all_tables)
                return self.warn(
                    f"未找到匹配的表格「{hint}」。可用表格: {available}"
                )
            self.logger.info(
                f"单表模式: {tables[0]['name']} (共 {len(all_tables)} 张表中筛选)"
            )
        else:
            tables = all_tables
            self.logger.info(
                f"全量模式: {len(tables)} 个表格: "
                f"{', '.join(t['name'] for t in tables)}"
            )

        # ── 3. 读取每个表格的字段 + 全量记录，同时保存快照 ──
        all_data_parts = []
        total_records = 0
        failed_tables = 0
        today_str = _today_str()
        yesterday_str = find_previous_snapshot_date(_SNAPSHOT_BASE)
        comparisons: list = []
        has_previous_snapshot = yesterday_str is not None

        if has_previous_snapshot:
            self.logger.info(f"发现昨日快照: {yesterday_str}，将启用日间对比")
        else:
            self.logger.info("无历史快照，跳过日间对比（明天开始将有对比数据）")

        for table in tables:
            tid = table["table_id"]
            tname = table["name"]

            # 获取字段
            try:
                fields = await self._feishu_client.list_fields(base_token, tid)
            except Exception as e:
                self.logger.error(f"获取表格 [{tname}] 字段失败: {e}")
                failed_tables += 1
                continue

            if not fields:
                self.logger.warning(f"表格 [{tname}] 无字段定义，跳过")
                continue

            # 获取所有记录
            try:
                records = await self._feishu_client.get_all_records(base_token, tid)
            except Exception as e:
                self.logger.error(f"获取表格 [{tname}] 记录失败: {e}")
                failed_tables += 1
                continue

            total_records += len(records)
            field_names = [f["field_name"] for f in fields]

            # ── 3a. 保存今日快照 ──
            try:
                snap_path = save_snapshot(
                    base_dir=_SNAPSHOT_BASE,
                    table_name=tname,
                    table_id=tid,
                    base_token=base_token,
                    field_names=field_names,
                    records=records,
                    date_str=today_str,
                )
                self.logger.info(f"  [{tname}]: {len(fields)} 列, {len(records)} 行 → 快照已保存: {snap_path.name}")
            except Exception as e:
                self.logger.error(f"  [{tname}]: 快照保存失败: {e}")
                # 快照失败不阻塞报告生成

            # ── 3b. 加载昨日快照并对比 ──
            if has_previous_snapshot:
                yesterday_snap = load_snapshot(_SNAPSHOT_BASE, tname, yesterday_str)
                if yesterday_snap:
                    # 构建 today_snapshot dict 用于对比
                    today_snap = {
                        "fetched_at": datetime.now().isoformat(),
                        "records": {
                            rec.get("record_id", str(i)): rec.get("fields", {})
                            for i, rec in enumerate(records)
                        },
                        "field_names": field_names,
                    }
                    try:
                        comp = compare_snapshots(tname, tid, today_snap, yesterday_snap)
                        comparisons.append(comp)
                        if comp.has_changes:
                            self.logger.info(
                                f"  [{tname}] 对比: +{len(comp.added_record_ids)}/-{len(comp.removed_record_ids)}/"
                                f"~{len(comp.modified_record_ids)} (总{comp.today_count}条)"
                            )
                        else:
                            self.logger.info(f"  [{tname}] 对比: 无变化")
                    except Exception as e:
                        self.logger.error(f"  [{tname}] 对比失败: {e}")
                else:
                    self.logger.info(f"  [{tname}] 昨日无此表快照，跳过对比")

            # ── 3c. 格式化数据用于 LLM ──
            all_data_parts.append(
                self._format_table(tname, fields, records)
            )

        if not all_data_parts:
            return self.warn(
                "所有表格均无法读取或为空。"
                + (f" {failed_tables} 个表格读取失败。" if failed_tables else "")
            )

        all_data_text = "\n".join(all_data_parts)
        today_display = datetime.now().strftime("%Y年%m月%d日")

        # ── 4. 构建对比文本 ──
        comparison_text = ""
        if comparisons:
            comparison_text = format_all_comparisons_for_llm(comparisons)
            self.logger.info(
                f"对比摘要: {len(comparisons)} 表, "
                f"{sum(1 for c in comparisons if c.has_changes)} 表有变化"
            )

        # ── 5. AI 分析 ──
        if single_table_mode:
            single_name = tables[0]["name"]
            system_prompt = self._build_system_prompt(
                today_display,
                single_table=single_name,
                has_comparison=bool(comparison_text),
            )
            report_title = f"📊 单项分析: {single_name} ({datetime.now().strftime('%Y-%m-%d')})"
        else:
            system_prompt = self._build_system_prompt(
                today_display,
                has_comparison=bool(comparison_text),
            )
            report_title = f"📊 每日数据报告 ({datetime.now().strftime('%Y-%m-%d')})"

        # 将对比数据附加到用户消息
        full_data_text = all_data_text
        if comparison_text:
            full_data_text = comparison_text + "\n\n" + all_data_text

        report = await self._call_llm(system_prompt, full_data_text)

        # ── 6. 发送报告 ──
        # 当通过 API 触发时（feishu-bridge），由调用方负责发送，此处跳过避免重复
        if getattr(self, "_suppress_notify", False):
            send_ok = False
            self.logger.info("通知已抑制（由调用方负责发送），跳过内部推送")
        else:
            send_ok = await self._send_report(report_title, report)

        # ── 7. 发布事件 ──
        event_title = report_title
        event_summary = (
            f"分析了「{tables[0]['name']}」, {total_records} 条记录"
            if single_table_mode
            else f"分析了 {len(tables)} 个表格，共 {total_records} 条记录"
        )
        self.emit(Event(
            type=EventType.DAILY_REPORT_READY,
            source_agent=self.agent_id,
            title=event_title,
            summary=event_summary,
            data={
                "tables": len(tables),
                "records": total_records,
                "sent": send_ok,
                "failed_tables": failed_tables,
                "single_table": tables[0]["name"] if single_table_mode else None,
                "comparisons": len(comparisons),
                "tables_with_changes": sum(1 for c in comparisons if c.has_changes),
                "snapshot_date": today_str,
                "yesterday_date": yesterday_str,
            },
        ))

        warning = f"（{failed_tables} 个表格读取失败）" if failed_tables else ""
        compare_info = (
            f"，对比了 {len(comparisons)} 张表"
            if comparisons else ""
        )
        if single_table_mode:
            result_summary = (
                f"单项分析完成: {tables[0]['name']} ({total_records} 条记录)"
                f"{compare_info} {warning}".strip()
            )
        else:
            result_summary = (
                f"日报已生成: {len(tables)} 表 {total_records} 条记录"
                f"{compare_info} {warning}".strip()
            )

        return self.ok(
            summary=result_summary,
            table_count=len(tables),
            record_count=total_records,
            report_sent=send_ok,
            report=report,  # LLM 生成的报告全文，供 API 透传
            single_table=tables[0]["name"] if single_table_mode else None,
            comparisons_count=len(comparisons),
            tables_with_changes=sum(1 for c in comparisons if c.has_changes),
        )

    # ─── 内部方法 ────────────────────────────────

    def _filter_tables(self, tables: list, name: str = None, tid: str = None) -> list:
        """按名称（模糊）或 ID（精确）筛选表格列表。"""
        if tid:
            return [t for t in tables if t["table_id"] == tid]
        if name:
            name_lower = name.strip().lower()
            # 精确匹配优先，然后包含匹配
            exact = [t for t in tables if t["name"] == name.strip()]
            if exact:
                return exact
            return [t for t in tables if name_lower in t["name"].lower()]
        return tables

    def _format_table(self, name: str, fields: list[dict], records: list[dict]) -> str:
        """将单表数据格式化为 LLM 友好的结构化文本。"""
        lines = [f"\n### 表格: {name}"]
        lines.append(f"记录数: {len(records)}")

        # 字段头（中文名）
        field_names = [f["field_name"] for f in fields]
        lines.append(f"列: {', '.join(field_names)}")
        lines.append("")

        # 记录内容（飞书 records API 返回的 fields 键是字段名，非字段 ID）
        for idx, rec in enumerate(records, 1):
            parts = []
            for f in fields:
                fname = f["field_name"]
                val = rec.get("fields", {}).get(fname, "")
                if isinstance(val, list):
                    val = ", ".join(
                        str(v.get("text", v) if isinstance(v, dict) else v)
                        for v in val
                    )
                elif isinstance(val, dict):
                    # 数字/日期等类型：{"type": 2, "value": [13.847]}
                    if "value" in val:
                        v = val["value"]
                        val = v[0] if isinstance(v, list) and len(v) == 1 else str(v)
                    else:
                        val = val.get("text", str(val))
                parts.append(f"{fname}={val}")
            lines.append(f"  [{idx}] {' | '.join(parts)}")

        return "\n".join(lines)

    def _build_system_prompt(
        self,
        today_str: str,
        single_table: str = None,
        has_comparison: bool = False,
    ) -> str:
        """构建 AI 系统提示词。"""
        if self._report_prompt:
            return self._report_prompt

        # ── 对比分析指令 ──
        comparison_instructions = ""
        if has_comparison:
            comparison_instructions = (
                "\n"
                "## 🔍 日间对比\n"
                "消息开头已提供昨日对比数据（「🔍 昨日对比数据」区块）。请：\n"
                "1. 在报告中新增「📈 日间对比」章节\n"
                "2. 指出记录数变化（新增/删除/修改）、关键字段的趋势（上升/下降）\n"
                "3. 对显著变化给出解释性分析和行动建议\n"
                "4. 用 ↑ ↓ → 等符号标注趋势方向\n"
            )

        if single_table:
            return (
                f"你是一个专业的数据分析助手。请对「{single_table}」这张表格进行深度分析。\n\n"
                "## 报告要求\n"
                "1. **数据总览**：列数、行数、字段含义总结\n"
                "2. **逐列分析**：对每个字段做统计——数值列给出总和/均值/最大/最小/中位数，"
                "文本列给出分类分布、空值率\n"
                "3. **交叉洞察**：找出字段之间的关联（比如某个分类下的数值比其他分类高很多）\n"
                "4. **异常标记**：空值、异常大/小的数值、不合理的数据组合\n"
                "5. **行动建议**：给出 2-4 条针对该表业务的具体操作建议\n"
                "6. **格式**：Markdown，含表格、加粗。聚焦数据，不编造。中文输出。"
                + comparison_instructions
            )

        return (
            f"你是一个专业的数据分析助手，负责为团队生成{today_str}的每日工作报告。\n\n"
            "请根据下面提供的多维表格数据，生成一份清晰、有洞察的中文日报。\n\n"
            "## 报告要求\n"
            "1. **数据概览**：总结今日数据总量和各表格的关键指标\n"
            "2. **重点关注**：指出值得关注的变化、异常或趋势（如有）\n"
            "3. **行动建议**：给出 1-3 条可操作的具体建议\n"
            "4. **格式**：使用 Markdown 格式，含标题层级、加粗、列表\n"
            "5. **风格**：简洁专业，聚焦数据和洞察，控制在 800 字以内\n\n"
            "## 注意事项\n"
            "- 如果数据看起来是商品/库存/订单相关，结合电商运营视角分析\n"
            "- 如果某些字段值异常（为空、过大、过小），请指出\n"
            "- 不要编造数据中没有的信息\n"
            "- 用中文输出"
            + comparison_instructions
        )

    async def _call_llm(self, system_prompt: str, data_text: str) -> str:
        """调用 LLM 生成报告；LLM 不可用时返回原始摘要。"""
        if not self._llm_client or not self._llm_client.is_available:
            self.logger.warning("LLM 未配置，返回原始数据摘要")
            return self._build_fallback_report(data_text)

        try:
            result = await self._llm_client.analyze(system_prompt, data_text)
            return result.strip() or "[LLM 返回空响应]"
        except Exception as e:
            self.logger.error(f"LLM 调用失败: {e}")
            return (
                f"⚠️ AI 分析失败: {e}\n\n"
                f"---\n"
                f"{self._build_fallback_report(data_text)}"
            )

    def _build_fallback_report(self, data_text: str) -> str:
        """LLM 不可用时，生成纯统计摘要。"""
        # 统计各表格的记录数
        table_stats = []
        current_table = ""
        count = 0
        for line in data_text.split("\n"):
            if line.startswith("### 表格:"):
                if current_table:
                    table_stats.append(f"- **{current_table}**: {count} 条")
                current_table = line.replace("### 表格:", "").strip()
                count = 0
            elif line.strip().startswith("[") and " | " in line:
                count += 1
        if current_table:
            table_stats.append(f"- **{current_table}**: {count} 条")

        total = sum(
            int(s.split(": ")[1].replace(" 条", ""))
            for s in table_stats if ": " in s
        )

        return (
            f"## 每日数据报告（原始统计）\n\n"
            f"⚠️ 未配置 AI 分析，以下为数据量统计。请配置 Claude API Key 以启用智能分析。\n\n"
            f"### 概况\n"
            f"{chr(10).join(table_stats)}\n\n"
            f"**总计**: {total} 条记录\n\n"
            f"---\n"
            f"<details><summary>原始数据（前 2000 字符）</summary>\n\n"
            f"```\n{data_text[:2000]}\n```\n"
            f"</details>"
        )

    async def _send_report(self, title: str, report: str) -> bool:
        """通过 MultiNotifier 发送报告（飞书 + 桌面 + 钉钉）。"""
        if self._notifier:
            return await self._notifier.send_markdown(title, report)
        # Fallback: 直接用飞书 webhook
        if self._feishu_client:
            return await self._feishu_client.send_webhook(f"{title}\n\n{report}")
        self.logger.warning("无可用的通知通道")
        return False

    async def shutdown(self):
        if self._llm_client:
            await self._llm_client.close()
        await super().shutdown()
