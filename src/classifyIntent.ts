export type IntentLabel = "simple" | "inquire" | "task";

const VALID_LABELS: IntentLabel[] = ["simple", "inquire", "task"];
const FALLBACK_LABEL: IntentLabel = "task";

export type ClassifyIntentDeps = {
  callOllama: (prompt: string) => Promise<string>;
};

function buildClassifierPrompt(message: string): string {
  return `你是 Feishu Bridge 的意图分类器。把用户消息分到以下三类之一：
- simple: 目录浏览、系统状态查询、截图、预注册别名指令等本地直接执行的操作
- inquire: 读取文件内容、摘要文件、搜索文件等需要理解文件格式的操作
- task: 需要多轮对话的复杂任务，如代码审查、重构、修改文件、执行命令等

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
// 不需要调用 Ollama 就能准确判断的指令，直接返回结果。

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
const SESSION_PATTERNS: RegExp[] = [
  /^(列出|查看)?对话(列表|列别)?$/,
  /^有哪些对话/,
  /^进入对话/,       // 空格可选：「进入对话 1」「进入对话1」「进入对话1845fff9」
  /^新对话/,
  /^当前对话/,
  /^\//,             // Claude Code 斜杠命令：/compact /clear 等
];

const INQUIRE_PATTERNS: RegExp[] = [
  /^(读取|查看|显示|打印|cat|type)\s.+/,
  /^(搜索|查找|find|grep|search)\s.+/,
  /\.(txt|log|json|md|csv|xml|yaml|yml|toml|ini|cfg)$/,
  /\b(文件|代码)\b.*\b(内容|什么|怎么样|如何|解释|说明)\b/,
  /\b(解释|说明|总结|摘要|概述)\b.*\b(代码|文件|内容|文档)\b/,
];

/**
 * 本地快速预判意图。如果匹配成功则直接返回，避免慢速 Ollama 调用。
 * 只在非常确定的情况下才返回非 null 值。
 */
function quickClassify(message: string): IntentLabel | null {
  const trimmed = message.trim();

  // 会话管理命令 → task（在 executeTask 中处理）
  for (const re of SESSION_PATTERNS) {
    if (re.test(trimmed)) return "task";
  }

  for (const re of SIMPLE_PATTERNS) {
    if (re.test(trimmed)) return "simple";
  }

  for (const re of INQUIRE_PATTERNS) {
    if (re.test(trimmed)) return "inquire";
  }

  return null; // 无法确定，交给 Ollama
}

export async function classifyIntent(
  message: string,
  deps: ClassifyIntentDeps,
): Promise<IntentLabel> {
  // 1. 本地快速预判
  const quick = quickClassify(message);
  if (quick !== null) return quick;

  // 2. Ollama 分类
  try {
    const prompt = buildClassifierPrompt(message);
    const raw = await deps.callOllama(prompt);
    const label = normalizeLabel(raw);

    // 宁可误判为 task（多花 token），不可将危险指令误判为 simple
    return label ?? FALLBACK_LABEL;
  } catch {
    // Ollama 不可用时 fallback 到 task，不丢消息
    return FALLBACK_LABEL;
  }
}
