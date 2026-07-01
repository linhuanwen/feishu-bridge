"""
Web 仪表盘 + 钉钉消息回调 — FastAPI 应用。
"""
from datetime import datetime
from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse


def create_app(runner) -> FastAPI:
    """创建 FastAPI 应用。"""
    app = FastAPI(title="超级工作个体", version="0.1.0")

    @app.get("/", response_class=HTMLResponse)
    async def dashboard(request: Request):
        """主仪表盘 — 事项管理（纯HTML，零依赖模板引擎）。"""
        tasks_pending = []
        if runner.task_manager:
            tasks_pending = await runner.task_manager.list_pending()
        today_tasks = [t for t in tasks_pending if t.deadline_type == "today"]
        week_tasks = [t for t in tasks_pending if t.deadline_type == "week"]

        today_html = ""
        for t in today_tasks:
            today_html += f'''<div class="task-row" id="task-{t.id}">
                <span>{t.content}</span>
                <div class="btns">
                    <button class="done" onclick="done({t.id})">完成</button>
                    <button class="del" onclick="del({t.id})">删</button>
                </div>
            </div>'''

        week_html = ""
        for t in week_tasks:
            week_html += f'''<div class="task-row" id="task-{t.id}">
                <span>{t.content}</span>
                <div class="btns">
                    <button class="done" onclick="done({t.id})">完成</button>
                    <button class="del" onclick="del({t.id})">删</button>
                </div>
            </div>'''

        html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>超级工作个体</title>
<style>
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; min-height: 100vh; }}
.max {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
h1 {{ font-size: 22px; color: #333; margin-bottom: 20px; }}
.card {{ background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }}
.input-row {{ display: flex; gap: 8px; }}
.input-row input {{ flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; outline: none; }}
.input-row input:focus {{ border-color: #4A90D9; }}
.input-row select {{ padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; background: #fff; }}
.input-row button {{ padding: 10px 18px; background: #4A90D9; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; white-space: nowrap; }}
.section-title {{ font-size: 13px; font-weight: 600; margin-bottom: 8px; padding: 4px 0; }}
.section-title.today {{ color: #E74C3C; }}
.section-title.week {{ color: #4A90D9; }}
.task-row {{ display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f0f0f0; font-size: 15px; color: #333; }}
.task-row:last-child {{ border-bottom: none; }}
.task-row .btns {{ display: flex; gap: 6px; flex-shrink: 0; margin-left: 10px; }}
.task-row .done {{ padding: 4px 10px; background: #e8f5e9; color: #2e7d32; border: none; border-radius: 4px; font-size: 12px; cursor: pointer; }}
.task-row .del {{ padding: 4px 10px; background: #fafafa; color: #999; border: none; border-radius: 4px; font-size: 12px; cursor: pointer; }}
.empty {{ text-align: center; color: #ccc; padding: 24px 0; font-size: 14px; }}
.footer {{ text-align: center; color: #bbb; font-size: 11px; margin-top: 20px; }}
</style>
</head>
<body>
<div class="max">
<h1>事项记录</h1>
<div class="card">
<form class="input-row" onsubmit="add(event)">
<input type="text" id="content" placeholder="输入你想做的事..." autofocus>
<select id="deadline">
<option value="today">今日</option>
<option value="week">本周</option>
</select>
<button type="submit">添加</button>
</form>
</div>
<div class="card">
<div class="section-title today">今日必须完成</div>
{today_html if today_html else '<div class="empty">今天没有待办</div>'}
</div>
<div class="card">
<div class="section-title week">本周完成即可</div>
{week_html if week_html else '<div class="empty">本周没有待办</div>'}
</div>
<div class="footer">Agent运行中 | 钉钉通知 ON | 桌面通知 ON</div>
</div>
<script>
async function add(e) {{
e.preventDefault();
const c = document.getElementById('content').value.trim();
const d = document.getElementById('deadline').value;
if (!c) return;
const f = new FormData();
f.append('content', c);
f.append('deadline', d);
await fetch('/api/tasks/add', {{method:'POST', body:f}});
location.reload();
}}
async function done(id) {{
await fetch('/api/tasks/'+id+'/done', {{method:'POST'}});
location.reload();
}}
async function del(id) {{
await fetch('/api/tasks/'+id+'/delete', {{method:'POST'}});
location.reload();
}}
</script>
</body>
</html>'''
        return HTMLResponse(html)

    # ─── 事项 API ────────────────────────────

    @app.post("/api/tasks/add")
    async def api_add_task(content: str = Form(...), deadline: str = Form("today")):
        """添加任务（网页表单）。"""
        if runner.task_manager:
            task = await runner.task_manager.add(content, deadline, source="web")
            return JSONResponse({"ok": True, "id": task.id, "content": task.content})
        return JSONResponse({"ok": False, "error": "task_manager未初始化"}, status_code=500)

    @app.post("/api/tasks/{task_id}/done")
    async def api_done_task(task_id: int):
        """完成任务。"""
        if runner.task_manager:
            task = await runner.task_manager.mark_done(task_id)
            if task:
                return JSONResponse({"ok": True, "id": task.id})
            return JSONResponse({"ok": False, "error": "未找到"}, status_code=404)
        return JSONResponse({"ok": False}, status_code=500)

    @app.post("/api/tasks/{task_id}/delete")
    async def api_delete_task(task_id: int):
        """删除任务。"""
        if runner.task_manager:
            ok = await runner.task_manager.delete(task_id)
            if ok:
                return JSONResponse({"ok": True})
            return JSONResponse({"ok": False, "error": "未找到"}, status_code=404)
        return JSONResponse({"ok": False}, status_code=500)

    # ─── 钉钉消息处理核心 ─────────────────────

    async def _process_dingtalk(data: dict) -> str:
        """处理钉钉消息，返回回复文本。"""
        import re
        text = ""
        if isinstance(data.get("text"), dict):
            text = data["text"].get("content", "")
        elif "text" in data:
            text = str(data["text"])
        text = re.sub(r'@\S+', '', text).strip()

        if not text:
            return "请发 `帮助` 查看用法"

        # ── 识别广告数据输入 ──
        from swi.agents.ad_monitor.data_parser import is_ad_data, parse_ad_data, ad_data_to_alert
        if is_ad_data(text):
            parsed = parse_ad_data(text)
            if parsed:
                alert = ad_data_to_alert(parsed)
                return f"**广告数据分析**\n\n解析到 {len(parsed)} 条数据\n\n{alert}\n\n存入后可发送 `同步广告` 进行完整分析"
            return "广告数据已识别，但格式无法解析。请尝试：\n`产品名 CTR0.5 花费87 订单3`"

        # ── 命令路由 ──
        parsed_cmd = runner.task_manager.parse_dingtalk_msg(text) if runner.task_manager else {}

        if parsed_cmd.get("action") == "ad_sync":
            try:
                result = await runner.trigger_agent("ad_monitor")
                reply = f"**广告分析完成**\n\n{result.summary}"
                if result.status == "warning":
                    reply += "\n\n⚠️ 存在异常，请检查上方详情。\n发送 `广告报告` 查看详情。"
                return reply
            except Exception as e:
                return f"广告分析失败: {e}"

        if parsed_cmd.get("action") == "ad_report":
            return "**广告报告**\n\n发送 `同步广告` 立即执行一次分析。\n\n你也可以直接发广告数据，我会自动分析：\n`投影仪 CTR0.19 花费87 订单0`"

        # ── 默认：事项记录 ──
        if runner.task_manager:
            return await runner.task_manager.handle_dingtalk_msg(text)
        return "系统未初始化"

    async def _reply(data: dict, reply_text: str):
        """通过 sessionWebhook 回复钉钉消息。"""
        session_webhook = data.get("sessionWebhook")
        if session_webhook:
            import asyncio
            import httpx
            try:
                def _sync_post():
                    with httpx.Client(timeout=10) as client:
                        return client.post(session_webhook, json={
                            "msgtype": "text",
                            "text": {"content": reply_text}
                        })
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, _sync_post)
                return JSONResponse({"ok": True})
            except Exception:
                pass
        return JSONResponse({"msgtype": "text", "text": {"content": reply_text}})

    # ─── 多机器人回调路由 ─────────────────────

    @app.post("/dingtalk/callback")
    async def dingtalk_callback(request: Request):
        """工作管家机器人 — 全局入口。"""
        data = await request.json()
        challenge = data.get("challenge")
        if challenge:
            return JSONResponse({"challenge": challenge})
        reply = await _process_dingtalk(data)
        return await _reply(data, reply)

    @app.post("/dingtalk/ad")
    async def dingtalk_ad_callback(request: Request):
        """广告监控机器人 — 专收广告数据。"""
        data = await request.json()
        challenge = data.get("challenge")
        if challenge:
            return JSONResponse({"challenge": challenge})

        import re
        text = ""
        if isinstance(data.get("text"), dict):
            text = data["text"].get("content", "")
        text = re.sub(r'@\S+', '', text).strip()

        from swi.agents.ad_monitor.data_parser import parse_ad_data, ad_data_to_alert
        parsed = parse_ad_data(text)
        if parsed:
            alert = ad_data_to_alert(parsed)
            reply = f"**广告分析** ({len(parsed)}条)\n\n{alert}"
        else:
            reply = "广告数据格式无法识别。\n格式：`产品名 CTR0.5 花费87 订单3`\n多行可批量输入。"

        return await _reply(data, reply)

    # ─── OAuth 回调 ──────────────────────────

    @app.get("/dingtalk/oauth")
    async def dingtalk_oauth_callback(request: Request, code: str = "", state: str = ""):
        """接收钉钉 OAuth 授权码，换取用户级 Token。"""
        import httpx

        if not code:
            return HTMLResponse("<h3>授权失败：未收到授权码</h3>")

        # 用授权码换 token
        r = httpx.post("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", json={
            "clientId": "dingbqkz5a7b1o3zhkax",
            "clientSecret": "iwekyDhaiWNG4JTjb6IqAQpFxSayNeJRTo0N3H5r9PW9q9wHoOv_gVxjMBJwYrV5",
            "code": code,
            "grantType": "authorization_code",
        }, timeout=10)

        if r.status_code != 200:
            return HTMLResponse(f"<h3>换取 Token 失败</h3><pre>{r.text}</pre>")

        data = r.json()
        access_token = data.get("accessToken", "")
        refresh_token = data.get("refreshToken", "")

        # 存储 refresh_token 供后续使用
        import json
        token_path = Path(runner.project_dir) / "data" / "dingtalk_user_token.json"
        token_path.write_text(json.dumps({
            "access_token": access_token,
            "refresh_token": refresh_token,
            "updated_at": str(datetime.now()),
        }))

        return HTMLResponse(
            f"<h2>授权成功！</h2>"
            f"<p>Access Token: {access_token[:20]}...</p>"
            f"<p>Refresh Token 已存储，系统将自动续期。</p>"
        )

    # ─── 飞书事件回调 ─────────────────────────

    @app.post("/feishu/event")
    async def feishu_event_callback(request: Request):
        """接收飞书事件推送（消息、URL验证）。"""
        import json, re
        data = await request.json()

        # URL 验证
        challenge = data.get("challenge", "")
        if challenge and data.get("type") == "url_verification":
            return JSONResponse({"challenge": challenge})

        # 解析消息
        if runner.feishu_client:
            parsed = FeishuClient.parse_event(data)
            text = parsed.get("text", "")

            if text:
                # 检查是否为广告数据
                from swi.agents.ad_monitor.data_parser import is_ad_data, parse_ad_data, ad_data_to_alert
                if is_ad_data(text):
                    parsed_data = parse_ad_data(text)
                    if parsed_data:
                        alert = ad_data_to_alert(parsed_data)
                        reply = f"**广告分析** ({len(parsed_data)}条)\n\n{alert}"
                    else:
                        reply = "广告数据无法解析。格式：`产品名 CTR0.5 花费87 订单3`"
                elif text in ("帮助", "help"):
                    reply = (
                        "**工作管家 - 使用说明**\n\n"
                        "**事项记录**：直接发消息\n"
                        "**完成**：`完成 编号`\n"
                        "**列表**：`待办` 或 `列表`\n"
                        "**广告分析**：粘贴广告数据"
                    )
                elif text in ("待办", "列表", "list"):
                    if runner.task_manager:
                        reply = await runner.task_manager.get_summary()
                        if not reply.strip():
                            reply = "当前没有待办事项"
                    else:
                        reply = "系统未就绪"
                elif re.match(r"(完成|done|搞定)\s*\d+", text):
                    if runner.task_manager:
                        reply = await runner.task_manager.handle_dingtalk_msg(text)
                    else:
                        reply = "系统未就绪"
                else:
                    # 默认：记录为待办
                    if runner.task_manager:
                        parsed = runner.task_manager.parse_dingtalk_msg(text)
                        if parsed.get("action") == "add":
                            deadline = parsed.get("deadline", "today")
                            deadline_label = "今日" if deadline == "today" else "本周"
                            task = await runner.task_manager.add(parsed["content"], deadline)
                            reply = f"已记录 [{deadline_label}] #{task.id}: {parsed['content']}"
                        else:
                            reply = await runner.task_manager.handle_dingtalk_msg(text)
                    else:
                        reply = f"收到: {text[:50]}"

                # 回复消息
                msg_id = parsed.get("message_id", "")
                if msg_id:
                    await runner.feishu_client.reply_text(msg_id, reply)

        return JSONResponse({"code": 0})

    @app.post("/api/agent/{agent_id}/trigger")
    async def api_trigger_agent(agent_id: str, request: Request):
        """触发指定 Agent 并等待结果返回（供 feishu-bridge 调用）。

        请求体（JSON，可选）：
          - chat_id: 结果要发往的群聊 ID
          - reply_msg_id: 原始消息 ID（用于回复）

        注意：此端点同步等待 Agent 执行完成，可能需要 30-120 秒。
        调用方需设置足够的 HTTP 超时。
        """
        import asyncio

        try:
            body = await request.json()
        except Exception:
            body = {}

        chat_id = body.get("chat_id", "")
        reply_msg_id = body.get("reply_msg_id", "")

        if not runner.scheduler:
            return JSONResponse({"ok": False, "error": "调度器未初始化"}, status_code=500)

        if agent_id not in runner.scheduler._agents:
            return JSONResponse(
                {"ok": False, "error": f"Agent [{agent_id}] 未注册"},
                status_code=404,
            )

        # API 触发时抑制 Agent 内部的 _send_report()，由调用方（feishu-bridge）负责发送
        agent = runner.scheduler._agents.get(agent_id)
        if agent:
            agent._suppress_notify = True

        try:
            # 同步执行 Agent（在同一 asyncio task 中，避免 httpx cancel scope 冲突）
            result = await runner.scheduler.trigger(agent_id)
        except Exception as e:
            logger.error(f"Agent [{agent_id}] 执行失败: {e}")
            return JSONResponse(
                {"ok": False, "error": f"执行失败: {e}", "agent_id": agent_id},
                status_code=500,
            )
        finally:
            if agent:
                agent._suppress_notify = False

        # 构建结果（feishu-bridge 负责发送到群聊）
        report = result.data.get("report", "") if result.data else ""
        if result.status == "success":
            if report:
                summary = f"✅ 报告生成完成\n\n{report}"
            else:
                summary = f"✅ 报告生成完成\n\n{result.summary}"
        elif result.status == "warning":
            summary = f"⚠️ {result.summary}\n{result.error or ''}"
        else:
            summary = f"❌ 执行异常: {result.summary}\n{result.error or ''}"

        return JSONResponse({
            "ok": True,
            "status": result.status,
            "agent_id": agent_id,
            "summary": summary,
            "error": result.error,
        })

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    return app
