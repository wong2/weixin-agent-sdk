export type AcpBackendSpec = {
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
};

export type AcpRouterConfig = {
  /** Default backend name used when no per-conversation override exists. */
  defaultBackend: string;
  /** Available ACP backends keyed by user-facing name, e.g. "claude" or "codex". */
  backends: Record<string, AcpBackendSpec>;
  /** Optional persistent state path for per-conversation backend selection. */
  stateFile?: string;
};

export type AcpAgentOptions = AcpBackendSpec & {
  /** Optional router mode for switching backends from WeChat commands. */
  router?: AcpRouterConfig;
};
