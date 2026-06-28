import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createStartupManager } from "./createStartupManager.js";

describe("createStartupManager", () => {
  let tmpDir: string;
  let startupDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-startup-test-"));
    startupDir = path.join(tmpDir, "Startup");
    fs.mkdirSync(startupDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enable 在启动目录创建快捷方式", () => {
    const mgr = createStartupManager({
      startupDir,
      appName: "Feishu Bridge",
      command: "node d:\\tool\\yuancheng\\dist\\main.js",
    });

    mgr.enable();

    const files = fs.readdirSync(startupDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("Feishu Bridge");
  });

  it("isEnabled 在快捷方式存在时返回 true", () => {
    const mgr = createStartupManager({
      startupDir,
      appName: "Feishu Bridge",
      command: "node d:\\tool\\yuancheng\\dist\\main.js",
    });

    expect(mgr.isEnabled()).toBe(false);

    mgr.enable();
    expect(mgr.isEnabled()).toBe(true);
  });

  it("disable 删除快捷方式", () => {
    const mgr = createStartupManager({
      startupDir,
      appName: "Feishu Bridge",
      command: "node d:\\tool\\yuancheng\\dist\\main.js",
    });

    mgr.enable();
    expect(mgr.isEnabled()).toBe(true);

    mgr.disable();
    expect(mgr.isEnabled()).toBe(false);
  });

  it("disable 对已删除的状态是幂等的", () => {
    const mgr = createStartupManager({
      startupDir,
      appName: "Feishu Bridge",
      command: "node test.js",
    });

    // 连续两次 disable 不抛错
    expect(() => {
      mgr.disable();
      mgr.disable();
    }).not.toThrow();
  });

  it("enable 覆盖已有的快捷方式", () => {
    const mgr = createStartupManager({
      startupDir,
      appName: "Feishu Bridge",
      command: "v1 command",
    });

    mgr.enable();
    const firstFiles = fs.readdirSync(startupDir);

    // 用不同命令再次 enable
    const mgr2 = createStartupManager({
      startupDir,
      appName: "Feishu Bridge",
      command: "v2 command",
    });
    mgr2.enable();

    const secondFiles = fs.readdirSync(startupDir);
    // 应该只有一个文件（覆盖而非新建）
    expect(secondFiles.length).toBe(1);
  });

  it("创建的快捷方式文件内容包含目标命令", () => {
    const mgr = createStartupManager({
      startupDir,
      appName: "Feishu Bridge",
      command: 'cmd /c "cd d:\\tool\\yuancheng && npm start"',
    });

    mgr.enable();

    const files = fs.readdirSync(startupDir);
    const shortcutPath = path.join(startupDir, files[0]);
    const content = fs.readFileSync(shortcutPath, "utf-8");

    // 检查 VBS 脚本包含了命令
    expect(content).toContain("d:\\tool\\yuancheng");
    expect(content).toContain("npm start");
  });

  it("支持获取启动目录路径", () => {
    const mgr = createStartupManager({
      startupDir,
      appName: "Feishu Bridge",
      command: "node test.js",
    });

    expect(mgr.getStartupPath()).toBe(startupDir);
  });
});
