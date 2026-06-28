import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRotatingLogger } from "./createRotatingLogger.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("createRotatingLogger", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-bridge-log-test-"));
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("写入日志到按日期命名的文件", () => {
    const logger = createRotatingLogger({ logDir, retentionDays: 7 });
    logger("测试日志消息");

    const files = fs.readdirSync(logDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^feishu-bridge-\d{4}-\d{2}-\d{2}\.log$/);

    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
    expect(content).toContain("测试日志消息");
  });

  it("每条日志包含时间戳", () => {
    const logger = createRotatingLogger({ logDir, retentionDays: 7 });
    logger("消息 A");
    logger("消息 B");

    const files = fs.readdirSync(logDir);
    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(2);
    // 时间戳格式: [YYYY-MM-DDTHH:mm:ss]
    for (const line of lines) {
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it("日期变更时自动切换到新文件", () => {
    const day1 = new Date("2026-06-27T10:00:00");
    const day2 = new Date("2026-06-28T10:00:00");

    let currentTime = day1;
    const logger = createRotatingLogger({
      logDir,
      retentionDays: 7,
      now: () => currentTime,
    });

    logger("第一天日志");

    currentTime = day2;
    logger("第二天日志");

    const files = fs.readdirSync(logDir).sort();
    expect(files.length).toBe(2);

    const content1 = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
    const content2 = fs.readFileSync(path.join(logDir, files[1]), "utf-8");
    expect(content1).toContain("第一天日志");
    expect(content2).toContain("第二天日志");
  });

  it("启动时清理超过保留天数的旧日志文件", () => {
    const now = new Date("2026-06-27T12:00:00");

    // 创建 10 天前的日志文件
    const oldDate = "2026-06-17";
    const oldFile = path.join(logDir, `feishu-bridge-${oldDate}.log`);
    fs.writeFileSync(oldFile, "旧日志\n");

    // 创建 3 天前的日志文件
    const recentDate = "2026-06-24";
    const recentFile = path.join(logDir, `feishu-bridge-${recentDate}.log`);
    fs.writeFileSync(recentFile, "较新日志\n");

    // 创建今天的日志文件
    const todayDate = "2026-06-27";
    const todayFile = path.join(logDir, `feishu-bridge-${todayDate}.log`);
    fs.writeFileSync(todayFile, "今日日志\n");

    // 创建非日志文件（不应被删除）
    const otherFile = path.join(logDir, "other.txt");
    fs.writeFileSync(otherFile, "其他文件\n");

    createRotatingLogger({ logDir, retentionDays: 7, now: () => now });

    const files = fs.readdirSync(logDir);
    // 旧文件应被清理，保留较新和今天的
    expect(files).toContain("feishu-bridge-2026-06-24.log");
    expect(files).toContain("feishu-bridge-2026-06-27.log");
    expect(files).toContain("other.txt");
    expect(files).not.toContain("feishu-bridge-2026-06-17.log");
  });

  it("返回的 logger 函数兼容 (msg: string) => void 签名", () => {
    const logger = createRotatingLogger({ logDir, retentionDays: 7 });

    // 验证可以被现有 logger 类型接受
    const fn: (msg: string) => void = logger;
    expect(typeof fn).toBe("function");

    fn("类型兼容性测试");
    const files = fs.readdirSync(logDir);
    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
    expect(content).toContain("类型兼容性测试");
  });

  it("logDir 不存在时自动创建", () => {
    const nestedDir = path.join(logDir, "deep", "nested");
    const logger = createRotatingLogger({ logDir: nestedDir, retentionDays: 7 });
    logger("嵌套目录测试");

    expect(fs.existsSync(nestedDir)).toBe(true);
    const files = fs.readdirSync(nestedDir);
    expect(files.length).toBe(1);
  });
});
