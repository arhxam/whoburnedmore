import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { MAX_NATIVE_FILE_BYTES } from "./file-cache.js";

/** Stream transcripts without a total-file ceiling. Bound individual records so
 * malformed input cannot grow a pending line without limit. Decode only after
 * joining bytes, preserving UTF-8 characters split across read boundaries. */
export async function readJsonlStream(
  path: string,
  onLine: (line: string) => void,
  opts: { deadline: number; now?: () => number; maxLineBytes?: number },
): Promise<{ ok: true } | { ok: false; reason: "unreadable" | "too-large" | "timed-out" }> {
  const now = opts.now ?? Date.now;
  const maxLineBytes = Math.max(1, opts.maxLineBytes ?? MAX_NATIVE_FILE_BYTES);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile()) return { ok: false, reason: "unreadable" };
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    const after = await lstat(path);
    if (!opened.isFile() || !after.isFile() ||
        before.dev !== opened.dev || before.ino !== opened.ino ||
        after.dev !== opened.dev || after.ino !== opened.ino) {
      return { ok: false, reason: "unreadable" };
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let parts: Buffer[] = [];
    let pendingBytes = 0;
    while (true) {
      if (now() > opts.deadline) return { ok: false, reason: "timed-out" };
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(10, start);
        const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
        const length = end - start;
        if (pendingBytes + length > maxLineBytes) return { ok: false, reason: "too-large" };
        // Copy because the I/O buffer is reused on the next read.
        parts.push(Buffer.from(chunk.subarray(start, end)));
        pendingBytes += length;
        if (end < bytesRead) {
          if (now() > opts.deadline) return { ok: false, reason: "timed-out" };
          onLine(Buffer.concat(parts, pendingBytes).toString("utf8"));
          parts = [];
          pendingBytes = 0;
        }
        start = end + 1;
      }
    }
    if (now() > opts.deadline) return { ok: false, reason: "timed-out" };
    if (pendingBytes > 0) onLine(Buffer.concat(parts, pendingBytes).toString("utf8"));
    if (now() > opts.deadline) return { ok: false, reason: "timed-out" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
