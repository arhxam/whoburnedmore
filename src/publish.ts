import type { SubmitPayload, SubmitResponse } from "./shared.js";
import { isTrustedWebUrl } from "./api.js";
import { sanitizeServerText } from "./output.js";

export interface PublishDeps {
  confirm: (question: string) => Promise<boolean>;
  /** Interactive device sign-in; resolves null when aborted/timed out. */
  signIn: () => Promise<{ token: string; handle: string } | null>;
  /** Authenticated submit (the same /v1/submit path a normal run uses). */
  submit: (token: string, payload: SubmitPayload) => Promise<SubmitResponse>;
  openBrowser: (url: string) => void;
  log: (line: string) => void;
}

/**
 * Offer to publish a `--local` (offline) run to the public leaderboard. On
 * accept it signs the user in (device flow) and submits through the
 * authenticated path — anonymous submission is retired server-side — then opens
 * their profile; on decline nothing leaves the machine. Returns whether it
 * published. Dependency-injected so the prompt/network/browser are testable.
 */
export async function publishLocal(
  payload: SubmitPayload,
  deps: PublishDeps,
): Promise<boolean> {
  if (!(await deps.confirm("  Publish this to the public leaderboard? (You'll sign in first.)"))) {
    deps.log("  Kept local. Nothing left your machine.");
    return false;
  }
  const auth = await deps.signIn();
  if (!auth) {
    deps.log("  Sign-in didn't complete — kept local. Nothing left your machine.");
    return false;
  }
  const res = await deps.submit(auth.token, payload);
  deps.log(`  Published — you're on the board: ${sanitizeServerText(res.profileUrl)}`);
  // The profile URL comes BACK from the server. Only auto-open it when it's a real
  // https URL on our own web host (same gate the core submit path uses) — a malicious
  // or MITM'd response must never make the OS launch an arbitrary handler.
  if (isTrustedWebUrl(res.profileUrl)) {
    deps.openBrowser(res.profileUrl);
  } else {
    deps.log("  (The server returned an unexpected address, so it was not auto-opened.)");
  }
  deps.log(
    "  Manage anytime: `npx whoburnedmore private` hides you, `remove` deletes your data.",
  );
  return true;
}
