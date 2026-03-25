import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema, createChannelPluginBase, type ChannelPlugin } from "openclaw/plugin-sdk/core";
import { ZulipConfigSchema } from "./config-schema.js";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
  type ResolvedZulipAccount,
} from "./zulip/accounts.js";

export const ZULIP_CHANNEL = "zulip" as const;

export const zulipConfigAdapter = createScopedChannelConfigAdapter<ResolvedZulipAccount>({
  sectionKey: ZULIP_CHANNEL,
  listAccountIds: listZulipAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveZulipAccount),
  defaultAccountId: resolveDefaultZulipAccountId,
  clearBaseFields: ["baseUrl", "email", "apiKey", "streams", "defaultTopic"],
  resolveAllowFrom: () => [],
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
});

export function createZulipPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedZulipAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedZulipAccount>["setup"]>;
}): ReturnType<typeof createChannelPluginBase<ResolvedZulipAccount>> {
  return createChannelPluginBase<ResolvedZulipAccount>({
    id: ZULIP_CHANNEL,
    meta: {
      id: "zulip",
      label: "Zulip",
      selectionLabel: "Zulip (plugin)",
      detailLabel: "Zulip Bot",
      docsPath: "/channels/zulip",
      docsLabel: "zulip",
      blurb: "Zulip streams/topics with reaction-based reply indicators; install the plugin to enable.",
      systemImage: "bubble.left.and.bubble.right",
      order: 70,
      quickstartAllowFrom: false,
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      threads: true,
      reactions: true,
      media: true,
      nativeCommands: true,
    },
    reload: { configPrefixes: ["channels.zulip"] },
    configSchema: buildChannelConfigSchema(ZulipConfigSchema),
    config: {
      ...zulipConfigAdapter,
      isConfigured: (account) => Boolean(account.baseUrl && account.email && account.apiKey),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.baseUrl && account.email && account.apiKey),
        baseUrlSource: account.baseUrlSource,
        emailSource: account.emailSource,
        apiKeySource: account.apiKeySource,
        streams: account.streams,
        alwaysReply: account.alwaysReply,
        defaultTopic: account.defaultTopic,
      }),
    },
    setup: params.setup,
  });
}
