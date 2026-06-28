import { describe, it, expect, beforeEach } from "vitest";
import {
  createPermissionLogger,
  type PermissionLogger,
  type PermissionLogEntry,
} from "./createPermissionLogger.js";

function makeEntry(
  overrides?: Partial<Omit<PermissionLogEntry, "timestamp">>,
): Omit<PermissionLogEntry, "timestamp"> {
  return {
    tool: "Read",
    operation: "read file",
    target: "d:\\tool\\yuancheng\\src\\main.ts",
    category: "read",
    ...overrides,
  };
}

describe("createPermissionLogger", () => {
  let logger: PermissionLogger;

  beforeEach(() => {
    logger = createPermissionLogger();
  });

  it("初始日志为空", () => {
    expect(logger.getAll()).toHaveLength(0);
  });

  it("记录一条权限请求并附带时间戳", () => {
    const before = new Date();
    logger.log(makeEntry());
    const after = new Date();

    const entries = logger.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe("Read");
    expect(entries[0].operation).toBe("read file");
    expect(entries[0].target).toBe("d:\\tool\\yuancheng\\src\\main.ts");
    expect(entries[0].category).toBe("read");
    // 时间戳应该在调用前后之间
    expect(entries[0].timestamp.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(entries[0].timestamp.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
  });

  it("记录多条权限请求", () => {
    logger.log(makeEntry({ tool: "Read", target: "a.ts" }));
    logger.log(makeEntry({ tool: "Write", target: "b.ts", category: "write" }));
    logger.log(makeEntry({ tool: "Grep", target: "src/", category: "read" }));

    expect(logger.getAll()).toHaveLength(3);
  });

  it("按类别筛选 — getByCategory('read')", () => {
    logger.log(makeEntry({ tool: "Read", category: "read" }));
    logger.log(makeEntry({ tool: "Write", category: "write" }));
    logger.log(makeEntry({ tool: "Grep", category: "read" }));
    logger.log(makeEntry({ tool: "Edit", category: "write" }));

    const reads = logger.getByCategory("read");
    expect(reads).toHaveLength(2);
    expect(reads.every((e) => e.category === "read")).toBe(true);

    const writes = logger.getByCategory("write");
    expect(writes).toHaveLength(2);
    expect(writes.every((e) => e.category === "write")).toBe(true);
  });

  it("按工具名筛选 — getByTool('Bash')", () => {
    logger.log(makeEntry({ tool: "Read", category: "read" }));
    logger.log(makeEntry({ tool: "Bash", operation: "git log", category: "read" }));
    logger.log(makeEntry({ tool: "Bash", operation: "npm install", category: "write" }));
    logger.log(makeEntry({ tool: "Grep", category: "read" }));

    const bashEntries = logger.getByTool("Bash");
    expect(bashEntries).toHaveLength(2);
    expect(bashEntries.every((e) => e.tool === "Bash")).toBe(true);
  });

  it("clear() 清空所有日志", () => {
    logger.log(makeEntry());
    logger.log(makeEntry({ tool: "Write" }));
    expect(logger.getAll()).toHaveLength(2);

    logger.clear();
    expect(logger.getAll()).toHaveLength(0);
  });

  it("getStats() 返回按工具的统计计数", () => {
    logger.log(makeEntry({ tool: "Read", category: "read" }));
    logger.log(makeEntry({ tool: "Read", category: "read" }));
    logger.log(makeEntry({ tool: "Write", category: "write" }));
    logger.log(makeEntry({ tool: "Grep", category: "read" }));
    logger.log(makeEntry({ tool: "Bash", operation: "git log", category: "read" }));

    const stats = logger.getStats();
    expect(stats.total).toBe(5);
    expect(stats.readCount).toBe(4);
    expect(stats.writeCount).toBe(1);
    expect(stats.byTool).toEqual({
      Read: 2,
      Write: 1,
      Grep: 1,
      Bash: 1,
    });
  });

  it("可以设置自定义时间戳工厂", () => {
    const fixedDate = new Date("2026-06-27T12:00:00.000Z");
    const clockLogger = createPermissionLogger({ now: () => fixedDate });

    clockLogger.log(makeEntry());
    expect(clockLogger.getAll()[0].timestamp).toEqual(fixedDate);
  });
});
