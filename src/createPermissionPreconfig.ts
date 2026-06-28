import type { PermissionLogger } from "./createPermissionLogger.js";
import type {
  PermissionAnalyzer,
  AnalysisReport,
  PreAuthRecommendation,
} from "./createPermissionAnalyzer.js";
import type { ClaudeSettingsWriter } from "./createClaudeSettingsWriter.js";
import { classifyToolOperation } from "./createPermissionAnalyzer.js";

// ── 依赖类型 ──

export type PermissionPreconfigDeps = {
  logger: PermissionLogger;
  analyzer: PermissionAnalyzer;
  settingsWriter: ClaudeSettingsWriter;
  /** 原始的 Claude Code CLI 调用函数 */
  callClaude: (prompt: string, timeoutMs: number) => Promise<string>;
  /** 目标项目目录（用于写入 settings.json） */
  projectDir: string;
};

// ── 包装后的 callClaude 类型 ──

export type WrappedCallClaude = (
  prompt: string,
  timeoutMs: number,
) => Promise<string>;

// ── 估算结果 ──

export type ReductionEstimation = {
  totalRequests: number;
  preAuthorizedCount: number;
  remainingConfirmationCount: number;
  reductionPercent: number;
};

// ── 编排器类型 ──

export type PermissionPreconfig = {
  /** 包装原始 callClaude，加入权限日志记录 */
  wrapCallClaude: () => WrappedCallClaude;
  /** 分析已收集的权限日志 */
  analyzeLogs: () => AnalysisReport;
  /** 获取分析摘要文本 */
  getSummary: () => string;
  /** 将推荐的预授权规则写入 settings.json */
  applyPreAuth: () => Promise<void>;
  /** 估算预授权后可减少的飞书确认次数 */
  getEstimatedReduction: () => ReductionEstimation;
};

// ── 工具估计规则 ──

/**
 * 根据用户 prompt 估计 Claude Code 会用到哪些工具。
 * 这是近似估计——用于在无法直接拦截 Claude Code 内部权限系统时，
 * 提供合理的日志记录。
 */
type ToolEstimate = {
  tool: string;
  operation: string;
  reason: string;
};

function estimateToolsNeeded(prompt: string): ToolEstimate[] {
  const estimates: ToolEstimate[] = [];
  const lower = prompt.toLowerCase();

  // 代码审查 / 代码查看 → Read + Grep + Glob + git log
  if (
    lower.includes("审查") ||
    lower.includes("review") ||
    lower.includes("看代码") ||
    lower.includes("代码")
  ) {
    estimates.push({
      tool: "Read",
      operation: "read file",
      reason: "审查代码需要读取文件",
    });
    estimates.push({
      tool: "Grep",
      operation: "search code",
      reason: "审查代码需要搜索符号",
    });
    estimates.push({
      tool: "Glob",
      operation: "find files",
      reason: "审查代码需要发现文件",
    });
    estimates.push({
      tool: "Bash",
      operation: "git log --oneline",
      reason: "审查代码需要查看版本历史",
    });
    estimates.push({
      tool: "Bash",
      operation: "git diff HEAD~1",
      reason: "审查代码需要查看变更",
    });
    estimates.push({
      tool: "Bash",
      operation: "git status",
      reason: "审查代码需要了解工作区状态",
    });
  }

  // 修改代码 → Edit / Write
  if (
    lower.includes("修改") ||
    lower.includes("修复") ||
    lower.includes("fix") ||
    lower.includes("改") ||
    lower.includes("写") ||
    lower.includes("创建") ||
    lower.includes("新建")
  ) {
    estimates.push({
      tool: "Edit",
      operation: "modify file",
      reason: "修改/创建文件需要编辑",
    });
    estimates.push({
      tool: "Write",
      operation: "write file",
      reason: "修改/创建文件可能需要新建文件",
    });
    // 修改后通常需要读取和搜索
    estimates.push({
      tool: "Read",
      operation: "read file",
      reason: "修改前需要读取文件",
    });
    estimates.push({
      tool: "Grep",
      operation: "search code",
      reason: "修改前需要搜索相关代码",
    });
  }

  // 运行测试 → Bash
  if (
    lower.includes("测试") ||
    lower.includes("test") ||
    lower.includes("运行") ||
    lower.includes("跑")
  ) {
    estimates.push({
      tool: "Bash",
      operation: "npx vitest run",
      reason: "运行测试",
    });
    estimates.push({
      tool: "Read",
      operation: "read test output",
      reason: "读取测试输出",
    });
  }

  // 搜索/查找 → Grep + Glob
  if (
    lower.includes("搜索") ||
    lower.includes("search") ||
    lower.includes("find") ||
    lower.includes("查找") ||
    lower.includes("找")
  ) {
    estimates.push({
      tool: "Grep",
      operation: "search code",
      reason: "搜索代码内容",
    });
    estimates.push({
      tool: "Glob",
      operation: "find files",
      reason: "搜索文件名",
    });
  }

  // 文件读取 → Read
  if (
    lower.includes("读取") ||
    lower.includes("读") ||
    lower.includes("查看") ||
    lower.includes("read")
  ) {
    estimates.push({
      tool: "Read",
      operation: "read file",
      reason: "读取文件内容",
    });
  }

  // 默认至少 Read + Grep（Claude Code 几乎总是需要读代码）
  if (estimates.length === 0) {
    estimates.push({
      tool: "Read",
      operation: "read file",
      reason: "任务需要读取文件",
    });
    estimates.push({
      tool: "Grep",
      operation: "search code",
      reason: "任务需要搜索代码",
    });
  }

  // 去重（按 tool）
  const seen = new Set<string>();
  return estimates.filter((e) => {
    if (seen.has(e.tool)) return false;
    seen.add(e.tool);
    return true;
  });
}

// ── 工厂函数 ──

export function createPermissionPreconfig(
  deps: PermissionPreconfigDeps,
): PermissionPreconfig {
  const { logger, analyzer, settingsWriter, callClaude, projectDir } = deps;

  function wrapCallClaude(): WrappedCallClaude {
    return async (prompt: string, timeoutMs: number): Promise<string> => {
      // 执行前：估计并记录可能需要的工具
      const estimates = estimateToolsNeeded(prompt);
      for (const est of estimates) {
        logger.log({
          tool: est.tool,
          operation: est.operation,
          target: prompt.slice(0, 100), // 用 prompt 前 100 字符作为 target
          category: classifyToolOperation(est.tool, est.operation),
        });
      }

      try {
        const result = await callClaude(prompt, timeoutMs);
        return result;
      } catch (err) {
        // 即使失败也记录了日志
        throw err;
      }
    };
  }

  function analyzeLogs(): AnalysisReport {
    return analyzer.analyze(logger.getAll());
  }

  function getSummary(): string {
    return analyzer.formatSummary(analyzeLogs());
  }

  async function applyPreAuth(): Promise<void> {
    const report = analyzeLogs();
    const rules = report.recommendations.map((r) => r.rule);
    const ruleMeta = report.recommendations.map((r) => ({
      rule: r.rule,
      reason: r.reason,
    }));

    if (rules.length === 0) {
      return;
    }

    await settingsWriter.writeSettings(projectDir, rules, ruleMeta);
  }

  function getEstimatedReduction(): ReductionEstimation {
    const report = analyzeLogs();
    const totalRequests = report.totalRequests;
    const writeRequests = report.writeRequests;
    const preAuthorizedCount = totalRequests - writeRequests;

    const reductionPercent =
      totalRequests > 0
        ? Math.round((preAuthorizedCount / totalRequests) * 100)
        : 0;

    return {
      totalRequests,
      preAuthorizedCount,
      remainingConfirmationCount: writeRequests,
      reductionPercent,
    };
  }

  return {
    wrapCallClaude,
    analyzeLogs,
    getSummary,
    applyPreAuth,
    getEstimatedReduction,
  };
}
