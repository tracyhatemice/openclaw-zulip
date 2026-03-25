import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import { resolveZulipAccount } from "./zulip/accounts.js";

/**
 * Resolve whether Zulip streams require an @mention to trigger a response.
 * Reads `requireMention` from the account config (default: true).
 */
export function resolveZulipGroupRequireMention(params: ChannelGroupContext): boolean | undefined {
  const account = resolveZulipAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return account.requireMention;
}
