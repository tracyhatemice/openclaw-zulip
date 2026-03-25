import {
  createStandardChannelSetupStatus,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { ZULIP_URL_HELP_LINES, zulipSetupAdapter } from "./setup-core.js";
import {
  listZulipAccountIds,
  resolveZulipAccount,
} from "./zulip/accounts.js";
import { probeZulip } from "./zulip/probe.js";

const channel = "zulip" as const;

function createZulipCredential(params: {
  inputKey: "url" | "userId" | "token";
  configKey: "baseUrl" | "email" | "apiKey";
  credentialLabel: string;
  preferredEnvVar: string;
  helpTitle: string;
  helpLines: string[];
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
}) {
  return {
    inputKey: params.inputKey,
    providerHint: channel,
    credentialLabel: params.credentialLabel,
    preferredEnvVar: params.preferredEnvVar,
    helpTitle: params.helpTitle,
    helpLines: params.helpLines,
    envPrompt: params.envPrompt,
    keepPrompt: params.keepPrompt,
    inputPrompt: params.inputPrompt,
    allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
    inspect: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
      const account = resolveZulipAccount({ cfg, accountId });
      const value = account[params.configKey as keyof typeof account] as string | undefined;
      const hasValue = Boolean(value?.trim());
      return {
        accountConfigured: hasValue,
        hasConfiguredValue: hasValue,
        resolvedValue: value?.trim() || undefined,
        envValue:
          accountId === DEFAULT_ACCOUNT_ID
            ? process.env[params.preferredEnvVar]?.trim() || undefined
            : undefined,
      };
    },
    applySet: ({ cfg, accountId, value }: { cfg: OpenClawConfig; accountId: string; value: unknown }) =>
      patchChannelConfigForAccount({
        cfg,
        channel: channel as never, // External plugin — not in SDK's AccountScopedChannel union
        accountId,
        patch: { enabled: true, [params.configKey]: value },
      }),
  };
}

export const zulipSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Zulip",
    configuredLabel: "configured",
    unconfiguredLabel: "needs baseUrl + email + apiKey + streams",
    configuredHint: "configured",
    unconfiguredHint: "needs setup",
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg }) =>
      listZulipAccountIds(cfg).some((accountId) => {
        const account = resolveZulipAccount({ cfg, accountId });
        return Boolean(
          account.baseUrl && account.email && account.apiKey && account.streams.length,
        );
      }),
  }),
  introNote: {
    title: "Zulip bot credentials",
    lines: ZULIP_URL_HELP_LINES,
  },
  credentials: [
    createZulipCredential({
      inputKey: "url",
      configKey: "baseUrl",
      credentialLabel: "Zulip base URL",
      preferredEnvVar: "ZULIP_URL",
      helpTitle: "Zulip server URL",
      helpLines: ["Enter the base URL of your Zulip server (e.g. https://your-org.zulipchat.com)"],
      envPrompt: "ZULIP_URL detected. Use env var?",
      keepPrompt: "Zulip base URL already configured. Keep it?",
      inputPrompt: "Enter Zulip base URL",
    }),
    createZulipCredential({
      inputKey: "userId",
      configKey: "email",
      credentialLabel: "Zulip bot email",
      preferredEnvVar: "ZULIP_EMAIL",
      helpTitle: "Zulip bot email",
      helpLines: ["Enter the email address of your Zulip bot"],
      envPrompt: "ZULIP_EMAIL detected. Use env var?",
      keepPrompt: "Zulip bot email already configured. Keep it?",
      inputPrompt: "Enter Zulip bot email",
    }),
    createZulipCredential({
      inputKey: "token",
      configKey: "apiKey",
      credentialLabel: "Zulip bot API key",
      preferredEnvVar: "ZULIP_API_KEY",
      helpTitle: "Zulip bot API key",
      helpLines: ["Enter the API key for your Zulip bot"],
      envPrompt: "ZULIP_API_KEY detected. Use env var?",
      keepPrompt: "Zulip API key already configured. Keep it?",
      inputPrompt: "Enter Zulip bot API key",
    }),
  ],
  textInputs: [
    {
      inputKey: "groupChannels",
      message: "Streams to monitor (comma-separated, e.g. marcel-ai, general)",
      required: true,
      helpTitle: "Zulip streams",
      helpLines: ["Enter the Zulip streams you want the bot to monitor, separated by commas."],
      currentValue: ({ cfg, accountId }) => {
        const account = resolveZulipAccount({ cfg, accountId });
        return account.streams?.length
          ? account.streams.map((s) => s.streamId).join(", ")
          : undefined;
      },
      confirmCurrentValue: true,
      keepPrompt: (value) => `Streams already configured: ${value}. Keep them?`,
      validate: ({ value }) => (value?.trim() ? undefined : "At least one stream is required"),
      normalizeValue: ({ value }) => value,
      applySet: ({ cfg, accountId, value }) => {
        const streamNames = value
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        // Build Record<streamId, StreamEntryConfig> with sensible defaults
        const streams: Record<string, { streamPolicy: string; requireMention: boolean; allowFrom: string[] }> = {};
        for (const name of streamNames) {
          streams[name] = { streamPolicy: "allowlist", requireMention: true, allowFrom: ["*"] };
        }
        const channels = cfg.channels as Record<string, any> | undefined;
        const zulipSection = channels?.zulip ?? {};
        if (accountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...cfg,
            channels: { ...channels, zulip: { ...zulipSection, streams } },
          };
        }
        return {
          ...cfg,
          channels: {
            ...channels,
            zulip: {
              ...zulipSection,
              accounts: {
                ...zulipSection.accounts,
                [accountId]: {
                  ...zulipSection.accounts?.[accountId],
                  streams,
                },
              },
            },
          },
        };
      },
    },
  ],
  stepOrder: "credentials-first",
  finalize: async ({ cfg, accountId, prompter }) => {
    const account = resolveZulipAccount({ cfg, accountId });
    if (account.baseUrl && account.email && account.apiKey) {
      const probe = await probeZulip(account.baseUrl, account.email, account.apiKey, 10_000);
      if (probe.ok && probe.bot) {
        await prompter.note(
          `Connected as ${probe.bot.fullName ?? probe.bot.email ?? "bot"} (user_id: ${String(probe.bot.userId)})`,
          "\u2705 Zulip credentials verified",
        );
      } else {
        await prompter.note(
          `Could not verify credentials: ${probe.error ?? "unknown error"}.\nYou can continue, but the bot may not start.`,
          "\u26a0\ufe0f Zulip probe failed",
        );
      }
    }
  },
  disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
};
