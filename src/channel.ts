import type { ChannelPlugin } from "openclaw/plugin-sdk";
import {
  createChatChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  normalizeAccountId,
} from "openclaw/plugin-sdk/core";
import { buildLegacyDmAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  listZulipDirectoryGroupsFromConfig,
  listZulipDirectoryPeersFromConfig,
} from "./directory-config.js";
import { resolveZulipGroupRequireMention } from "./group-mentions.js";
import { getZulipRuntime } from "./runtime.js";
import { zulipSetupAdapter } from "./setup-core.js";
import { zulipSetupWizard } from "./setup-surface.js";
import { createZulipPluginBase } from "./shared.js";
import {
  listZulipAccountIds,
  resolveZulipAccount,
  type ResolvedZulipAccount,
} from "./zulip/accounts.js";
import { zulipMessageActions } from "./zulip/actions.js";
import { monitorZulipProvider } from "./zulip/monitor.js";
import { normalizeStreamName, normalizeTopic } from "./zulip/normalize.js";
import {
  sendZulipDirectMessage,
  sendZulipGroupDirectMessage,
  sendZulipStreamMessage,
} from "./zulip/send.js";
import { parseZulipTarget } from "./zulip/targets.js";
import { collectZulipStatusIssues } from "./status-issues.js";
import { resolveOutboundMedia, uploadZulipFile } from "./zulip/uploads.js";

const activeProviders = new Map<string, { stop: () => void }>();

const collectZulipSecurityWarnings =
  createOpenProviderConfiguredRouteWarningCollector<ResolvedZulipAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.zulip !== undefined,
    resolveGroupPolicy: (account) =>
      account.streamPolicy === "open" ? "open" : account.streamPolicy === "disabled" ? null : "allowlist",
    resolveRouteAllowlistConfigured: (account) => account.streams.length > 0,
    configureRouteAllowlist: {
      surface: "Zulip streams",
      openScope: "any stream the bot can access",
      groupPolicyPath: "channels.zulip.streamPolicy",
      routeAllowlistPath: "channels.zulip.streams",
    },
    missingRouteAllowlist: {
      surface: "Zulip streams",
      openBehavior: "with no stream allowlist; any stream can trigger (mention-gated)",
      remediation: "Set channels.zulip.streams to a record of stream entries to limit access",
    },
  });

const resolveZulipDmPolicy = createScopedDmSecurityResolver<ResolvedZulipAccount>({
  channelKey: "zulip",
  resolvePolicy: (account) => account.config.dm?.policy ?? "pairing",
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) => raw.trim().replace(/^(zulip|user):/i, ""),
});

const zulipPluginBase = createZulipPluginBase({
  setupWizard: zulipSetupWizard,
  setup: zulipSetupAdapter,
});

export const zulipPlugin = createChatChannelPlugin({
  base: {
    ...zulipPluginBase,
    config: zulipPluginBase.config!,
    capabilities: zulipPluginBase.capabilities!,
    defaults: {
      queue: {
        debounceMs: 250,
      },
    },
    allowlist: {
      ...buildLegacyDmAccountAllowlistAdapter({
        channelId: "zulip",
        resolveAccount: resolveZulipAccount,
        normalize: ({ cfg, accountId, values }) =>
          values.map((v) => String(v).trim()).filter(Boolean),
        resolveDmAllowFrom: (account) => account.config.dm?.allowFrom,
      }),
    },
    groups: {
      resolveRequireMention: resolveZulipGroupRequireMention,
    },
    mentions: {
      stripPatterns: () => [
        // Zulip user mentions in raw Markdown look like: @**Full Name**
        "@\\\\*\\\\*[^*]+\\\\*\\\\*",
        // Wildcard mentions.
        "\\\\B@all\\\\b",
        "\\\\B@everyone\\\\b",
        "\\\\B@stream\\\\b",
      ],
    },
    agentPrompt: {
      messageToolHints: () => [
        "- Zulip stream targets use `stream:<name>#<topic>` format. Topic is optional (defaults to account's defaultTopic).",
        "- DM targets use `user:<senderId>` format. Group DM targets use `group-dm:<id1>,<id2>` format.",
        "- Use `poll` action with `pollQuestion` and `pollOption` params to present choices via emoji reactions (Zulip has no native polls, so reactions simulate voting).",
        "- Zulip supports spoiler blocks with ` ```spoiler title\\n...\\n``` ` syntax for collapsible content.",
        "- Mention users with `@**Full Name**` syntax. Use `@**all**` or `@**everyone**` for wildcard mentions.",
        "- Use `topic-list` action to list topics in a stream."
      ],
    },
    messaging: {
      normalizeTarget: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return trimmed;
        }
        if (/^zulip:/i.test(trimmed)) {
          return trimmed.replace(/^zulip:/i, "");
        }
        return trimmed;
      },
      targetResolver: {
        looksLikeId: (raw) => /^(zulip:)?(stream:|user:|dm:|group-dm:)/i.test(raw.trim()),
        hint: "stream:<name>#<topic?> or user:<senderId>",
      },
      formatTargetDisplay: ({ target }) => target,
      inferTargetChatType: ({ to }) => {
        const trimmed = (to ?? "").trim();
        if (/^(zulip:)?(stream:|channel:)/i.test(trimmed)) return "channel";
        if (/^(zulip:)?(user:|dm:)/i.test(trimmed)) return "direct";
        if (/^(zulip:)?group-dm:/i.test(trimmed)) return "group";
        return undefined;
      },
    },
    actions: zulipMessageActions,
    bindings: {
      compileConfiguredBinding: ({ conversationId }) => {
        const normalized = conversationId.trim();
        return normalized ? { conversationId: normalized } : null;
      },
      matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => {
        if (compiledBinding.conversationId === conversationId) {
          return { conversationId, matchPriority: 2 };
        }
        if (
          parentConversationId &&
          parentConversationId !== conversationId &&
          compiledBinding.conversationId === parentConversationId
        ) {
          return { conversationId: parentConversationId, matchPriority: 1 };
        }
        return null;
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listZulipDirectoryPeersFromConfig(params),
      listGroups: async (params) => listZulipDirectoryGroupsFromConfig(params),
    }),
    resolver: {
      resolveTargets: async ({ inputs, kind }) => {
        if (kind === "group") {
          return inputs.map((input) => {
            const cleaned = input.trim().replace(/^(zulip|stream):/i, "");
            return {
              input,
              resolved: Boolean(cleaned),
              id: cleaned || undefined,
              name: cleaned || undefined,
              note: cleaned ? undefined : "invalid stream target",
            };
          });
        }
        return inputs.map((input) => {
          const cleaned = input.trim().replace(/^(zulip|user):/i, "");
          return {
            input,
            resolved: Boolean(cleaned),
            id: cleaned || undefined,
            name: cleaned || undefined,
            note: cleaned ? undefined : "invalid user target",
          };
        });
      },
    },
    status: {
      defaultRuntime: {
        accountId: DEFAULT_ACCOUNT_ID,
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      },
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot.configured ?? false,
        running: snapshot.running ?? false,
        lastStartAt: snapshot.lastStartAt ?? null,
        lastStopAt: snapshot.lastStopAt ?? null,
        lastError: snapshot.lastError ?? null,
        probe: snapshot.probe,
        lastProbeAt: snapshot.lastProbeAt ?? null,
      }),
      probeAccount: async ({ account }) => {
        if (!account.baseUrl || !account.email || !account.apiKey) {
          return { ok: false, error: "missing baseUrl/email/apiKey" };
        }
        try {
          const { zulipRequest } = await import("./zulip/client.js");
          const res = await zulipRequest({
            auth: { baseUrl: account.baseUrl, email: account.email, apiKey: account.apiKey },
            method: "GET",
            path: "/api/v1/users/me",
          });
          return { ok: true, me: res };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      buildAccountSnapshot: ({ account, runtime, probe }) => {
        const running = runtime?.running ?? false;
        const issues = collectZulipStatusIssues({ account, running });
        return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.baseUrl && account.email && account.apiKey),
        running,
        issues,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
      },
    },
    gateway: {
      startAccount: async (ctx) => {
        const accountId = normalizeAccountId(ctx.account.accountId ?? DEFAULT_ACCOUNT_ID);
        ctx.log?.info(`[${accountId}] starting zulip monitor`);
        const provider = await monitorZulipProvider({
          accountId,
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          statusSink: (patch) => {
            const current = ctx.getStatus();
            ctx.setStatus({ ...current, ...patch, accountId: current.accountId ?? ctx.accountId });
          },
        });
        activeProviders.set(accountId, provider);
        await provider.done;
      },
      stopAccount: async (ctx) => {
        const accountId = normalizeAccountId(ctx.account.accountId ?? DEFAULT_ACCOUNT_ID);
        activeProviders.get(accountId)?.stop();
        activeProviders.delete(accountId);
        ctx.log?.info(`[${accountId}] stopped zulip monitor`);
      },
    },
  },
  pairing: {
    text: {
      idLabel: "zulipUserId",
      message: "Zulip pairing",
      normalizeAllowEntry: (entry) => entry.trim().replace(/^(zulip|user):/i, ""),
      notify: async ({ cfg, accountId, id }) => {
        try {
          const account = resolveZulipAccount({ cfg, accountId });
          if (!account.baseUrl || !account.email || !account.apiKey) return;
          const auth = {
            baseUrl: account.baseUrl,
            email: account.email,
            apiKey: account.apiKey,
          };
          await sendZulipDirectMessage({
            auth,
            to: id,
            content: `Your pairing request has been approved. You can now message this bot directly.`,
          });
        } catch {
          // Best-effort DM notification; swallow errors.
        }
      },
    },
  },
  security: {
    resolveDmPolicy: resolveZulipDmPolicy,
    collectWarnings: collectZulipSecurityWarnings,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      chunker: (text, limit) => getZulipRuntime().channel.text.chunkMarkdownText(text, limit),
      chunkerMode: "markdown",
      textChunkLimit: 10_000,
      resolveTarget: ({ cfg, to, accountId }) => {
        const raw = (to ?? "").trim();
        const parsed = parseZulipTarget(raw);
        if (!parsed) {
          return {
            ok: false,
            error: new Error(
              "Delivering to Zulip requires --target stream:<name>#<topic?> or user:<senderId>.",
            ),
          };
        }
        if (parsed.kind === "dm") {
          return { ok: true, to: `user:${parsed.user}` };
        }
        if (parsed.kind === "group-dm") {
          return { ok: true, to: `group-dm:${parsed.users.join(",")}` };
        }
        const account = cfg ? resolveZulipAccount({ cfg, accountId }) : null;
        const stream = normalizeStreamName(parsed.stream);
        const topic = normalizeTopic(parsed.topic) || account?.defaultTopic || "general chat";
        if (!stream) {
          return { ok: false, error: new Error("Missing Zulip stream name") };
        }
        return { ok: true, to: `stream:${stream}#${topic}` };
      },
    },
    attachedResults: {
      channel: "zulip",
      sendText: async ({ to, text, accountId, cfg }) => {
        const account = resolveZulipAccount({ cfg, accountId });
        const parsed = parseZulipTarget(to);
        if (!parsed) {
          throw new Error(`Invalid Zulip target: ${to}`);
        }
        const auth = {
          baseUrl: account.baseUrl ?? "",
          email: account.email ?? "",
          apiKey: account.apiKey ?? "",
        };
        if (parsed.kind === "dm") {
          const result = await sendZulipDirectMessage({ auth, to: parsed.user, content: text });
          return { messageId: String(result.id ?? "unknown") };
        }
        if (parsed.kind === "group-dm") {
          const result = await sendZulipGroupDirectMessage({ auth, to: parsed.users, content: text });
          return { messageId: String(result.id ?? "unknown") };
        }
        const stream = normalizeStreamName(parsed.stream);
        const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
        const result = await (
          await import("./zulip/send.js")
        ).sendZulipStreamMessage({
          auth,
          stream,
          topic,
          content: text,
        });
        return { messageId: String(result.id ?? "unknown") };
      },
      sendMedia: async ({ to, text, mediaUrl, mediaAccess, mediaLocalRoots, mediaReadFile, accountId, cfg }) => {
        if (!mediaUrl?.trim()) {
          throw new Error("Zulip media delivery requires mediaUrl.");
        }
        const account = resolveZulipAccount({ cfg, accountId });
        const parsed = parseZulipTarget(to);
        if (!parsed) {
          throw new Error(`Invalid Zulip target: ${to}`);
        }
        const auth = {
          baseUrl: account.baseUrl ?? "",
          email: account.email ?? "",
          apiKey: account.apiKey ?? "",
        };

        const resolved = await resolveOutboundMedia({
          cfg,
          accountId: account.accountId,
          mediaUrl,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
        });
        const uploadedUrl = await uploadZulipFile({
          auth,
          buffer: resolved.buffer,
          contentType: resolved.contentType,
          filename: resolved.filename ?? "attachment",
        });

        // DM media delivery
        if (parsed.kind === "dm") {
          const content = (text ?? "").trim() ? `${(text ?? "").trim()}\n\n${uploadedUrl}` : uploadedUrl;
          const res = await sendZulipDirectMessage({ auth, to: parsed.user, content });
          return { messageId: String(res.id ?? "unknown") };
        }
        if (parsed.kind === "group-dm") {
          const content = (text ?? "").trim() ? `${(text ?? "").trim()}\n\n${uploadedUrl}` : uploadedUrl;
          const res = await sendZulipGroupDirectMessage({ auth, to: parsed.users, content });
          return { messageId: String(res.id ?? "unknown") };
        }

        // Stream media delivery
        const stream = normalizeStreamName(parsed.stream);
        const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
        if (!stream) {
          throw new Error("Missing Zulip stream name");
        }

        const caption = (text ?? "").trim();
        if (caption.length > account.textChunkLimit) {
          const chunks = getZulipRuntime().channel.text.chunkMarkdownText(
            caption,
            account.textChunkLimit,
          );
          let lastId: string | undefined;
          for (const chunk of chunks.length > 0 ? chunks : [caption]) {
            if (!chunk) {
              continue;
            }
            const res = await sendZulipStreamMessage({ auth, stream, topic, content: chunk });
            if (res.id != null) {
              lastId = String(res.id);
            }
          }
          const mediaRes = await sendZulipStreamMessage({
            auth,
            stream,
            topic,
            content: uploadedUrl,
          });
          if (mediaRes.id != null) {
            lastId = String(mediaRes.id);
          }
          return { messageId: lastId ?? "unknown" };
        } else {
          const content = caption ? `${caption}\n\n${uploadedUrl}` : uploadedUrl;
          const res = await sendZulipStreamMessage({ auth, stream, topic, content });
          return { messageId: String(res.id ?? "unknown") };
        }
      },
    },
  },
});
