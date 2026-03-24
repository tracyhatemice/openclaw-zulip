import type { ChannelPlugin } from "openclaw/plugin-sdk";
import {
  createChatChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  normalizeAccountId,
} from "openclaw/plugin-sdk/core";
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
import { sendZulipStreamMessage } from "./zulip/send.js";
import { parseZulipTarget } from "./zulip/targets.js";
import { resolveOutboundMedia, uploadZulipFile } from "./zulip/uploads.js";

const activeProviders = new Map<string, { stop: () => void }>();

export const zulipPlugin: ChannelPlugin<ResolvedZulipAccount> = createChatChannelPlugin({
  base: {
    ...createZulipPluginBase({
      setupWizard: zulipSetupWizard,
      setup: zulipSetupAdapter,
    }),
    defaults: {
      queue: {
        mode: "followup",
        debounceMs: 250,
      },
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
        looksLikeId: (raw) => /^zulip:stream:|^stream:/i.test(raw.trim()),
        hint: "stream:<streamName>#<topic?>",
      },
      formatTargetDisplay: ({ target }) => target,
    },
    actions: zulipMessageActions,
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
      buildAccountSnapshot: ({ account, runtime, probe }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.baseUrl && account.email && account.apiKey),
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      }),
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
      normalizeAllowEntry: (entry) => entry.trim(),
      notify: async () => {
        // MVP: no DMs/pairing flow yet.
      },
    },
  },
  security: {
    dm: {
      channelKey: "zulip",
      resolvePolicy: () => "disabled",
      resolveAllowFrom: () => [],
      policyPathSuffix: "dmPolicy",
      allowFromPathSuffix: "allowFrom",
      approveHint: formatPairingApproveHint("zulip"),
      normalizeEntry: (raw) => raw.trim(),
    },
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
              "Delivering to Zulip requires --target stream:<streamName>#<topic?> (topic optional).",
            ),
          };
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
        const stream = normalizeStreamName(parsed.stream);
        const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
        const auth = {
          baseUrl: account.baseUrl ?? "",
          email: account.email ?? "",
          apiKey: account.apiKey ?? "",
        };
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
      sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
        if (!mediaUrl?.trim()) {
          throw new Error("Zulip media delivery requires mediaUrl.");
        }
        const account = resolveZulipAccount({ cfg, accountId });
        const parsed = parseZulipTarget(to);
        if (!parsed) {
          throw new Error(`Invalid Zulip target: ${to}`);
        }
        const stream = normalizeStreamName(parsed.stream);
        const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
        if (!stream) {
          throw new Error("Missing Zulip stream name");
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
        });
        const uploadedUrl = await uploadZulipFile({
          auth,
          buffer: resolved.buffer,
          contentType: resolved.contentType,
          filename: resolved.filename ?? "attachment",
        });

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
