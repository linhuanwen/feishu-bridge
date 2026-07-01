export type IntentLabel = "simple" | "inquire" | "task";

const VALID_LABELS: IntentLabel[] = ["simple", "inquire", "task"];
const FALLBACK_LABEL: IntentLabel = "task";

export type ClassifyIntentDeps = {
  callAI: (prompt: string) => Promise<string>;
};

function buildClassifierPrompt(message: string): string {
  return `你是 Feishu Bridge 的意图分类器。把用户消息分到以下三类之一：
- simple: 系统状态查询、截图、屏幕、打开/关闭程序、ls/目录浏览等本地直接执行的操作
- inquire: 读取文件内容、摘要文件、搜索代码等需要理解文件路径的操作
- task: 需要 Claude Code 处理的任务——代码审查、重构、修改文件、执行命令、回答编程问题、聊天问答、项目相关咨询等

重要：聊天对话（如"说一下你是谁""帮我解释一下"）和编程问答应归为 task，不要归为 simple。
只回复一个单词：simple、inquire 或 task。

用户消息：
\`\`\`
${message}
\`\`\``;
}

function normalizeLabel(raw: string): IntentLabel | null {
  const cleaned = raw.trim().toLowerCase();
  // 从返回文本中提取第一个匹配的分类词（兼容模型输出废话的情况）
  for (const label of VALID_LABELS) {
    if (cleaned.includes(label)) return label;
  }
  return null;
}

// ── 本地关键词快速预判 ──
// 不需要调用 AI API 就能准确判断的指令，直接返回结果。

/** 去除飞书消息中的 @mention 标记，避免干扰分类匹配 */
function stripAtMentions(text: string): string {
  let cleaned = text.replace(/<at\b[^>]*>.*?<\/at>/gi, "");
  cleaned = cleaned.replace(/@_user_\w+/g, "");
  return cleaned.trim();
}

const SIMPLE_PATTERNS: RegExp[] = [
  /^(状态|截图|拍照|屏幕|系统)/,
  /^(ls|dir|列出|目录|ll)\b/,
  /^(打开|启动|运行|关闭|停止|kill|删除|del|rm|remove)\s/i,
  /^(notepad|calc|mspaint|taskmgr|control)\b/i,
  /^(日期|时间|现在几点|今天星期几)/,
  /^(帮助|help|命令|使用说明|怎么用|功能)/,
  /^(ping|ipconfig|whoami|hostname)\b/i,
];

// 会话管理命令 — 直接走 task → executeTask 处理
// 注意：使用 startsWith 代替精确正则，因为消息末尾可能带有 @mention（如 @_user_1）
const SESSION_PATTERNS: RegExp[] = [
  /^(列出|查看)?对话(列表|列别)?/,   // 去掉 $ 锚点，兼容末尾 @mention
  /^有哪些对话/,
  /^进入对话/,       // 空格可选：「进入对话 1」「进入对话1」「进入对话1845fff9」
  /^新(对话|会话)/,   // 「新对话」「新会话」
  /^当前对话/,
  /^退出(会话|对话)?$/,  // 「退出」「退出会话」「退出对话」
  /[^\s]+对话(列表|列别)?$/,  // 「xxx对话」— 按项目关键词筛选对话（如「yuancheng对话」）
  /^\//,             // Claude Code 斜杠命令：/compact /clear 等
];

/** SWI 工作管家已处理的命令 —— feishu-bridge 收到后应静默跳过，避免重复响应 */
export const SWI_PATTERNS: RegExp[] = [
  /^(帮助|help)$/,
  /^(待办|列表)$/,
  /^(完成|done)\s*\d+/i,
];

/** 需要转发到 SWI HTTP API 处理的命令（feishu-bridge 作为代理调用 SWI） */
export const SWI_FORWARD_PATTERNS: RegExp[] = [
  /^(生成报告|重新生成报告|表格审核|审核表格|表格报告)$/,
];

const INQUIRE_PATTERNS: RegExp[] = [
  /^(读取|查看|显示|打印|cat|type)\s.+/,
  /^(搜索|查找|find|grep|search)\s.+/,
  /\.(txt|log|json|md|csv|xml|yaml|yml|toml|ini|cfg)$/,
  /\b(文件|代码)\b.*\b(内容|什么|怎么样|如何|解释|说明)\b/,
  /\b(解释|说明|总结|摘要|概述)\b.*\b(代码|文件|内容|文档)\b/,
];

/**
 * 本地快速预判意图。如果匹配成功则直接返回，避免 API 调用开销。
 * 只在非常确定的情况下才返回非 null 值。
 */
function quickClassify(message: string): IntentLabel | null {
  // 预处理：去除 @mention 标记，避免 @_user_1 等干扰分类
  const trimmed = stripAtMentions(message);

  // 会话管理命令 → task（在 executeTask 中处理）
  for (const re of SESSION_PATTERNS) {
    if (re.test(trimmed)) return "task";
  }

  // 包含对话上下文关键词的消息 → task（需要 --resume 续接会话）
  // 例如：「显示该对话里上一个输入的命令是什么」「刚才说的那个文件在哪」
  const CONVERSATION_CONTEXT_RE =
    /(该对话|这个对话|当前对话|会话中|上一个(输入|命令|问题|消息)|刚才说|之前说的|前面说的)/;
  if (CONVERSATION_CONTEXT_RE.test(trimmed)) return "task";

  // 通用聊天/问答 → task（Claude Code 直接回答，不经过本地指令匹配）
  // 避免 AI 将聊天问题误判为 simple，导致「命令已执行。」
  const GENERAL_CHAT_RE =
    /^(说一下|说说|说下|解释一下|介绍|介绍一下|告诉我|教我|帮我|为什么|为啥|怎么|如何|怎样|什么是|啥是|什么叫|哪家|哪个|哪种|哪里|能不能|可以|有没有|是否|你是|你会|你知道|你知道|请帮|请说|请解释)/;
  if (GENERAL_CHAT_RE.test(trimmed)) return "task";

  for (const re of SIMPLE_PATTERNS) {
    if (re.test(trimmed)) return "simple";
  }

  for (const re of INQUIRE_PATTERNS) {
    if (re.test(trimmed)) return "inquire";
  }

  return null; // 无法确定，交给 AI API 分类
}

export async function classifyIntent(
  message: string,
  deps: ClassifyIntentDeps,
): Promise<IntentLabel> {
  // 1. 本地快速预判
  const quick = quickClassify(message);
  if (quick !== null) return quick;

  // 2. AI 分类（DeepSeek API）
  try {
    const prompt = buildClassifierPrompt(message);
    const raw = await deps.callAI(prompt);
    const label = normalizeLabel(raw);

    // 宁可误判为 task（多花 token），不可将危险指令误判为 simple
    return label ?? FALLBACK_LABEL;
  } catch {
    // AI API 不可用时 fallback 到 task，不丢消息
    return FALLBACK_LABEL;
  }
}
