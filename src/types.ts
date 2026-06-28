export type FeishuMessageEvent = {
  message: {
    message_id: string;
    chat_id: string;
    chat_type: "p2p" | "group";
    message_type: string;
    content: string;
  };
  sender: {
    sender_type: "user" | "app";
    sender_id: { open_id?: string };
  };
};

export type MessageHandlerContext = {
  sendReply: (chatId: string, text: string) => Promise<void>;
  sendImageReply?: (chatId: string, imagePath: string) => Promise<void>;
  now: () => Date;
  logger: (message: string) => void;
};

// ---- Permission Gate ----

export type RiskLevel = "low" | "high";

/** 一个待执行的操作 */
export type Operation = {
  action: string; // 机器可读的动作标识：delete, list_dir, run_script ...
  target: string; // 操作目标：d:\temp, Chrome ...
};

/** 风险分类规则配置 */
export type RiskRuleConfig = {
  /** 以下 action 视为高危，必须二次确认 */
  highRiskActions: string[];
  /** 以下 action 视为低危，直接执行 */
  lowRiskActions: string[];
};

export type ConfirmationResult = "allowed" | "denied" | "timeout" | "allowed_always";

/** 确认门运行结果 */
export type GuardResult = {
  status: ConfirmationResult;
  result?: string; // allowed 时有执行结果
};

/**
 * 确认消息发送器 —— 解耦飞书卡片交互。
 * 后续可被 Claude Code 的 permission handler 复用。
 */
export type ConfirmationSender = {
  /** 发送飞书卡片消息，返回 message_id 用于匹配回复 */
  sendCard: (
    chatId: string,
    title: string,
    description: string,
  ) => Promise<string>;
  /** 等待用户点击卡片按钮，返回选择或超时 */
  waitForButtonClick: (
    messageId: string,
    timeoutMs: number,
  ) => Promise<"allowed" | "denied" | "allowed_always" | "timeout">;
};
