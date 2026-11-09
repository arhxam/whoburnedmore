// Synthetic child-process fixture. Pause the actual atomic write to make overlap
// deterministic, without adding test hooks to the production transaction.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { sep } from "node:path";

const [modulePath, storePath, inputJson, pausePath] = process.argv.slice(2);
const input = JSON.parse(inputJson);
const waitFor = (path) => {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path)) {
    if (Date.now() > deadline) throw new Error("fixture barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
const rename = fs.renameSync;
const unlink = fs.unlinkSync;
const rmdir = fs.rmdirSync;
let reaped = false;
fs.unlinkSync = function (path) {
  if (input.reapBarrier && path.startsWith(`${storePath}.lock${sep}`)) {
    process.send({ event: "reaping" });
    waitFor(input.reapBarrier);
    reaped = true;
  }
  return unlink(path);
};
fs.rmdirSync = function (path) {
  try { return rmdir(path); }
  finally {
    if (path === `${storePath}.lock` && reaped) {
      process.send({ event: "reaped" });
      reaped = false;
    }
  }
};
fs.renameSync = function (from, to) {
  if (to === storePath && pausePath) {
    process.send({ event: "saving" });
    waitFor(pausePath);
  }
  try {
    return rename(from, to);
  } catch (error) {
    if (to === `${storePath}.lock`) process.send({ event: "contended" });
    throw error;
  }
};
syncBuiltinESMExports();
const store = await import(modulePath);
// The legacy path lets this regression reproduce the original lost update on
// main, before the transaction helper exists.
const persist = store.reconcileAndSaveProvenance ?? (async (path, entries, agent, complete) => {
  const result = store.reconcileProvenance(entries, agent, complete, store.loadProvenanceStore(path));
  store.saveProvenanceStore(path, result.store);
  return result;
});
const result = await persist(storePath, input.entries, input.agent, input.complete);
process.send({ event: "done", result }, () => process.disconnect());
