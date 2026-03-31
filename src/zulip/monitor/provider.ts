import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { createChannelInboundDebouncer, shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { getZulipRuntime } from "../../runtime.js";
import { resolveZulipAccount } from "../accounts.js";
import type { ZulipHttpError } from "../client.js";
import { zulipRequest } from "../client.js";
import { createDedupeCache } from "../dedupe.js";
import {
  clearZulipInFlightCheckpoint,
  isZulipCheckpointStale,
  loadZulipInFlightCheckpoints,
  markZulipCheckpointFailure,
  ZULIP_INFLIGHT_MAX_RETRY_COUNT,
  writeZulipInFlightCheckpoint,
} from "../inflight-checkpoints.js";
import { normalizeStreamName, normalizeTopic } from "../normalize.js";
import { loadZulipProcessedMessageState, writeZulipProcessedMessageState } from "../processed-message-state.js";
import { buildZulipQueuePlan } from "../queue-plan.js";
import {
  getReactionButtonSession,
  handleReactionEvent,
  startReactionButtonSessionCleanup,
  stopReactionButtonSessionCleanup,
} from "../reaction-buttons.js";
import { sendZulipStreamMessage } from "../send.js";
import { fetchZulipMe, fetchZulipSubscriptions, pollEvents, registerQueue } from "./api.js";
import { handleMessage, prepareMessageForHandling } from "./message-handler.js";
import { parseTopicRenameEvent, TopicRenameTracker, safeDecodeTopicKey } from "./topic-management.js";
import {
  type MonitorContext,
  type MonitorZulipOptions,
  type ZulipEventMessage,
  type ZulipReactionEvent,
  ZULIP_RECOVERY_NOTICE,
} from "./types.js";
import {
  buildAuth,
  buildZulipTraceLog,
  computeZulipMonitorBackoffMs,
  extractZulipHttpStatus,
  shouldIgnoreMessage,
  sleep,
} from "./utilities.js";

export async function monitorZulipProvider(
  opts: MonitorZulipOptions,
): Promise<{ stop: () => void; done: Promise<void> }> {
  const core = getZulipRuntime();
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveZulipAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args: unknown[]) => core.logging.getChildLogger().info(String(args[0])),
    error: (...args: unknown[]) => core.logging.getChildLogger().error(String(args[0])),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  const logger = core.logging.getChildLogger({ channel: "zulip", accountId: account.accountId });

  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error(`Zulip credentials missing for account "${account.accountId}"`);
  }
  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const dmEnabled = dmPolicy !== "disabled";
  if (!account.streams.length && !dmEnabled && !account.groupDmEnabled) {
    throw new Error(
      `Zulip account "${account.accountId}" has no streams configured and DMs are disabled`,
    );
  }

  const pairing = createChannelPairingController({
    core,
    channel: "zulip",
    accountId: account.accountId,
  });

  const auth = buildAuth(account);
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  let stopped = false;
  const stop = () => {
    stopped = true;
    abortController.abort();
  };
  opts.abortSignal?.addEventListener("abort", stop, { once: true });

  const run = async () => {
    // Start reaction button session cleanup
    startReactionButtonSessionCleanup();

    const me = await fetchZulipMe(auth, abortSignal);
    if (me.result !== "success" || typeof me.user_id !== "number") {
      throw new Error(me.msg || "Failed to fetch Zulip bot identity");
    }
    const botUserId = me.user_id;
    const botDisplayName = me.full_name?.trim() || "Agent";
    logger.warn(`[zulip-debug][${account.accountId}] bot user_id=${botUserId}`);

    // Dedupe cache prevents reprocessing messages after queue re-registration or reconnect.
    const dedupe = createDedupeCache({ ttlMs: 5 * 60 * 1000, maxSize: 500 });

    // Durable message watermark state prevents duplicate processing across restarts.
    let processedMessageState = await loadZulipProcessedMessageState({
      accountId: account.accountId,
    });
    let processedMessageWriteChain: Promise<void> = Promise.resolve();
    const persistProcessedMessageState = () => {
      processedMessageWriteChain = processedMessageWriteChain
        .catch(() => undefined)
        .then(async () => {
          await writeZulipProcessedMessageState({ state: ctx.processedMessageState });
        })
        .catch((err) => {
          runtime.error?.(
            `[zulip:${account.accountId}] failed to persist processed-message state: ${String(err)}`,
          );
        });
      return processedMessageWriteChain;
    };

    const topicTracker = new TopicRenameTracker();
    // Stream ID -> stream name mapping for resolving cross-stream move events.
    const streamIdToName = await fetchZulipSubscriptions(auth, abortSignal);

    const logTrace = (params: {
      milestone: string;
      messageId?: number;
      stream?: string;
      topic?: string;
      sessionKey?: string;
      source?: import("./types.js").ZulipMessageSource;
      extra?: Record<string, boolean | number | string | undefined>;
    }) => {
      logger.debug?.(
        buildZulipTraceLog({
          accountId: account.accountId,
          ...params,
        }),
      );
    };

    // Build the MonitorContext object
    const ctx: MonitorContext = {
      core,
      cfg,
      account,
      runtime,
      auth,
      botUserId,
      botDisplayName,
      abortSignal,
      pairing,
      opts,
      logger,
      dedupe,
      get processedMessageState() {
        return processedMessageState;
      },
      set processedMessageState(value) {
        processedMessageState = value;
      },
      get processedMessageWriteChain() {
        return processedMessageWriteChain;
      },
      set processedMessageWriteChain(value) {
        processedMessageWriteChain = value;
      },
      topicTracker,
      streamIdToName,
      reactionMessageContexts: new Map(),
      logTrace,
      persistProcessedMessageState,
    };

    const resumedCheckpointIds = new Set<string>();

    const REACTION_MESSAGE_CONTEXT_TTL_MS = 30 * 60 * 1000;
    const REACTION_MESSAGE_CONTEXT_MAX = 1_000;

    const normalizeReactionSourceFromMessage = (message?: ZulipEventMessage) => {
      if (!message) {
        return null;
      }
      if (message.type && message.type !== "stream") {
        return null;
      }
      const stream = normalizeStreamName(
        typeof message.display_recipient === "string" ? message.display_recipient : "",
      );
      const topic = normalizeTopic(message.subject) || account.defaultTopic;
      if (!stream || !topic) {
        return null;
      }
      return { stream, topic };
    };

    const rememberReactionMessageContext = (message: ZulipEventMessage) => {
      if (typeof message.id !== "number") {
        return;
      }
      const source = normalizeReactionSourceFromMessage(message);
      if (!source) {
        return;
      }
      ctx.reactionMessageContexts.set(message.id, {
        ...source,
        capturedAt: Date.now(),
      });
      if (ctx.reactionMessageContexts.size > REACTION_MESSAGE_CONTEXT_MAX) {
        for (const [messageId] of ctx.reactionMessageContexts) {
          ctx.reactionMessageContexts.delete(messageId);
          if (ctx.reactionMessageContexts.size <= REACTION_MESSAGE_CONTEXT_MAX) {
            break;
          }
        }
      }
    };

    const resolveReactionSource = (reactionEvent: ZulipReactionEvent) => {
      const fromEvent = normalizeReactionSourceFromMessage(reactionEvent.message);
      if (fromEvent) {
        ctx.reactionMessageContexts.set(reactionEvent.message_id, {
          ...fromEvent,
          capturedAt: Date.now(),
        });
        return fromEvent;
      }

      const cached = ctx.reactionMessageContexts.get(reactionEvent.message_id);
      if (!cached) {
        return null;
      }
      if (Date.now() - cached.capturedAt > REACTION_MESSAGE_CONTEXT_TTL_MS) {
        ctx.reactionMessageContexts.delete(reactionEvent.message_id);
        return null;
      }
      return { stream: cached.stream, topic: cached.topic };
    };

    const resolveReactionSessionKey = (source: { stream: string; topic: string }) => {
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
        peer: { kind: "channel", id: `stream:${source.stream}#${source.topic}` },
      });
      return route.sessionKey;
    };

    // Handler for reaction events (reaction buttons + optional generic callbacks).
    // Uses lightweight system events (Discord-style) instead of full synthetic agent turns.
    const handleReaction = (reactionEvent: ZulipReactionEvent) => {
      if (typeof reactionEvent.message_id !== "number") {
        return;
      }

      const result =
        reactionEvent.op === "add"
          ? handleReactionEvent({
              messageId: reactionEvent.message_id,
              emojiName: reactionEvent.emoji_name,
              userId: reactionEvent.user_id,
              botUserId,
            })
          : null;

      if (result) {
        logger.info(
          `[zulip:${account.accountId}] reaction button clicked: messageId=${result.messageId}, index=${result.selectedIndex}, value=${result.selectedOption?.value}`,
        );

        core.channel.activity.record({
          channel: "zulip",
          accountId: account.accountId,
          direction: "inbound",
          at: Date.now(),
        });

        const buttonSession = getReactionButtonSession(result.messageId);
        const source = buttonSession
          ? { stream: buttonSession.stream, topic: buttonSession.topic }
          : resolveReactionSource(reactionEvent);

        if (!source?.stream || !source.topic) {
          logger.debug?.(
            `[zulip:${account.accountId}] reaction button ignored: unresolved source for message ${result.messageId}`,
          );
          return;
        }

        const userName = reactionEvent.user?.full_name ?? String(reactionEvent.user_id);
        const text = `Zulip reaction button click: messageId=${result.messageId}, option="${result.selectedOption?.label}" (${result.selectedOption?.value}), user=${userName}`;
        const contextKey = `zulip:reaction:button:${result.messageId}:${reactionEvent.user_id}`;

        core.system.enqueueSystemEvent(text, {
          sessionKey: resolveReactionSessionKey(source),
          contextKey,
        });
        return;
      }

      if (!account.reactions.genericCallback.enabled) {
        return;
      }
      if (reactionEvent.user_id === botUserId) {
        return;
      }
      if (reactionEvent.op === "remove" && !account.reactions.genericCallback.includeRemoveOps) {
        return;
      }

      const source = resolveReactionSource(reactionEvent);
      if (!source?.stream || !source.topic) {
        logger.debug?.(
          `[zulip:${account.accountId}] generic reaction ignored: unresolved source for message ${reactionEvent.message_id}`,
        );
        return;
      }

      if (account.streams.length > 0 && !account.streams.some((s) => s.streamId.toLowerCase() === source.stream.toLowerCase())) {
        return;
      }

      core.channel.activity.record({
        channel: "zulip",
        accountId: account.accountId,
        direction: "inbound",
        at: Date.now(),
      });

      const userName = reactionEvent.user?.full_name ?? String(reactionEvent.user_id);
      const text = `Zulip reaction ${reactionEvent.op}: emoji="${reactionEvent.emoji_name}" by ${userName} on messageId=${reactionEvent.message_id}`;
      const contextKey = `zulip:reaction:${reactionEvent.op}:${reactionEvent.message_id}:${reactionEvent.user_id}:${reactionEvent.emoji_name}`;

      core.system.enqueueSystemEvent(text, {
        sessionKey: resolveReactionSessionKey(source),
        contextKey,
      });
    };

    const replayPendingCheckpoints = async () => {
      const checkpoints = await loadZulipInFlightCheckpoints({ accountId: account.accountId });
      for (const checkpoint of checkpoints) {
        if (resumedCheckpointIds.has(checkpoint.checkpointId)) {
          continue;
        }
        resumedCheckpointIds.add(checkpoint.checkpointId);

        if (checkpoint.retryCount >= ZULIP_INFLIGHT_MAX_RETRY_COUNT) {
          logger.warn(
            `[zulip:${account.accountId}] dropping exhausted in-flight checkpoint ${checkpoint.checkpointId} (retryCount=${checkpoint.retryCount})`,
          );
          await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId }).catch(
            () => undefined,
          );
          continue;
        }

        if (isZulipCheckpointStale({ checkpoint })) {
          logger.warn(
            `[zulip:${account.accountId}] skipping stale in-flight checkpoint ${checkpoint.checkpointId}`,
          );
          await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId }).catch(
            () => undefined,
          );
          continue;
        }

        // Resolve the current topic name in case it was renamed after the checkpoint was persisted.
        const { stream: cpCanonicalStream, topicKey: cpCanonicalTopicKey } =
          topicTracker.resolveCanonicalSessionKey(checkpoint.stream, checkpoint.topic);
        const cpCurrent = topicTracker.resolveCurrentTarget(cpCanonicalStream, cpCanonicalTopicKey);
        const recoveryStream = cpCurrent?.stream ?? checkpoint.stream;
        const recoveryTopic = cpCurrent?.topic ?? checkpoint.topic;

        await sendZulipStreamMessage({
          auth,
          stream: recoveryStream,
          topic: recoveryTopic,
          content: ZULIP_RECOVERY_NOTICE,
          abortSignal,
        }).catch((err) => {
          logger.warn(
            `[zulip:${account.accountId}] failed to send recovery notice for ${checkpoint.checkpointId}: ${String(err)}`,
          );
        });

        const syntheticMessage: ZulipEventMessage = {
          id: checkpoint.messageId,
          type: "stream",
          sender_id: Number(checkpoint.senderId) || 0,
          sender_full_name: checkpoint.senderName,
          sender_email: checkpoint.senderEmail,
          display_recipient: recoveryStream,
          stream_id: checkpoint.streamId,
          subject: recoveryTopic,
          content: checkpoint.cleanedContent,
          timestamp:
            typeof checkpoint.timestampMs === "number"
              ? Math.floor(checkpoint.timestampMs / 1000)
              : undefined,
        };

        try {
          const prepared = await prepareMessageForHandling(ctx, {
            msg: syntheticMessage,
            source: "recovery",
            recoveryCheckpoint: checkpoint,
          });
          if (!prepared) {
            continue;
          }
          await handleMessage(ctx, prepared, { recoveryCheckpoint: checkpoint });
        } catch (err) {
          runtime.error?.(
            `[zulip:${account.accountId}] recovery replay failed for ${checkpoint.checkpointId}: ${String(err)}`,
          );
          const failedCheckpoint = markZulipCheckpointFailure({ checkpoint, error: err });
          await writeZulipInFlightCheckpoint({ checkpoint: failedCheckpoint }).catch(
            () => undefined,
          );
        }
      }
    };

    const pollStreamQueue = async (stream: string) => {
      let queueId = "";
      let lastEventId = -1;
      let retry = 0;
      let stage: "register" | "poll" | "handle" = "register";

      // Per-session keyed queue: messages for the same session key are serialized
      // (strict FIFO), while different sessions run in parallel.
      const inboundQueue = new KeyedAsyncQueue();

      const queueMessage = async (
        msg: ZulipEventMessage,
        source: import("./types.js").ZulipMessageSource,
        batch?: { messageSids: string[]; messageSidFirst: string; messageSidLast: string },
      ) => {
        const prepared = await prepareMessageForHandling(ctx, { msg, source });
        if (!prepared) return;

        if (batch) {
          prepared.batch = batch;
        }

        // Resolve the session key for queue routing — same canonical-topic logic
        // the handler itself uses, so messages in the same topic serialize.
        const { topicKey: canonicalTopicKey, stream: canonicalStream } =
          topicTracker.resolveCanonicalSessionKey(prepared.stream, prepared.topic);
        const canonicalTopic = safeDecodeTopicKey(canonicalTopicKey);
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "zulip",
          accountId: account.accountId,
          peer: { kind: "channel", id: `stream:${canonicalStream}#${canonicalTopic}` },
        });
        const queueKey = prepared.kind === "stream"
          ? route.sessionKey
          : `dm:${msg.sender_id}`;

        void inboundQueue.enqueue(queueKey, async () => {
          await handleMessage(ctx, prepared);
        }).catch((err) => {
          runtime.error?.(`zulip: message processing failed: ${String(err)}`);
        });
      };

      // Debouncer: batches rapid-fire messages from the same author in the same
      // topic into a single combined message, reducing agent turns.
      const isDmQueue = stream === "__dm__";
      const { debouncer } = createChannelInboundDebouncer<{
        msg: ZulipEventMessage;
        source: import("./types.js").ZulipMessageSource;
      }>({
        cfg,
        channel: "zulip",
        buildKey: (entry) => {
          if (isDmQueue) {
            return `zulip:${account.accountId}:dm:${entry.msg.sender_id}`;
          }
          const s = normalizeStreamName(
            typeof entry.msg.display_recipient === "string" ? entry.msg.display_recipient : "",
          );
          const t = normalizeTopic(entry.msg.subject) || account.defaultTopic;
          if (!s) return null;
          return `zulip:${account.accountId}:${s}:${t}:${entry.msg.sender_id}`;
        },
        shouldDebounce: (entry) =>
          shouldDebounceTextInbound({
            text: entry.msg.content ?? "",
            cfg,
            hasMedia: (entry.msg.content ?? "").includes("/user_uploads/"),
          }),
        onFlush: async (entries) => {
          if (entries.length === 1) {
            await queueMessage(entries[0].msg, entries[0].source);
            return;
          }
          // Combine rapid-fire messages into a synthetic batch.
          const last = entries[entries.length - 1];
          const combinedContent = entries.map((e) => e.msg.content ?? "").join("\n");
          const syntheticMsg: ZulipEventMessage = {
            ...last.msg,
            content: combinedContent,
          };
          await queueMessage(syntheticMsg, last.source, {
            messageSids: entries.map((e) => String(e.msg.id)),
            messageSidFirst: String(entries[0].msg.id),
            messageSidLast: String(last.msg.id),
          });
        },
        onError: (err) => {
          runtime.error?.(`zulip: debounce flush failed: ${String(err)}`);
        },
      });

      // Freshness checker: periodically verify we haven't missed messages during
      // long-poll gaps, queue re-registrations, or silent connection drops.
      // Fetches the 5 most recent messages via REST and processes any with IDs
      // higher than the last one we saw through the event queue.
      let lastSeenMsgId = 0;
      const FRESHNESS_INTERVAL_MS = 30_000;
      const freshnessTimer = setInterval(async () => {
        if (stopped || abortSignal.aborted || lastSeenMsgId === 0) return;
        try {
          const recent = await zulipRequest<{ result: string; messages?: ZulipEventMessage[] }>({
            auth,
            method: "GET",
            path: "/api/v1/messages",
            query: {
              anchor: "newest",
              num_before: 5,
              num_after: 0,
              narrow: JSON.stringify([["stream", stream]]),
              apply_markdown: "false",
            },
            abortSignal,
          });
          if (recent.result === "success" && recent.messages) {
            let caught = 0;
            for (const msg of recent.messages) {
              if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
                caught++;
                lastSeenMsgId = msg.id;
                debouncer.enqueue({ msg, source: "freshness" });
              }
            }
            if (caught > 0) {
              logger.warn(
                `[zulip:${account.accountId}] freshness checker recovered ${caught} missed message(s) in stream "${stream}"`,
              );
            }
          }
        } catch {
          // Best effort — freshness check is non-critical.
        }
      }, FRESHNESS_INTERVAL_MS);

      while (!stopped && !abortSignal.aborted) {
        try {
          if (!queueId) {
            stage = "register";
            const wasReregistration = lastEventId !== -1;
            const isDmQueue = stream === "__dm__";
            const reg = await registerQueue({ auth, stream, isDmQueue, abortSignal });
            queueId = reg.queueId;
            lastEventId = reg.lastEventId;

            // Issue 5: recover messages lost during queue gap on re-registration.
            if (wasReregistration) {
              try {
                const recent = await zulipRequest<{
                  result: string;
                  messages?: ZulipEventMessage[];
                }>({
                  auth,
                  method: "GET",
                  path: "/api/v1/messages",
                  query: {
                    anchor: "newest",
                    num_before: 10,
                    num_after: 0,
                    narrow: isDmQueue ? JSON.stringify([["is", "dm"]]) : JSON.stringify([["stream", stream]]),
                    apply_markdown: "false",
                  },
                  abortSignal,
                });
                if (recent.result === "success" && recent.messages) {
                  for (const msg of recent.messages) {
                    // Track highest ID for freshness checker.
                    if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
                      lastSeenMsgId = msg.id;
                    }
                    // dedupe.check skips already-processed messages
                    debouncer.enqueue({ msg, source: "catchup" });
                  }
                }
              } catch (catchupErr) {
                logger.debug?.(
                  `[zulip:${account.accountId}] catchup fetch failed: ${String(catchupErr)}`,
                );
              }
            }
          }

          stage = "poll";
          logger.warn(
            `[zulip-debug][${account.accountId}] polling events (queue=${queueId.slice(0, 8)}, lastEventId=${lastEventId}, stream=${stream})`,
          );
          const events = await pollEvents({ auth, queueId, lastEventId, abortSignal });
          if (events.result !== "success") {
            throw new Error(events.msg || "Zulip events poll failed");
          }

          const list = events.events ?? [];
          // Update lastEventId from individual event IDs. The /api/v1/events
          // response does NOT include a top-level last_event_id field — only
          // /api/v1/register does. Without this, lastEventId stays at -1 forever,
          // causing every poll to replay ALL events since queue registration.
          for (const evt of list) {
            if (typeof evt.id === "number" && evt.id > lastEventId) {
              lastEventId = evt.id;
            }
          }

          logger.warn(
            `[zulip-debug][${account.accountId}] poll returned ${list.length} events (messages: ${list.filter((e) => e.message).length}, lastEventId=${lastEventId})`,
          );

          for (const evt of list) {
            const rename = parseTopicRenameEvent(evt);
            if (!rename) {
              continue;
            }

            let fromStream: string;
            let toStream: string;
            if (rename.origStreamId !== undefined && rename.newStreamId !== undefined) {
              // Cross-stream move: resolve stream IDs to names.
              const origName = streamIdToName.get(rename.origStreamId);
              const newName = streamIdToName.get(rename.newStreamId);
              if (!origName || !newName) {
                logger.debug?.(
                  `[zulip:${account.accountId}] cross-stream move: could not resolve stream IDs (orig=${rename.origStreamId}, new=${rename.newStreamId})`,
                );
                continue;
              }
              // Only track moves between streams we monitor.
              const streamIds = account.streams.map((s) => s.streamId.toLowerCase());
              if (!streamIds.includes(origName.toLowerCase()) || !streamIds.includes(newName.toLowerCase())) {
                continue;
              }
              fromStream = origName;
              toStream = newName;
            } else {
              // Same-stream topic rename.
              fromStream = stream;
              toStream = stream;
            }

            const mapped = topicTracker.recordRename({
              fromStream,
              fromTopic: rename.fromTopic,
              toStream,
              toTopic: rename.toTopic,
            });
            if (mapped) {
              if (fromStream !== toStream) {
                logger.info(
                  `[zulip:${account.accountId}] mapped cross-stream topic move: "${toStream}#${rename.toTopic}" -> "${fromStream}#${rename.fromTopic}"`,
                );
              } else {
                logger.info(
                  `[zulip:${account.accountId}] mapped topic rename alias for stream "${stream}": "${rename.toTopic}" -> "${rename.fromTopic}"`,
                );
              }
            }
          }

          const messages = list
            .map((evt) => evt.message)
            .filter((m): m is ZulipEventMessage => Boolean(m));

          for (const msg of messages) {
            rememberReactionMessageContext(msg);
          }

          // Track highest message ID for freshness checker gap detection.
          for (const msg of messages) {
            if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
              lastSeenMsgId = msg.id;
            }
          }

          for (const msg of messages) {
            const ignore = shouldIgnoreMessage({
              message: msg,
              botUserId,
            });
            logger.warn(
              `[zulip-debug][${account.accountId}] event msg id=${msg.id} topic="${msg.subject}" sender=${msg.sender_id} ignore=${ignore.ignore}${ignore.reason ? ` (${ignore.reason})` : ""}`,
            );
          }

          // Handle reaction events
          const reactionEvents = list
            .filter((evt): evt is import("./types.js").ZulipEvent & ZulipReactionEvent => evt.type === "reaction")
            .map((evt) => evt as ZulipReactionEvent);

          for (const reactionEvent of reactionEvents) {
            try {
              handleReaction(reactionEvent);
            } catch (err) {
              logger.debug?.(
                `[zulip:${account.accountId}] reaction handling failed: ${String(err)}`,
              );
            }
          }

          // Defensive throttle: if Zulip responds immediately without any message payloads (e.g.
          // heartbeat-only events, proxies, or aggressive server settings), avoid a tight loop that can
          // hit 429s.
          if (messages.length === 0 && reactionEvents.length === 0) {
            const jitterMs = Math.floor(Math.random() * 250);
            await sleep(2000 + jitterMs, abortSignal).catch(() => undefined);
            retry = 0;
            continue;
          }

          stage = "handle";
          for (const msg of messages) {
            debouncer.enqueue({ msg, source: "poll" });
          }

          retry = 0;
        } catch (err) {
          // FIX: Only break if explicitly stopped, NOT on abort
          // Abort errors (timeouts) should trigger queue re-registration
          if (stopped) {
            break;
          }

          const status = extractZulipHttpStatus(err);
          const retryAfterMs = (err as ZulipHttpError).retryAfterMs;

          // FIX: Always clear queueId on ANY error to force re-registration
          // This prevents stuck queues when fetch times out or aborts
          queueId = "";

          // Detect timeout/abort errors specifically for better logging
          const isAbortError =
            err instanceof Error &&
            (err.name === "AbortError" ||
              err.message?.includes("aborted") ||
              err.message?.includes("timeout") ||
              err.message?.includes("ETIMEDOUT"));

          if (isAbortError) {
            logger.warn(
              `[zulip:${account.accountId}] poll timeout/abort detected (stream=${stream}, stage=${stage}): ${String(err)} - forcing queue re-registration`,
            );
          }

          retry += 1;
          const backoffMs = computeZulipMonitorBackoffMs({
            attempt: retry,
            status,
            retryAfterMs,
          });
          logger.warn(
            `[zulip:${account.accountId}] monitor error (stream=${stream}, stage=${stage}, attempt=${retry}): ${String(err)} (retry in ${backoffMs}ms)`,
          );
          await sleep(backoffMs, abortSignal).catch(() => undefined);
        }
      }

      // Clean up freshness checker interval.
      clearInterval(freshnessTimer);

      // Issue 4: clean up the server-side event queue on shutdown.
      if (queueId) {
        try {
          await zulipRequest({
            auth,
            method: "DELETE",
            path: "/api/v1/events",
            form: { queue_id: queueId },
          });
        } catch {
          // Best effort — server will expire it anyway.
        }
      }
    };

    await replayPendingCheckpoints();

    const streamNames = account.streams.map((s) => s.streamId);
    const plan = buildZulipQueuePlan({ streams: streamNames, dmEnabled: dmEnabled || account.groupDmEnabled });
    if (plan.length === 0) {
      throw new Error(
        `Zulip account "${account.accountId}" has no streams configured and DMs are disabled`,
      );
    }
    await Promise.all(
      plan.map((entry) => {
        if (entry.kind === "stream") {
          return pollStreamQueue(entry.stream);
        }
        // DM queue uses the same polling mechanism with a special "dm" stream key
        return pollStreamQueue("__dm__");
      }),
    );
  };

  const done = run()
    .catch((err) => {
      if (abortSignal.aborted || stopped) {
        return;
      }
      opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
      runtime.error?.(`[zulip:${account.accountId}] monitor crashed: ${String(err)}`);
    })
    .finally(() => {
      // Clean up reaction button sessions
      stopReactionButtonSessionCleanup();
      logger.warn(`[zulip-debug][${account.accountId}] stopped`);
    });

  return { stop, done };
}
