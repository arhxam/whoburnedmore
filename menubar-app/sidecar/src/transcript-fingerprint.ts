import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Metadata only: avoid starting a parser and rereading gigabytes of unchanged
 * history on every safety poll. Failed/incomplete discovery is never cacheable.
 * Include path, inode, size and nanosecond times to detect moves/replacements as
 * well as appends. Do not follow directory symlinks or recurse without a bound. */
export async function transcriptFingerprint(roots: string[]): Promise<string | null> {
  const hash = createHash("sha256");
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 64 || ++visited > 100_000) throw new Error("transcript tree too large");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update(JSON.stringify([dir, "missing"]));
        return;
      }
      throw error;
    }
    hash.update(JSON.stringify([dir, "present"]));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (++visited > 100_000) throw new Error("transcript tree too large");
        const info = await stat(path, { bigint: true });
        hash.update(JSON.stringify([
          path, String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs),
        ]));
      }
    }
  };
  try {
    for (const root of roots) await walk(root, 0);
    return hash.digest("hex");
  } catch {
    return null;
  }
}
