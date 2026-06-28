import { readdir, stat } from "fs/promises";
import { join } from "path";

export type FileEntry = {
  name: string;
  size: string;
  modifiedAt: string;
};

export type ListDirectoryResult =
  | { ok: true; entries: FileEntry[] }
  | { ok: false; error: string };

function humanReadableSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size % 1 === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[i]}`;
}

export async function listDirectory(dirPath: string): Promise<ListDirectoryResult> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const result: FileEntry[] = [];

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const s = await stat(fullPath);
      result.push({
        name: entry.name,
        size: humanReadableSize(s.size),
        modifiedAt: s.mtime.toISOString(),
      });
    }

    return { ok: true, entries: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `找不到路径：${dirPath}（${message}）` };
  }
}
