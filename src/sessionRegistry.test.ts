import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createSessionRegistry, type SessionRegistry } from "./sessionRegistry.js";

describe("SessionRegistry", () => {
  let registry: SessionRegistry;
  let now: Date;

  beforeEach(() => {
    now = new Date("2026-06-27T10:00:00.000Z");
    registry = createSessionRegistry({ now: () => now });
  });

  describe("register + findByChatId", () => {
    it("注册会话后可以通过 chat_id 找到", () => {
      registry.register({
        sessionId: "sess-abc",
        projectDir: "d:\\tool\\yuancheng",
        feishuChatId: "oc_456",
      });

      const found = registry.findByChatId("oc_456");
      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe("sess-abc");
      expect(found!.projectDir).toBe("d:\\tool\\yuancheng");
    });

    it("查找不存在的 chat_id 返回 null", () => {
      const found = registry.findByChatId("oc_nonexistent");
      expect(found).toBeNull();
    });

    it("同一 chat_id 重复注册会覆盖旧条目", () => {
      registry.register({
        sessionId: "sess-abc",
        projectDir: "d:\\tool\\yuancheng",
        feishuChatId: "oc_456",
      });

      registry.register({
        sessionId: "sess-xyz",
        projectDir: "d:\\work\\other",
        feishuChatId: "oc_456",
      });

      const found = registry.findByChatId("oc_456");
      expect(found!.sessionId).toBe("sess-xyz");
      expect(found!.projectDir).toBe("d:\\work\\other");
    });
  });

  describe("findByProjectDir", () => {
    it("可以通过项目目录找到会话", () => {
      registry.register({
        sessionId: "sess-abc",
        projectDir: "d:\\tool\\yuancheng",
        feishuChatId: "oc_456",
      });

      const found = registry.findByProjectDir("d:\\tool\\yuancheng");
      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe("sess-abc");
    });
  });

  describe("touch", () => {
    it("更新 last_active 时间戳", () => {
      registry.register({
        sessionId: "sess-abc",
        projectDir: "d:\\tool\\yuancheng",
        feishuChatId: "oc_456",
      });

      const later = new Date("2026-06-27T10:30:00.000Z");
      const touched = registry.touch("sess-abc", later);
      expect(touched).toBe(true);

      const found = registry.findByChatId("oc_456");
      expect(found!.lastActive).toEqual(later);
    });

    it("touch 不存在的 session 返回 false", () => {
      const touched = registry.touch("sess-nonexistent", now);
      expect(touched).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("清理超过指定时长的非活跃会话", () => {
      const t0 = new Date("2026-06-27T09:00:00.000Z");

      registry.register({
        sessionId: "sess-old",
        projectDir: "d:\\old-project",
        feishuChatId: "oc_old",
        createdAt: t0,
        lastActive: t0,
      });

      const t1 = new Date("2026-06-27T09:55:00.000Z");
      registry.register({
        sessionId: "sess-recent",
        projectDir: "d:\\recent-project",
        feishuChatId: "oc_recent",
        createdAt: t1,
        lastActive: t1,
      });

      // 清理 30 分钟以上无活动的会话（现在时间是 10:00）
      const cleaned = registry.cleanup(30 * 60 * 1000, now);
      expect(cleaned).toBe(1);

      expect(registry.findByChatId("oc_old")).toBeNull();
      expect(registry.findByChatId("oc_recent")).not.toBeNull();
    });

    it("没有过期会话时不清理任何条目", () => {
      registry.register({
        sessionId: "sess-fresh",
        projectDir: "d:\\tool\\yuancheng",
        feishuChatId: "oc_456",
      });

      const cleaned = registry.cleanup(30 * 60 * 1000, now);
      expect(cleaned).toBe(0);
      expect(registry.findByChatId("oc_456")).not.toBeNull();
    });
  });

  describe("remove", () => {
    it("移除指定会话", () => {
      registry.register({
        sessionId: "sess-abc",
        projectDir: "d:\\tool\\yuancheng",
        feishuChatId: "oc_456",
      });

      const removed = registry.remove("sess-abc");
      expect(removed).toBe(true);
      expect(registry.findByChatId("oc_456")).toBeNull();
    });

    it("移除不存在的会话返回 false", () => {
      const removed = registry.remove("sess-nonexistent");
      expect(removed).toBe(false);
    });
  });

  describe("list", () => {
    it("返回所有活跃会话", () => {
      registry.register({
        sessionId: "sess-1",
        projectDir: "d:\\a",
        feishuChatId: "oc_1",
      });
      registry.register({
        sessionId: "sess-2",
        projectDir: "d:\\b",
        feishuChatId: "oc_2",
      });

      const sessions = registry.list();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(["sess-1", "sess-2"]);
    });
  });

  describe("独立会话隔离", () => {
    it("两个不同的飞书聊天各自维护独立 session", () => {
      registry.register({
        sessionId: "sess-chat1",
        projectDir: "d:\\project-a",
        feishuChatId: "oc_chat1",
      });
      registry.register({
        sessionId: "sess-chat2",
        projectDir: "d:\\project-b",
        feishuChatId: "oc_chat2",
      });

      const s1 = registry.findByChatId("oc_chat1");
      const s2 = registry.findByChatId("oc_chat2");

      expect(s1!.sessionId).toBe("sess-chat1");
      expect(s2!.sessionId).toBe("sess-chat2");
      expect(s1!.sessionId).not.toBe(s2!.sessionId);
    });
  });
});
