export type ErrorType = "file_not_found" | "permission_denied" | "timeout" | "unknown";

export type ErrorContext = {
  type: ErrorType;
  detail: string;
};

/**
 * 根据错误消息文本分类错误类型。
 * 用于将 Node.js / Windows 系统错误消息映射到统一的 ErrorType。
 */
export function classifyError(message: string): ErrorType {
  const lower = message.toLowerCase();

  // 文件不存在
  if (
    lower.includes("enoent") ||
    lower.includes("no such file") ||
    lower.includes("cannot find the file") ||
    lower.includes("找不到文件") ||
    lower.includes("文件不存在")
  ) {
    return "file_not_found";
  }

  // 权限不足
  if (
    lower.includes("eacces") ||
    lower.includes("permission denied") ||
    lower.includes("access is denied") ||
    lower.includes("权限不足") ||
    lower.includes("拒绝访问")
  ) {
    return "permission_denied";
  }

  // 超时
  if (
    lower.includes("etimedout") ||
    lower.includes("timed out") ||
    lower.includes("超时") ||
    lower.includes("timeout")
  ) {
    return "timeout";
  }

  return "unknown";
}

/** 每种错误类型对应的用户建议 */
const SUGGESTIONS: Record<ErrorType, string> = {
  file_not_found: "请确认文件路径是否正确，文件是否已被移动或删除。",
  permission_denied:
    "请以管理员身份运行程序，或检查文件夹权限设置。",
  timeout: "操作超时，请稍后重试。如持续超时可检查网络连接或重启服务。",
  unknown: "请查看日志获取更多信息，或联系管理员。",
};

/** 每种错误类型对应的中文标签 */
const LABELS: Record<ErrorType, string> = {
  file_not_found: "文件不存在",
  permission_denied: "权限不足",
  timeout: "操作超时",
  unknown: "未知错误",
};

/**
 * 格式化错误消息为用户可读文本。
 * 统一格式：❌ [错误类型] 详情\n💡 建议
 */
export function formatErrorMessage(ctx: ErrorContext): string {
  const label = LABELS[ctx.type];
  const suggestion = SUGGESTIONS[ctx.type];
  return `❌ ${label}：${ctx.detail}\n💡 ${suggestion}`;
}
