/** 一条指令的配置条目 */
export type CommandEntry = {
  /** 内部指令标识符，如 "listDirectory"、"screenshot" */
  id: string;
  /** 用户可用的别名，如 ["ls", "dir", "列出"] */
  aliases: string[];
  /** 是否需要参数（如路径、程序名） */
  needsArg: boolean;
};

/** 程序名到可执行文件的映射 */
export type ProgramEntry = {
  executable: string;
  processName: string;
};

/** 指令配置的完整结构 */
export type CommandConfig = {
  commands: CommandEntry[];
  scriptWhitelist: string[];
  programMap: Record<string, ProgramEntry>;
};
