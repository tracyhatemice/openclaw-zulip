import { normalizeAccountId } from "openclaw/plugin-sdk/core";
import type { DirectoryConfigParams } from "openclaw/plugin-sdk/directory-runtime";
import { listResolvedDirectoryEntriesFromSources } from "openclaw/plugin-sdk/directory-runtime";
import {
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
} from "./zulip/accounts.js";

function resolveZulipDirectoryConfigAccount(
  cfg: DirectoryConfigParams["cfg"],
  accountId?: string | null,
) {
  const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultZulipAccountId(cfg));
  const account = resolveZulipAccount({ cfg, accountId: resolvedAccountId });
  return {
    accountId: resolvedAccountId,
    config: account.config,
    dm: account.config.dm,
  };
}

export async function listZulipDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryEntriesFromSources({
    ...params,
    kind: "user",
    resolveAccount: (cfg, accountId) => resolveZulipDirectoryConfigAccount(cfg, accountId),
    resolveSources: (account) => {
      const allowFrom = account.dm?.allowFrom ?? [];
      return [allowFrom];
    },
    normalizeId: (raw) => {
      const cleaned = raw.trim().replace(/^(zulip|user):/i, "");
      return cleaned || null;
    },
  });
}

export async function listZulipDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryEntriesFromSources({
    ...params,
    kind: "group",
    resolveAccount: (cfg, accountId) => resolveZulipDirectoryConfigAccount(cfg, accountId),
    resolveSources: (account) => {
      const streams = account.config.streams ?? [];
      return [streams];
    },
    normalizeId: (raw) => {
      const cleaned = raw.trim().replace(/^(zulip|stream):/i, "");
      return cleaned ? `stream:${cleaned}` : null;
    },
  });
}
