async function readResponseBytesCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const limit = Math.max(1, maxBytes);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error("response body too large");
  }
  if (!response.body) throw new Error("response body missing");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("response body too large").catch(() => undefined);
        throw new Error("response body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read response text without ever buffering more than `maxBytes`. */
export async function readTextResponseCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readResponseBytesCapped(response, maxBytes),
  );
}

/** Read and parse a response without ever buffering more than `maxBytes`. */
export async function readJsonResponseCapped<T = unknown>(
  response: Response,
  maxBytes: number,
): Promise<T> {
  return JSON.parse(await readTextResponseCapped(response, maxBytes)) as T;
}
