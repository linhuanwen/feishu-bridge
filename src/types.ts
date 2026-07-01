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
  /** 发送文本回复。传入 replyToMessageId 时使用线程回复，否则发送新消息。返回发送成功的 message_id。 */
  sendReply: (chatId: string, text: string, replyToMessageId?: string) => Promise<string>;
  sendImageReply?: (chatId: string, imagePath: string) => Promise<void>;
  /** 发送富文本（post）消息。content 为飞书 post 格式 JSON 字符串，也可传 markdown 文本自动转换。 */
  sendPostReply?: (chatId: string, postContent: string, replyToMessageId?: string) => Promise<string>;
  /** 撤回/删除机器人自己发送的消息（24 小时内有效） */
  deleteMessage?: (messageId: string) => Promise<void>;
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
  /** 发送飞书卡片消息，返回 message_id 用于匹配回复。
   * 传入 openId 时使用 receive_id_type="open_id"（p2p 私聊推送必须），
   * 否则回退到 chat_id。 */
  sendCard: (
    chatId: string,
    title: string,
    description: string,
    openId?: string,
  ) => Promise<string>;
  /** 等待用户点击卡片按钮，返回选择或超时 */
  waitForButtonClick: (
    messageId: string,
    timeoutMs: number,
  ) => Promise<"allowed" | "denied" | "allowed_always" | "timeout">;
};
