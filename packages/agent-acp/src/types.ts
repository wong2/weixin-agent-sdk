/**
 * Strategy for handling ACP permission requests.
 *
 * - `"reject"` — reject every request (safest default).
 * - `"allow-once"` — auto-approve with "allow_once" if available, reject otherwise.
 * - `(options) => outcome` — custom callback; receives the raw `PermissionOption[]`
 *   and must return the chosen `optionId` or `null` to cancel.
 */
export type PermissionPolicy =
  | "reject"
  | "allow-once"
  | ((
      options: ReadonlyArray<{ id: string; kind: string; name: string }>,
    ) => string | null);

export type AcpAgentOptions = {
  /** Command to launch the ACP agent, e.g. "npx" */
  command: string;
  /** Command arguments, e.g. ["@zed-industries/codex-acp"] */
  args?: string[];
  /** Extra environment variables for the subprocess */
  env?: Record<string, string>;
  /** Working directory for the subprocess and ACP sessions */
  cwd?: string;
  /** Prompt timeout in milliseconds (default: 120_000) */
  promptTimeoutMs?: number;
  /**
   * How to handle ACP permission requests.
   *
   * Defaults to `"reject"` — the safest choice for an unattended WeChat bot.
   * Set to `"allow-once"` for development/testing convenience.
   */
  permissionPolicy?: PermissionPolicy;
};
