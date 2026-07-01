import type {
  RiskRuleConfig,
  Operation,
  ConfirmationSender,
  ConfirmationResult,
  GuardResult,
} from "./types.js";

export const DEFAULT_HIGH_RISK_ACTIONS = [
  "delete",
  "system_config",
  "install",
  "uninstall",
  "registry_write",
  "run_script",
];

export const DEFAULT_LOW_RISK_ACTIONS = [
  "list_dir",
  "read_file",
  "screenshot",
  "status",
  "open_app",
  "close_app",
];

function buildDescription(operation: Operation): string {
  return `即将执行 ${operation.action}：${operation.target}`;
}

export type PermissionGateDeps = {
  ruleConfig: RiskRuleConfig;
  confirmationSender?: ConfirmationSender;
  logger?: (message: string) => void;
};

export type PermissionGate = {
  /** 同步判断 action 是否为高危 */
  isHighRisk: (action: string) => boolean;

  /**
   * 带确认门的执行入口。
   * - 低危操作直接执行，返回 status='allowed'
   * - 高危操作先发送确认卡片，等待用户回复
   *   - 允许 → 执行
   *   - 拒绝 → 取消
   *   - 超时 → 取消（默认 60 秒）
   * - openId: p2p 私聊时传入用户 open_id，确保卡片能推送到手机
   */
  guard: (
    chatId: string,
    operation: Operation,
    execute: () => Promise<string>,
    timeoutMs?: number,
    openId?: string,
  ) => Promise<GuardResult>;
};

export function createPermissionGate(deps: PermissionGateDeps): PermissionGate {
  const log = deps.logger ?? (() => {});
  const { highRiskActions } = deps.ruleConfig;

  function isHighRisk(action: string): boolean {
    return highRiskActions.includes(action);
  }

  async function guard(
    chatId: string,
    operation: Operation,
    execute: () => Promise<string>,
    timeoutMs = 60_000,
    openId?: string,
  ): Promise<GuardResult> {
    if (!isHighRisk(operation.action)) {
      // 低危操作：直接执行
      const result = await execute();
      return { status: "allowed", result };
    }

    // 高危操作：需要确认
    log(
      `[PermissionGate] 高危操作「${operation.action}: ${operation.target}」需要用户确认`,
    );

    if (!deps.confirmationSender) {
      // 没有配置确认发送器时，拒绝高危操作（安全优先）
      log("[PermissionGate] 未配置 confirmationSender，高危操作被拒绝");
      return { status: "denied" };
    }

    const title = "⚠️ 高危操作确认";
    const description = buildDescription(operation);
    const messageId = await deps.confirmationSender.sendCard(
      chatId,
      title,
      description,
      openId,
    );

    log(`[PermissionGate] 已发送确认卡片，messageId: ${messageId}`);

    const decision: ConfirmationResult =
      await deps.confirmationSender.waitForButtonClick(messageId, timeoutMs);

    log(`[PermissionGate] 确认结果: ${decision}`);

    if (decision === "allowed" || decision === "allowed_always") {
      const result = await execute();
      return { status: decision, result };
    }

    return { status: decision };
  }

  return { isHighRisk, guard };
}
