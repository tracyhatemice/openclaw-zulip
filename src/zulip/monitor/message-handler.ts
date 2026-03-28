import type { ReplyPayload } from "openclaw/plugin-sdk";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-runtime";
import { getZulipRuntime } from "../../runtime.js";
import type { ZulipReactionWorkflowStage } from "../accounts.js";
import type { ZulipHttpError } from "../client.js";
import {
  buildZulipCheckpointId,
  clearZulipInFlightCheckpoint,
  markZulipCheckpointFailure,
  prepareZulipCheckpointForRecovery,
  type ZulipInFlightCheckpoint,
  ZULIP_INFLIGHT_CHECKPOINT_VERSION,
  writeZulipInFlightCheckpoint,
} from "../inflight-checkpoints.js";
import { normalizeStreamName, normalizeTopic } from "../normalize.js";
import {
  isZulipMessageAlreadyProcessed,
  markZulipMessageProcessed,
} from "../processed-message-state.js";
import { sendZulipDirectMessage, sendZulipGroupDirectMessage, sendZulipStreamMessage } from "../send.js";
import { resolveZulipDmAccess, resolveZulipGroupDmAccess, resolveZulipStreamAccess } from "../dm-access.js";
import { sendZulipDirectTypingStart, sendZulipDirectTypingStop } from "../typing.js";
import { formatZulipDmTarget, formatZulipGroupDmTarget } from "../targets.js";
import { ToolProgressAccumulator } from "../tool-progress.js";
import { sendZulipStreamTypingStart, sendZulipStreamTypingStop } from "../typing.js";
import { downloadZulipUploads, resolveOutboundMedia, uploadZulipFile } from "../uploads.js";
import {
  bestEffortReaction,
  createReactionTransitionController,
  withWorkflowReactionStages,
} from "./reactions.js";
import { deliverReply } from "./reply-delivery.js";
import { resolveCanonicalTopicSessionKey, safeDecodeTopicKey } from "./topic-management.js";
import {
  classifyZulipMessage,
  DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS,
  type MonitorContext,
  type PreparedZulipMessage,
  type ZulipEventMessage,
  type ZulipMessageSource,
  type ZulipTraceContext,
} from "./types.js";
import {
  buildKeepaliveMessageContent,
  buildMainRelayRunId,
  createBestEffortShutdownNoticeSender,
  isRelayRunRegistered,
  registerMainRelayRun,
  shouldIgnoreMessage,
  sleep,
  startPeriodicKeepalive,
  updateRelayRunModel,
  waitForDispatcherIdleWithTimeout,
} from "./utilities.js";

/** Strip reasoning/thinking tags from reply text as a safety net. */
function sanitizeReplyText(text: string): string {
  return stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
}

export async function sendQueuedReaction(
  ctx: MonitorContext,
  params: {
    msg: ZulipEventMessage;
    stream: string;
    topic: string;
    source: ZulipMessageSource;
    trace: ZulipTraceContext;
  },
): Promise<{
  queuedReactionStarted: boolean;
  reactionController: import("./types.js").ReactionTransitionController | null;
}> {
  const reactions = ctx.account.reactions;
  if (!reactions.enabled) {
    return { queuedReactionStarted: false, reactionController: null };
  }

  ctx.logTrace({
    milestone: "queued_reaction_start",
    source: params.source,
    messageId: params.msg.id,
    stream: params.stream,
    topic: params.topic,
  });

  if (reactions.workflow.enabled) {
    const reactionController = createReactionTransitionController({
      auth: ctx.auth,
      messageId: params.msg.id,
      reactions,
      log: (message) => ctx.logger.debug?.(message),
    });
    await reactionController.transition("queued", { abortSignal: ctx.abortSignal });
    ctx.logTrace({
      milestone: "queued_reaction_done",
      source: params.source,
      messageId: params.msg.id,
      stream: params.stream,
      topic: params.topic,
      extra: { reactionMode: "workflow" },
    });
    return { queuedReactionStarted: true, reactionController };
  }

  await bestEffortReaction({
    auth: ctx.auth,
    messageId: params.msg.id,
    op: "add",
    emojiName: reactions.onStart,
    log: (message) => ctx.logger.debug?.(message),
    abortSignal: ctx.abortSignal,
  });
  ctx.logTrace({
    milestone: "queued_reaction_done",
    source: params.source,
    messageId: params.msg.id,
    stream: params.stream,
    topic: params.topic,
    extra: { reactionMode: "classic" },
  });
  return { queuedReactionStarted: true, reactionController: null };
}

export async function prepareMessageForHandling(
  ctx: MonitorContext,
  params: {
    msg: ZulipEventMessage;
    source: ZulipMessageSource;
    recoveryCheckpoint?: ZulipInFlightCheckpoint;
  },
): Promise<PreparedZulipMessage | undefined> {
  const { msg } = params;
  if (typeof msg.id !== "number") {
    return undefined;
  }
  if (ctx.dedupe.check(String(msg.id))) {
    return undefined;
  }

  const ignore = shouldIgnoreMessage({ message: msg, botUserId: ctx.botUserId });
  if (ignore.ignore) {
    return undefined;
  }

  const classified = classifyZulipMessage(msg, ctx.botUserId);
  const isRecovery = Boolean(params.recoveryCheckpoint);
  const content = msg.content ?? "";

  // For stream messages: resolve stream/topic
  let stream = "";
  let topic = "";
  if (classified.kind === "stream") {
    stream = normalizeStreamName(typeof msg.display_recipient === "string" ? msg.display_recipient : "");
    topic = normalizeTopic(msg.subject) || ctx.account.defaultTopic;
    if (!stream) {
      return undefined;
    }
    if (
      !isRecovery &&
      isZulipMessageAlreadyProcessed({ state: ctx.processedMessageState, stream, messageId: msg.id })
    ) {
      ctx.logger.debug?.(
        `[zulip:${ctx.account.accountId}] skip already-processed message ${msg.id} (${stream}) from durable watermark`,
      );
      return undefined;
    }
  }

  if (!content.trim() && !content.includes("/user_uploads/")) {
    return undefined;
  }

  const trace: ZulipTraceContext = {
    source: params.source,
  };
  ctx.logTrace({
    milestone: "event_seen",
    source: params.source,
    messageId: msg.id,
    stream: stream || undefined,
    topic: topic || undefined,
    extra: { kind: classified.kind },
  });

  if (isRecovery) {
    ctx.logger.warn(
      `[zulip:${ctx.account.accountId}] replaying recovery checkpoint for message ${msg.id} (${stream}#${topic})`,
    );
  }

  // Only send queued reactions for stream messages (DMs don't have reactions on inbound)
  const queuedReaction =
    isRecovery || classified.kind !== "stream"
      ? { queuedReactionStarted: false, reactionController: null }
      : await sendQueuedReaction(ctx, {
            msg,
            stream,
            topic,
            source: params.source,
            trace,
          });

  return {
    msg,
    source: params.source,
    kind: classified.kind,
    stream,
    topic,
    dmRecipients: classified.dmRecipients,
    content,
    isRecovery,
    queuedReactionStarted: queuedReaction.queuedReactionStarted,
    reactionController: queuedReaction.reactionController,
    trace,
  };
}

export async function handleDmMessage(ctx: MonitorContext, prepared: PreparedZulipMessage) {
  const msg = prepared.msg;
  const content = prepared.content;
  const senderId = msg.sender_id;
  const senderName = msg.sender_full_name?.trim() || msg.sender_email?.trim() || String(senderId);
  const isDm = prepared.kind === "dm";

  // Build DM target identifiers
  const dmRecipients = (prepared.dmRecipients ?? []).filter((r) => r.id !== ctx.botUserId);
  const recipientIds = dmRecipients.map((r) => r.id);

  const to = isDm
    ? formatZulipDmTarget(senderId)
    : formatZulipGroupDmTarget(recipientIds);
  const from = `zulip:${senderId}`;
  const sessionKey = isDm
    ? `zulip:${ctx.account.accountId}:dm:${senderId}`
    : `zulip:${ctx.account.accountId}:group-dm:${recipientIds.toSorted().join(",")}`;

  // Download inbound media
  const inboundUploads = await downloadZulipUploads({
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
    auth: ctx.auth,
    content,
    abortSignal: ctx.abortSignal,
  });
  const mediaPaths = inboundUploads.map((entry) => entry.path);
  const mediaUrls = inboundUploads.map((entry) => entry.url);
  const mediaTypes = inboundUploads.map((entry) => entry.contentType ?? "");

  let cleanedContent = content;
  for (const upload of inboundUploads) {
    cleanedContent = cleanedContent.replaceAll(upload.url, upload.placeholder);
    try {
      const urlObj = new URL(upload.url);
      cleanedContent = cleanedContent.replaceAll(urlObj.pathname, upload.placeholder);
    } catch {
      // Ignore URL parse errors.
    }
  }

  if (!cleanedContent.trim() && inboundUploads.length === 0) {
    return;
  }

  const route = ctx.core.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "zulip",
    accountId: ctx.account.accountId,
    peer: { kind: "direct", id: String(senderId) },
  });

  const ctxPayload = ctx.core.channel.reply.finalizeInboundContext({
    BodyForAgent: cleanedContent,
    RawBody: cleanedContent,
    CommandBody: cleanedContent,
    From: from,
    To: to,
    SessionKey: route.sessionKey ?? sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    Provider: "zulip" as const,
    Surface: "zulip" as const,
    SenderName: senderName,
    SenderId: String(senderId),
    MessageSid: prepared.batch?.messageSidLast ?? String(msg.id),
    MessageSids: prepared.batch?.messageSids,
    MessageSidFirst: prepared.batch?.messageSidFirst,
    MessageSidLast: prepared.batch?.messageSidLast,
    OriginatingChannel: "zulip" as const,
    OriginatingTo: to,
    Timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
    MediaPath: mediaPaths[0],
    MediaUrl: mediaUrls[0],
    MediaType: mediaTypes[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    CommandAuthorized: true,
  });

  // DM typing indicator
  const dmTypingRecipients = isDm ? [senderId] : recipientIds;
  sendZulipDirectTypingStart({ auth: ctx.auth, to: dmTypingRecipients, abortSignal: ctx.abortSignal }).catch(() => undefined);
  const typingRefreshInterval = setInterval(() => {
    sendZulipDirectTypingStart({ auth: ctx.auth, to: dmTypingRecipients, abortSignal: ctx.abortSignal }).catch(() => undefined);
  }, 10_000);

  const { onModelSelected, ...prefixOptions } = createChannelReplyPipeline({
    cfg: ctx.cfg,
    agentId: route.agentId,
    channel: "zulip",
    accountId: ctx.account.accountId,
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    ctx.core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: ctx.core.channel.reply.resolveHumanDelayConfig(ctx.cfg, route.agentId),
      deliver: async (payload: ReplyPayload) => {
        if (payload.isReasoning) return;
        const text = sanitizeReplyText(payload.text ?? "");
        if (!text) return;

        const chunks = getZulipRuntime().channel.text.chunkMarkdownText(
          text,
          ctx.account.textChunkLimit,
        );
        for (const chunk of chunks.length > 0 ? chunks : [text]) {
          if (!chunk) continue;
          if (isDm) {
            await sendZulipDirectMessage({ auth: ctx.auth, to: senderId, content: chunk, abortSignal: ctx.abortSignal });
          } else {
            await sendZulipGroupDirectMessage({ auth: ctx.auth, to: recipientIds, content: chunk, abortSignal: ctx.abortSignal });
          }
        }

        // Handle media
        if (payload.mediaUrl?.trim()) {
          const resolved = await resolveOutboundMedia({ cfg: ctx.cfg, accountId: ctx.account.accountId, mediaUrl: payload.mediaUrl });
          const uploadedUrl = await uploadZulipFile({ auth: ctx.auth, buffer: resolved.buffer, contentType: resolved.contentType, filename: resolved.filename ?? "attachment" });
          if (isDm) {
            await sendZulipDirectMessage({ auth: ctx.auth, to: senderId, content: uploadedUrl, abortSignal: ctx.abortSignal });
          } else {
            await sendZulipGroupDirectMessage({ auth: ctx.auth, to: recipientIds, content: uploadedUrl, abortSignal: ctx.abortSignal });
          }
        }

        ctx.opts.statusSink?.({ lastOutboundAt: Date.now() });
        ctx.core.channel.activity.record({
          channel: "zulip",
          accountId: ctx.account.accountId,
          direction: "outbound",
          at: Date.now(),
        });
      },
      onError: (err) => {
        ctx.runtime.error?.(`zulip dm reply failed: ${String(err)}`);
      },
    });

  try {
    await ctx.core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: ctx.cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming: true,
        onModelSelected,
      },
    });
  } catch (err) {
    ctx.runtime.error?.(`zulip dm dispatch failed: ${String(err)}`);
  } finally {
    clearInterval(typingRefreshInterval);
    sendZulipDirectTypingStop({ auth: ctx.auth, to: dmTypingRecipients, abortSignal: ctx.abortSignal }).catch(() => undefined);
    markDispatchIdle?.();
  }
}

export async function handleMessage(
  ctx: MonitorContext,
  prepared: PreparedZulipMessage,
  messageOptions?: { recoveryCheckpoint?: ZulipInFlightCheckpoint },
) {
  const msg = prepared.msg;
  const stream = prepared.stream;
  const topic = prepared.topic;
  const content = prepared.content;
  const isRecovery = prepared.isRecovery;

  ctx.core.channel.activity.record({
    channel: "zulip",
    accountId: ctx.account.accountId,
    direction: "inbound",
    at: Date.now(),
  });
  ctx.opts.statusSink?.({ lastInboundAt: Date.now() });

  // --- DM/Group-DM access control ---
  if (prepared.kind === "dm" || prepared.kind === "group-dm") {
    const dmPolicyValue = ctx.account.config.dm?.policy ?? "pairing";
    const dmAllowFrom = ctx.account.config.dm?.allowFrom ?? [];
    const storeAllowFrom = await ctx.pairing.readAllowFromStore();
    const dmAccess = resolveZulipDmAccess({
      dmPolicy: dmPolicyValue,
      configuredAllowFrom: dmAllowFrom,
      storeAllowFrom,
      senderId: msg.sender_id,
    });

    if (prepared.kind === "group-dm") {
      const groupDmResult = resolveZulipGroupDmAccess({
        dmAccess,
        groupDmEnabled: ctx.account.groupDmEnabled,
      });
      if (!groupDmResult.allowed) {
        ctx.logger.debug?.(`[zulip:${ctx.account.accountId}] drop group-dm sender=${msg.sender_id}: ${groupDmResult.reason}`);
        return;
      }
    } else {
      if (dmAccess.decision === "pairing") {
        // Issue pairing challenge via SDK pairing system
        try {
          await ctx.pairing.issueChallenge({
            senderId: String(msg.sender_id),
            senderIdLine: `Zulip user ID: ${msg.sender_id}`,
            meta: { name: msg.sender_full_name?.trim() || String(msg.sender_id) },
            sendPairingReply: async (text) => {
              await sendZulipDirectMessage({
                auth: ctx.auth,
                to: msg.sender_id,
                content: text,
                abortSignal: ctx.abortSignal,
              });
            },
            onCreated: ({ code }) => {
              ctx.logger.debug?.(`[zulip:${ctx.account.accountId}] pairing challenge issued for user ${msg.sender_id}, code=${code}`);
            },
            onReplyError: (err) => {
              ctx.logger.debug?.(`[zulip:${ctx.account.accountId}] pairing reply failed: ${String(err)}`);
            },
          });
        } catch (err) {
          ctx.logger.debug?.(`[zulip:${ctx.account.accountId}] pairing challenge failed: ${String(err)}`);
        }
        return;
      }
      if (dmAccess.decision !== "allow") {
        ctx.logger.debug?.(`[zulip:${ctx.account.accountId}] drop dm sender=${msg.sender_id}: ${dmAccess.reason}`);
        return;
      }
    }

    // DM is authorized — build envelope and dispatch
    await handleDmMessage(ctx, prepared);
    return;
  }

  // --- Stream access control ---
  if (prepared.kind === "stream") {
    const streamAccess = resolveZulipStreamAccess({
      accountStreamPolicy: ctx.account.streamPolicy,
      streamEntries: ctx.account.streams,
      streamName: stream,
      senderId: msg.sender_id,
    });
    if (!streamAccess.allowed) {
      ctx.logger.debug?.(`[zulip:${ctx.account.accountId}] drop stream msg sender=${msg.sender_id} stream=${stream}: ${streamAccess.reason}`);
      return;
    }
  }

  // Per-handler delivery signal: allows reply delivery to complete even if the monitor
  // is stopping (e.g. gateway restart). Without this, in-flight HTTP calls to Zulip get
  // aborted immediately, wasting the LLM tokens already spent generating the response.
  const DELIVERY_GRACE_MS = 10_000;
  const DELIVERY_TIMEOUT_MS = 1_200_000;
  const deliveryController = new AbortController();
  const deliverySignal = deliveryController.signal;
  const deliveryTimer = setTimeout(() => {
    if (!deliveryController.signal.aborted) deliveryController.abort();
  }, DELIVERY_TIMEOUT_MS);
  const onMainAbortForDelivery = () => {
    // Give in-flight deliveries a grace period to finish before hard abort
    setTimeout(() => {
      if (!deliveryController.signal.aborted) deliveryController.abort();
    }, DELIVERY_GRACE_MS);
  };
  ctx.abortSignal.addEventListener("abort", onMainAbortForDelivery, { once: true });

  const sendShutdownNoticeOnce = createBestEffortShutdownNoticeSender({
    sendNotice: async () => {
      await sendZulipStreamMessage({
        auth: ctx.auth,
        stream,
        topic,
        content:
          "♻️ Gateway restart in progress - reconnecting now. If this turn is interrupted, please resend in a moment.",
        abortSignal: deliverySignal,
      });
    },
    log: (message) => ctx.logger.debug?.(message),
  });
  const onMainAbortShutdownNotice = () => {
    sendShutdownNoticeOnce();
  };
  ctx.abortSignal.addEventListener("abort", onMainAbortShutdownNotice, { once: true });
  if (ctx.abortSignal.aborted) {
    onMainAbortShutdownNotice();
  }

  const reactions = ctx.account.reactions;
  let reactionController = prepared.reactionController;
  if (!prepared.queuedReactionStarted) {
    const queuedReaction = await sendQueuedReaction(ctx, {
      msg,
      stream,
      topic,
      source: prepared.source,
      trace: prepared.trace,
    });
    reactionController = queuedReaction.reactionController ?? reactionController;
  }
  if (!reactionController && reactions.enabled && reactions.workflow.enabled) {
    reactionController = createReactionTransitionController({
      auth: ctx.auth,
      messageId: msg.id,
      reactions,
      log: (m) => ctx.logger.debug?.(m),
    });
  }

  // Typing indicator refresh: Zulip expires typing indicators after ~15s server-side
  let typingRefreshInterval: ReturnType<typeof setInterval> | undefined;

  // Send typing indicator while the agent processes, and refresh every 10s.
  const msgStreamId = msg.stream_id;
  if (typeof msgStreamId === "number") {
    sendZulipStreamTypingStart({ auth: ctx.auth, streamId: msgStreamId, topic, abortSignal: ctx.abortSignal }).catch(
      () => undefined,
    );
    typingRefreshInterval = setInterval(() => {
      sendZulipStreamTypingStart({ auth: ctx.auth, streamId: msgStreamId, topic, abortSignal: ctx.abortSignal }).catch(
        () => undefined,
      );
    }, 10_000);
  }

  const inboundUploads = await downloadZulipUploads({
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
    auth: ctx.auth,
    content,
    abortSignal: ctx.abortSignal,
  });
  const mediaPaths = inboundUploads.map((entry) => entry.path);
  const mediaUrls = inboundUploads.map((entry) => entry.url);
  const mediaTypes = inboundUploads.map((entry) => entry.contentType ?? "");

  // Strip downloaded upload URLs from the content so the native image loader
  // doesn't try to open raw /user_uploads/... paths as local files.
  let cleanedContent = content;
  for (const upload of inboundUploads) {
    // Replace both the full URL and any relative /user_uploads/ path variants.
    cleanedContent = cleanedContent.replaceAll(upload.url, upload.placeholder);
    try {
      const urlObj = new URL(upload.url);
      cleanedContent = cleanedContent.replaceAll(urlObj.pathname, upload.placeholder);
    } catch {
      // Ignore URL parse errors.
    }
  }

  // Now that uploads are resolved, bail if there's truly nothing to process:
  // no text content AND no media attachments.
  if (!cleanedContent.trim() && inboundUploads.length === 0) {
    return;
  }

  // Populate stream ID -> name mapping from message events as a fallback.
  if (typeof msg.stream_id === "number" && stream) {
    ctx.streamIdToName.set(msg.stream_id, stream);
  }
  // Resolve canonical stream + topic for session continuity across renames and cross-stream moves.
  const { stream: canonicalStream, topicKey: canonicalTopicKey } =
    resolveCanonicalTopicSessionKey({
      aliases: ctx.topicAliases,
      stream,
      topic,
    });
  // Embed the full stream:name#topic as the peer ID so the session key
  // matches what the SDK's fallback outbound resolver produces.  This
  // prevents a second "mirror" session from being created when the agent
  // sends replies via the message tool.
  const canonicalTopic = safeDecodeTopicKey(canonicalTopicKey);
  const route = ctx.core.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "zulip",
    accountId: ctx.account.accountId,
    peer: { kind: "channel", id: `stream:${canonicalStream}#${canonicalTopic}` },
  });
  const sessionKey = route.sessionKey;
  ctx.logTrace({
    milestone: "handler_start",
    source: prepared.source,
    messageId: msg.id,
    stream,
    topic,
    sessionKey,
  });

  const to = `stream:${stream}#${topic}`;
  const from = `zulip:channel:${stream}`;
  const senderName =
    msg.sender_full_name?.trim() || msg.sender_email?.trim() || String(msg.sender_id);

  const mentionRegexes = ctx.core.channel.mentions.buildMentionRegexes(ctx.cfg, route.agentId);
  const cleanedForMentions = content.replace(/@\*\*([^*]+)\*\*/g, "@$1");
  const wasMentioned = ctx.core.channel.mentions.matchesMentionPatterns(
    cleanedForMentions,
    mentionRegexes,
  );

  const ctxPayload = ctx.core.channel.reply.finalizeInboundContext({
    BodyForAgent: cleanedContent,
    RawBody: cleanedContent,
    CommandBody: cleanedContent,
    From: from,
    To: to,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: "channel",
    ThreadLabel: topic,
    MessageThreadId: topic,
    ConversationLabel: `${stream}#${topic}`,
    GroupSubject: stream,
    GroupChannel: `#${stream}`,
    GroupSystemPrompt: undefined,
    Provider: "zulip" as const,
    Surface: "zulip" as const,
    SenderName: senderName,
    SenderId: String(msg.sender_id),
    MessageSid: prepared.batch?.messageSidLast ?? String(msg.id),
    MessageSids: prepared.batch?.messageSids,
    MessageSidFirst: prepared.batch?.messageSidFirst,
    MessageSidLast: prepared.batch?.messageSidLast,
    WasMentioned: wasMentioned,
    OriginatingChannel: "zulip" as const,
    OriginatingTo: to,
    Timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
    MediaPath: mediaPaths[0],
    MediaUrl: mediaUrls[0],
    MediaType: mediaTypes[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    CommandAuthorized: true,
  });

  const nowMs = Date.now();
  let checkpoint: ZulipInFlightCheckpoint = messageOptions?.recoveryCheckpoint
    ? prepareZulipCheckpointForRecovery({
        checkpoint: messageOptions.recoveryCheckpoint,
        nowMs,
      })
    : {
        version: ZULIP_INFLIGHT_CHECKPOINT_VERSION,
        checkpointId: buildZulipCheckpointId({
          accountId: ctx.account.accountId,
          messageId: msg.id,
        }),
        accountId: ctx.account.accountId,
        stream,
        topic,
        messageId: msg.id,
        senderId: String(msg.sender_id),
        senderName,
        senderEmail: msg.sender_email,
        cleanedContent,
        body: cleanedContent,
        sessionKey,
        from,
        to,
        wasMentioned,
        streamId: msg.stream_id,
        timestampMs: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
        mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        retryCount: 0,
      };
  try {
    await writeZulipInFlightCheckpoint({ checkpoint });
  } catch (err) {
    ctx.runtime.error?.(`[zulip] failed to persist in-flight checkpoint: ${String(err)}`);
  }

  const mainRelayRunId = buildMainRelayRunId(ctx.account.accountId, msg.id);
  let mainRelayRegistered = false;
  let mainRelayModel = "default";

  const { onModelSelected: originalOnModelSelected, ...prefixOptions } =
    createChannelReplyPipeline({
      cfg: ctx.cfg,
      agentId: route.agentId,
      channel: "zulip",
      accountId: ctx.account.accountId,
    });
  const onModelSelected = (mCtx: { model: string; provider: string; thinkLevel: string | undefined }) => {
    originalOnModelSelected(mCtx);
    if (mCtx.model) {
      mainRelayModel = mCtx.model;
      toolProgress.setModel(mCtx.model);
      updateRelayRunModel(mainRelayRunId, mCtx.model);
    }
  };

  const isMainRelayActive = () => mainRelayRegistered && isRelayRunRegistered(mainRelayRunId);

  let successfulDeliveries = 0;
  let firstOutboundLogged = false;
  const toolProgress = new ToolProgressAccumulator({
    auth: ctx.auth,
    stream,
    topic,
    name: ctx.botDisplayName,
    abortSignal: deliverySignal,
    log: (m) => ctx.logger.debug?.(m),
  });
  const { dispatcher, replyOptions, markDispatchIdle } =
    ctx.core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: ctx.core.channel.reply.resolveHumanDelayConfig(ctx.cfg, route.agentId),
      deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
        if (payload.isReasoning) {
          // Reasoning/thinking payloads should not be delivered to Zulip.
          return;
        }
        const kind = info?.kind;
        // Batch tool result summaries into a single message that gets edited.
        // Only batch text-only tool payloads; media payloads go through normally.
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (kind === "tool" && !hasMedia && payload.text?.trim()) {
          if (isMainRelayActive()) {
            // Main relay renders structured tool calls via AgentEvent stream.
            return;
          }
          if (!firstOutboundLogged) {
            firstOutboundLogged = true;
            ctx.logTrace({
              milestone: "first_outbound",
              source: prepared.source,
              messageId: msg.id,
              stream,
              topic,
              sessionKey,
              extra: { kind: kind ?? "tool" },
            });
          }
          toolProgress.addLine(sanitizeReplyText(payload.text));
          // Count as a successful delivery since the accumulator handles send/edit.
          successfulDeliveries += 1;
          ctx.opts.statusSink?.({ lastOutboundAt: Date.now() });
          ctx.core.channel.activity.record({
            channel: "zulip",
            accountId: ctx.account.accountId,
            direction: "outbound",
            at: Date.now(),
          });
          return;
        }

        // Finalize the accumulated tool progress before sending non-tool replies,
        // so the batched tool message appears above the block/final reply.
        if (kind !== "tool" && toolProgress.hasContent) {
          await toolProgress.finalize();
        }

        if (!firstOutboundLogged) {
          firstOutboundLogged = true;
          ctx.logTrace({
            milestone: "first_outbound",
            source: prepared.source,
            messageId: msg.id,
            stream,
            topic,
            sessionKey,
            extra: { kind: kind ?? "reply" },
          });
        }

        // Use deliverySignal (not abortSignal) so in-flight replies survive
        // monitor shutdown with a grace period instead of being killed instantly.
        await deliverReply({
          account: ctx.account,
          auth: ctx.auth,
          stream,
          topic,
          payload,
          cfg: ctx.cfg,
          abortSignal: deliverySignal,
        });
        successfulDeliveries += 1;
        ctx.opts.statusSink?.({ lastOutboundAt: Date.now() });
        ctx.core.channel.activity.record({
          channel: "zulip",
          accountId: ctx.account.accountId,
          direction: "outbound",
          at: Date.now(),
        });
      },
      onError: (err) => {
        ctx.runtime.error?.(`zulip reply failed: ${String(err)}`);
      },
    });
  const dispatchDriver = reactionController
    ? withWorkflowReactionStages(dispatcher, reactions, reactionController, ctx.abortSignal)
    : dispatcher;

  const stopKeepalive = startPeriodicKeepalive({
    sendPing: async (elapsedMs) => {
      if (isMainRelayActive()) {
        return;
      }
      // If tool progress has an active batched message, update it with
      // a heartbeat instead of sending a separate keepalive message.
      if (toolProgress.hasContent) {
        toolProgress.addHeartbeat(elapsedMs);
        return;
      }
      await sendZulipStreamMessage({
        auth: ctx.auth,
        stream,
        topic,
        content: buildKeepaliveMessageContent(elapsedMs),
        abortSignal: deliverySignal,
      });
    },
  });

  mainRelayRegistered =
    registerMainRelayRun({
      runId: mainRelayRunId,
      label: ctx.botDisplayName,
      model: mainRelayModel,
      deliveryContext: {
        channel: "zulip",
        to,
        accountId: ctx.account.accountId,
      },
    }) || mainRelayRegistered;

  let ok = false;
  let lastDispatchError: unknown;
  const MAX_DISPATCH_RETRIES = 2;
  try {
    for (let attempt = 0; attempt <= MAX_DISPATCH_RETRIES; attempt++) {
      try {
        if (reactionController) {
          await reactionController.transition("processing", { abortSignal: ctx.abortSignal });
        }
        ctx.logTrace({
          milestone: "dispatch_start",
          source: prepared.source,
          messageId: msg.id,
          stream,
          topic,
          sessionKey,
          extra: { attempt: attempt + 1 },
        });
        await ctx.core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg: ctx.cfg,
          dispatcher: dispatchDriver,
          replyOptions: {
            ...replyOptions,
            runId: mainRelayRunId,
            disableBlockStreaming: true,
            onModelSelected,
            onAgentRunStart: (runId: string) => {
              const registered = registerMainRelayRun({
                runId,
                label: ctx.botDisplayName,
                model: mainRelayModel,
                deliveryContext: {
                  channel: "zulip",
                  to,
                  accountId: ctx.account.accountId,
                },
              });
              mainRelayRegistered = registered || mainRelayRegistered;
            },
          },
        });
        ok = true;
        lastDispatchError = undefined;
        ctx.logTrace({
          milestone: "dispatch_done",
          source: prepared.source,
          messageId: msg.id,
          stream,
          topic,
          sessionKey,
          extra: { ok: true, attempt: attempt + 1 },
        });
        break;
      } catch (err) {
        ok = false;
        lastDispatchError = err;
        const isRetryable =
          attempt < MAX_DISPATCH_RETRIES &&
          !(err instanceof Error && err.name === "AbortError");
        if (isRetryable) {
          if (reactionController) {
            await reactionController.transition("retrying", { abortSignal: ctx.abortSignal });
          }
          ctx.runtime.error?.(
            `zulip dispatch failed (attempt ${attempt + 1}/${MAX_DISPATCH_RETRIES + 1}, retrying in 2s): ${String(err)}`,
          );
          await sleep(2000, ctx.abortSignal).catch(() => undefined);
          continue;
        }
        ctx.opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
        ctx.runtime.error?.(`zulip dispatch failed: ${String(err)}`);
        ctx.logTrace({
          milestone: "dispatch_done",
          source: prepared.source,
          messageId: msg.id,
          stream,
          topic,
          sessionKey,
          extra: { ok: false, attempt: attempt + 1 },
        });
      }
    }
  } finally {
    // Ensure all queued outbound sends are flushed before cleanup.
    dispatcher.markComplete();
    try {
      await waitForDispatcherIdleWithTimeout({
        waitForIdle: () => dispatcher.waitForIdle(),
        timeoutMs: DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS,
        onTimeout: () => {
          ctx.logger.warn(
            `[zulip] dispatcher.waitForIdle timed out after ${DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS}ms; continuing cleanup`,
          );
        },
      });
    } finally {
      markDispatchIdle();
      // Finalize any remaining tool progress (best-effort final edit).
      // Use finalizeWithError() on failure so the header shows ❌ instead of ✅.
      const finalizePromise = ok ? toolProgress.finalize() : toolProgress.finalizeWithError();
      await finalizePromise.catch((err) => {
        ctx.logger.debug?.(`[zulip] tool progress finalize failed: ${String(err)}`);
      });
      // Clean up periodic keepalive timers.
      stopKeepalive();
      // Clean up typing refresh interval (before stopTypingIndicator)
      clearInterval(typingRefreshInterval);
      // Clean up delivery abort controller listener/timer (do not hard-abort here).
      clearTimeout(deliveryTimer);
      ctx.abortSignal.removeEventListener("abort", onMainAbortForDelivery);
      ctx.abortSignal.removeEventListener("abort", onMainAbortShutdownNotice);

      // Stop typing indicator now that the reply has been sent.
      if (typeof msg.stream_id === "number") {
        sendZulipStreamTypingStop({
          auth: ctx.auth,
          streamId: msg.stream_id,
          topic,
          abortSignal: deliverySignal,
        }).catch(() => undefined);
      }

      // Visible failure message: post an actual user-visible message when dispatch fails
      if (ok === false) {
        try {
          await sendZulipStreamMessage({
            auth: ctx.auth,
            stream,
            topic,
            content:
              "⚠️ I ran into an error processing your message — please try again. (Error has been logged)",
            abortSignal: deliverySignal,
          });
        } catch {
          // Best effort — if this fails, at least the reaction emoji will show the failure
        }
      }

      // Use deliverySignal for final reactions so they can still be posted
      // during graceful shutdown (the grace period covers these too).
      if (reactions.enabled) {
        if (reactionController) {
          const finalStage: ZulipReactionWorkflowStage = ok
            ? "success"
            : successfulDeliveries > 0
              ? "partialSuccess"
              : "failure";
          await reactionController.transition(finalStage, {
            abortSignal: deliverySignal,
            force: true,
          });
        } else {
          if (reactions.clearOnFinish) {
            await bestEffortReaction({
              auth: ctx.auth,
              messageId: msg.id,
              op: "remove",
              emojiName: reactions.onStart,
              log: (m) => ctx.logger.debug?.(m),
              abortSignal: deliverySignal,
            });
          }
          const finalEmoji = ok ? reactions.onSuccess : reactions.onFailure;
          await bestEffortReaction({
            auth: ctx.auth,
            messageId: msg.id,
            op: "add",
            emojiName: finalEmoji,
            log: (m) => ctx.logger.debug?.(m),
            abortSignal: deliverySignal,
          });
        }
      }

      try {
        if (ok) {
          await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId });

          const markedProcessed = markZulipMessageProcessed({
            state: ctx.processedMessageState,
            stream,
            messageId: msg.id,
          });
          if (markedProcessed.updated) {
            ctx.processedMessageState = markedProcessed.state;
            await ctx.persistProcessedMessageState();
          }
        } else {
          checkpoint = markZulipCheckpointFailure({
            checkpoint,
            error: lastDispatchError ?? "dispatch failed",
          });
          await writeZulipInFlightCheckpoint({ checkpoint });
        }
      } catch (err) {
        ctx.runtime.error?.(`[zulip] failed to update in-flight checkpoint: ${String(err)}`);
      }
      ctx.logTrace({
        milestone: "cleanup_done",
        source: prepared.source,
        messageId: msg.id,
        stream,
        topic,
        sessionKey,
        extra: { ok, successfulDeliveries },
      });
    }
  }
}
