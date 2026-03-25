import type { ResolvedZulipAccount } from "./zulip/accounts.js";

export type ZulipStatusIssue = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
};

export function collectZulipStatusIssues(params: {
  account: ResolvedZulipAccount;
  running: boolean;
}): ZulipStatusIssue[] {
  const { account, running } = params;
  const issues: ZulipStatusIssue[] = [];

  if (!account.baseUrl) {
    issues.push({
      severity: "error",
      code: "missing_base_url",
      message: "Zulip base URL is not configured. Set ZULIP_URL or channels.zulip.baseUrl.",
    });
  }
  if (!account.email) {
    issues.push({
      severity: "error",
      code: "missing_email",
      message: "Zulip bot email is not configured. Set ZULIP_EMAIL or channels.zulip.email.",
    });
  }
  if (!account.apiKey) {
    issues.push({
      severity: "error",
      code: "missing_api_key",
      message: "Zulip API key is not configured. Set ZULIP_API_KEY or channels.zulip.apiKey.",
    });
  }
  if (account.streams.length === 0 && running) {
    issues.push({
      severity: "warning",
      code: "no_streams",
      message:
        "No streams configured in allowlist. The bot will not monitor any streams. Set channels.zulip.streams.",
    });
  }
  if (account.config.dm?.policy === "open" && !account.config.dm?.allowFrom?.length) {
    issues.push({
      severity: "info",
      code: "dm_open_no_allowlist",
      message:
        "DM policy is 'open' without an allowFrom list. Any Zulip user can DM the bot.",
    });
  }

  return issues;
}
