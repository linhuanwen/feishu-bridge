import { describe, it, expect } from "vitest";
import { buildPingPongReply } from "./buildPingPongReply.js";

describe("buildPingPongReply", () => {
  it("返回包含当前 ISO 时间的中文连接确认消息", () => {
    process.env.TZ = "Asia/Shanghai";
    const now = new Date("2026-06-15T16:49:41.913+08:00");

    const reply = buildPingPongReply(now);

    expect(reply).toBe("已连接，当前时间：2026-06-15T16:49:41.913+08:00");
  });
});
