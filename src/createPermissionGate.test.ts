import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPermissionGate,
  DEFAULT_HIGH_RISK_ACTIONS,
  DEFAULT_LOW_RISK_ACTIONS,
} from "./createPermissionGate.js";
import type { RiskRuleConfig, Operation, ConfirmationSender } from "./types.js";

describe("createPermissionGate — 风险分类", () => {
  const defaultConfig: RiskRuleConfig = {
    highRiskActions: DEFAULT_HIGH_RISK_ACTIONS,
    lowRiskActions: DEFAULT_LOW_RISK_ACTIONS,
  };

  it("低危操作（list_dir）直接返回 isHighRisk=false", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("list_dir")).toBe(false);
  });

  it("低危操作（read_file）直接返回 isHighRisk=false", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("read_file")).toBe(false);
  });

  it("低危操作（screenshot）直接返回 isHighRisk=false", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("screenshot")).toBe(false);
  });

  it("低危操作（status）直接返回 isHighRisk=false", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("status")).toBe(false);
  });

  it("低危操作（open_app）直接返回 isHighRisk=false", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("open_app")).toBe(false);
  });

  it("高危操作（delete）返回 isHighRisk=true", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("delete")).toBe(true);
  });

  it("高危操作（system_config）返回 isHighRisk=true", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("system_config")).toBe(true);
  });

  it("高危操作（install）返回 isHighRisk=true", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("install")).toBe(true);
  });

  it("高危操作（uninstall）返回 isHighRisk=true", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("uninstall")).toBe(true);
  });

  it("高危操作（registry_write）返回 isHighRisk=true", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("registry_write")).toBe(true);
  });

  it("高危操作（run_script）返回 isHighRisk=true", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    expect(gate.isHighRisk("run_script")).toBe(true);
  });

  it("自定义规则：可以覆盖默认分类", () => {
    // 假如用户想把 screenshot 也设为高危
    const customConfig: RiskRuleConfig = {
      highRiskActions: [...DEFAULT_HIGH_RISK_ACTIONS, "screenshot"],
      lowRiskActions: DEFAULT_LOW_RISK_ACTIONS.filter((a) => a !== "screenshot"),
    };

    const gate = createPermissionGate({ ruleConfig: customConfig });
    expect(gate.isHighRisk("screenshot")).toBe(true);
  });

  it("未知 action 默认视为低危（不过度拦截）", () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    // 一个不在任何列表中的 action
    expect(gate.isHighRisk("unknown_action")).toBe(false);
  });
});

describe("createPermissionGate — guard 确认流程", () => {
  const defaultConfig: RiskRuleConfig = {
    highRiskActions: DEFAULT_HIGH_RISK_ACTIONS,
    lowRiskActions: DEFAULT_LOW_RISK_ACTIONS,
  };

  function mockConfirmationSender(result: "allowed" | "denied" | "timeout") {
    return {
      sendCard: vi.fn().mockResolvedValue("msg_card_001"),
      waitForButtonClick: vi.fn().mockResolvedValue(result),
    };
  }

  it("低危操作：直接执行，不发送确认卡片", async () => {
    const sender = mockConfirmationSender("allowed");
    const gate = createPermissionGate({
      ruleConfig: defaultConfig,
      confirmationSender: sender,
    });

    const execute = vi.fn().mockResolvedValue("📂 D:\\ 目录列表…");
    const result = await gate.guard("oc_123", { action: "list_dir", target: "D:\\" }, execute);

    expect(result.status).toBe("allowed");
    expect(result.result).toBe("📂 D:\\ 目录列表…");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sender.sendCard).not.toHaveBeenCalled();
  });

  it("高危操作 + 用户允许：发送卡片 → 等待 → 执行", async () => {
    const sender = mockConfirmationSender("allowed");
    const gate = createPermissionGate({
      ruleConfig: defaultConfig,
      confirmationSender: sender,
    });

    const execute = vi.fn().mockResolvedValue("已删除 d:\\temp");
    const result = await gate.guard(
      "oc_123",
      { action: "delete", target: "d:\\temp" },
      execute,
    );

    expect(result.status).toBe("allowed");
    expect(result.result).toBe("已删除 d:\\temp");
    expect(sender.sendCard).toHaveBeenCalledWith(
      "oc_123",
      "⚠️ 高危操作确认",
      "即将执行 delete：d:\\temp",
    );
    expect(sender.waitForButtonClick).toHaveBeenCalledWith("msg_card_001", 60_000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("高危操作 + 用户拒绝：发送卡片 → 等待 → 不执行，返回 denied", async () => {
    const sender = mockConfirmationSender("denied");
    const gate = createPermissionGate({
      ruleConfig: defaultConfig,
      confirmationSender: sender,
    });

    const execute = vi.fn();
    const result = await gate.guard(
      "oc_456",
      { action: "run_script", target: "d:\\evil.bat" },
      execute,
    );

    expect(result.status).toBe("denied");
    expect(result.result).toBeUndefined();
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("高危操作 + 超时：发送卡片 → 超时 → 不执行，返回 timeout", async () => {
    const sender = mockConfirmationSender("timeout");
    const gate = createPermissionGate({
      ruleConfig: defaultConfig,
      confirmationSender: sender,
    });

    const execute = vi.fn();
    const result = await gate.guard(
      "oc_789",
      { action: "install", target: "unknown-software.exe" },
      execute,
    );

    expect(result.status).toBe("timeout");
    expect(result.result).toBeUndefined();
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("可使用自定义超时时间", async () => {
    const sender = mockConfirmationSender("timeout");
    const gate = createPermissionGate({
      ruleConfig: defaultConfig,
      confirmationSender: sender,
    });

    await gate.guard(
      "oc_123",
      { action: "delete", target: "d:\\temp" },
      vi.fn(),
      30_000, // 30 秒超时
    );

    expect(sender.waitForButtonClick).toHaveBeenCalledWith("msg_card_001", 30_000);
  });

  it("未配置 confirmationSender 时，高危操作直接拒绝（安全优先）", async () => {
    const gate = createPermissionGate({ ruleConfig: defaultConfig });
    const execute = vi.fn();

    const result = await gate.guard(
      "oc_123",
      { action: "delete", target: "d:\\temp" },
      execute,
    );

    expect(result.status).toBe("denied");
    expect(execute).not.toHaveBeenCalled();
  });
});
