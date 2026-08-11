import { z } from "zod";

export const LAUNCH_INVITE_COOKIE = "wbm_launch_invite";

export const LaunchAccessMode = z.enum(["full", "invited", "waitlisted"]);
export type LaunchAccessMode = z.infer<typeof LaunchAccessMode>;

export const LaunchStatusResponse = z.object({
  mode: LaunchAccessMode,
  launchAt: z.string().datetime(),
  now: z.string().datetime(),
  remainingSeconds: z.number().int().nonnegative(),
  live: z.boolean(),
});
export type LaunchStatusResponse = z.infer<typeof LaunchStatusResponse>;

export const LaunchRedeemRequest = z.object({
  code: z.string().trim().min(2).max(64),
});
export type LaunchRedeemRequest = z.infer<typeof LaunchRedeemRequest>;

export const LaunchRedeemResponse = z.object({
  ok: z.literal(true),
  mode: LaunchAccessMode,
  expiresAt: z.string().datetime().nullable(),
});
export type LaunchRedeemResponse = z.infer<typeof LaunchRedeemResponse>;

export function remainingSecondsUntil(launchAt: Date, now = new Date()): number {
  return Math.max(0, Math.ceil((launchAt.getTime() - now.getTime()) / 1000));
}
