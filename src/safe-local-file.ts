import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Read one regular file without following symlinks or crossing a byte ceiling. */
export function readTextFileSyncCapped(path: string, maxBytes: number): string | null {
  const limit = Math.max(1, maxBytes);
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size > limit) return null;

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const allowance = Math.min(64 * 1024, limit + 1 - total);
      if (allowance <= 0) return null;
      const chunk = Buffer.allocUnsafe(allowance);
      const count = readSync(fd, chunk, 0, allowance, null);
      if (count === 0) break;
      total += count;
      if (total > limit) return null;
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

/** Atomically replace a local private file; data never exists above mode 0600. */
export function writePrivateFileAtomic(path: string, content: string, maxBytes: number): boolean {
  if (Buffer.byteLength(content, "utf8") > Math.max(1, maxBytes)) return false;
  const dir = dirname(path);
  let tmp: string | null = null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Windows and some mounted filesystems do not expose POSIX modes.
    }
    tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Creation mode is still requested above.
    }
    renameSync(tmp, path);
    tmp = null;
    return true;
  } catch {
    return false;
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
