import { buildPingPongReply } from "./buildPingPongReply.js";
import type { FeishuMessageEvent } from "./types.js";

export type { FeishuMessageEvent };

export type FeishuMessageHandlerDeps = {
  sendReply: (chatId: string, text: string) => Promise<void>;
  now: () => Date;
};

export async function handleFeishuMessage(
  event: FeishuMessageEvent,
  deps: FeishuMessageHandlerDeps,
): Promise<void> {
  if (event.sender.sender_type === "app") {
    return;
  }

  const chatId = event.message.chat_id;
  const reply = buildPingPongReply(deps.now());
  await deps.sendReply(chatId, reply);
}
