import { writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";

export type SessionEntry = {
  sessionId: string;
  projectDir: string;
  feishuChatId: string;
  createdAt: Date;
  lastActive: Date;
  /** 最近一次「列出对话」使用的项目筛选词 */
  lastFilter?: string;
};

/** JSON 文件中存储的序列化格式（Date → ISO string） */
type SerializedSession = Omit<SessionEntry, "createdAt" | "lastActive"> & {
  createdAt: string;
  lastActive: string;
  lastFilter?: string;
};

type PersistData = { version: 1; sessions: SerializedSession[] };

export type SessionRegistryDeps = {
  now: () => Date;
  /** 可选：JSON 文件持久化路径。设置后会话将自动保存到该文件。 */
  persistPath?: string;
};

export type SessionRegistry = {
  /** 注册或覆盖一个会话（按 chat_id 去重） */
  register: (entry: {
    sessionId: string;
    projectDir: string;
    feishuChatId: string;
    createdAt?: Date;
    lastActive?: Date;
    lastFilter?: string;
  }) => void;
  /** 按飞书 chat_id 查找 */
  findByChatId: (chatId: string) => SessionEntry | null;
  /** 按项目目录查找 */
  findByProjectDir: (projectDir: string) => SessionEntry | null;
  /** 更新时间戳，返回是否成功 */
  touch: (sessionId: string, at?: Date) => boolean;
  /** 清理超过 maxInactiveMs 毫秒无活动的会话，返回清理数量 */
  cleanup: (maxInactiveMs: number, at?: Date) => number;
  /** 移除指定会话，返回是否成功 */
  remove: (sessionId: string) => boolean;
  /** 列出所有活跃会话 */
  list: () => SessionEntry[];
};

export function createSessionRegistry(deps: SessionRegistryDeps): SessionRegistry {
  // chat_id → SessionEntry
  const byChatId = new Map<string, SessionEntry>();

  // ── 持久化 ──

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleSave(): void {
    if (!deps.persistPath) return;
    if (saveTimer) clearTimeout(saveTimer);
    // 去抖 500ms：合并连续写入
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistToFile();
    }, 500);
  }

  async function persistToFile(): Promise<void> {
    if (!deps.persistPath) return;
    try {
      const data: PersistData = {
        version: 1,
        sessions: Array.from(byChatId.values()).map(serialize),
      };
      await writeFile(deps.persistPath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // 持久化失败静默忽略（下次操作会重试）
    }
  }

  function serialize(entry: SessionEntry): SerializedSession {
    return {
      sessionId: entry.sessionId,
      projectDir: entry.projectDir,
      feishuChatId: entry.feishuChatId,
      createdAt: entry.createdAt.toISOString(),
      lastActive: entry.lastActive.toISOString(),
      lastFilter: entry.lastFilter,
    };
  }

  function deserialize(s: SerializedSession): SessionEntry {
    return {
      sessionId: s.sessionId,
      projectDir: s.projectDir,
      feishuChatId: s.feishuChatId,
      createdAt: new Date(s.createdAt),
      lastActive: new Date(s.lastActive),
      lastFilter: s.lastFilter,
    };
  }

  // 启动时从文件加载
  if (deps.persistPath && existsSync(deps.persistPath)) {
    loadFromFile(deps.persistPath);
  }

  async function loadFromFile(filePath: string): Promise<void> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const data: PersistData = JSON.parse(raw);
      if (data.version === 1 && Array.isArray(data.sessions)) {
        for (const s of data.sessions) {
          const entry = deserialize(s);
          byChatId.set(entry.feishuChatId, entry);
        }
      }
    } catch {
      // 文件损坏或格式错误，从空注册表开始
    }
  }

  // ── 操作（每次变更后触发 scheduleSave） ──

  function register(entry: {
    sessionId: string;
    projectDir: string;
    feishuChatId: string;
    createdAt?: Date;
    lastActive?: Date;
    lastFilter?: string;
  }): void {
    const now = deps.now();
    byChatId.set(entry.feishuChatId, {
      sessionId: entry.sessionId,
      projectDir: entry.projectDir,
      feishuChatId: entry.feishuChatId,
      createdAt: entry.createdAt ?? now,
      lastActive: entry.lastActive ?? now,
      lastFilter: entry.lastFilter,
    });
    scheduleSave();
  }

  function findByChatId(chatId: string): SessionEntry | null {
    return byChatId.get(chatId) ?? null;
  }

  function findByProjectDir(projectDir: string): SessionEntry | null {
    for (const entry of byChatId.values()) {
      if (entry.projectDir === projectDir) return entry;
    }
    return null;
  }

  function touch(sessionId: string, at?: Date): boolean {
    const entry = findBySessionId(sessionId);
    if (!entry) return false;
    entry.lastActive = at ?? deps.now();
    scheduleSave();
    return true;
  }

  function cleanup(maxInactiveMs: number, at?: Date): number {
    const now = at ?? deps.now();
    let cleaned = 0;

    for (const [chatId, entry] of byChatId) {
      const inactiveMs = now.getTime() - entry.lastActive.getTime();
      if (inactiveMs > maxInactiveMs) {
        byChatId.delete(chatId);
        cleaned++;
      }
    }

    if (cleaned > 0) scheduleSave();
    return cleaned;
  }

  function remove(sessionId: string): boolean {
    const entry = findBySessionId(sessionId);
    if (!entry) return false;
    byChatId.delete(entry.feishuChatId);
    scheduleSave();
    return true;
  }

  function list(): SessionEntry[] {
    return Array.from(byChatId.values());
  }

  /** 按 sessionId 查找内部条目 */
  function findBySessionId(sessionId: string): SessionEntry | null {
    for (const entry of byChatId.values()) {
      if (entry.sessionId === sessionId) return entry;
    }
    return null;
  }

  return {
    register,
    findByChatId,
    findByProjectDir,
    touch,
    cleanup,
    remove,
    list,
  };
}
