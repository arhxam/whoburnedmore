/** Public-facing product name. Compatibility identifiers stay separate. */
export const PUBLIC_PRODUCT_NAME = "whoburnedmore";

/** Installed npm executable retained for existing scripts and documentation. */
export const LEGACY_COMMAND = "whoburnedmore";

export function cliInvocation(args?: string): string {
  return `npx ${LEGACY_COMMAND}${args ? ` ${args}` : ""}`;
}
