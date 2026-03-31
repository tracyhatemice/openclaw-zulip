import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import type { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { ResolvedZulipAccount, ResolvedZulipReactions, ZulipReactionWorkflowStage } from "../accounts.js";
import type { ZulipAuth } from "../client.js";
import type { createDedupeCache } from "../dedupe.js";
import type { ZulipProcessedMessageState } from "../processed-message-state.js";
import type { getZulipRuntime } from "../../runtime.js";
import type { TopicRenameTracker } from "./topic-management.js";

export type MonitorZulipOptions = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string;
  }) => void;
};

export type ZulipRegisterResponse = {
  result: "success" | "error";
  msg?: string;
  queue_id?: string;
  last_event_id?: number;
};

export type ZulipDmRecipient = {
  id: number;
  email: string;
  full_name?: string;
};

export type ZulipEventMessage = {
  id: number;
  type: string;
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  /** String for stream messages, array of recipients for DMs. */
  display_recipient?: string | ZulipDmRecipient[];
  stream_id?: number;
  subject?: string;
  content?: string;
  content_type?: string;
  timestamp?: number;
};

export type ZulipMessageKind = "stream" | "dm" | "group-dm";

export function classifyZulipMessage(msg: ZulipEventMessage, botUserId: number): {
  kind: ZulipMessageKind;
  dmRecipients?: ZulipDmRecipient[];
} {
  if (msg.type === "stream") {
    return { kind: "stream" };
  }
  // type === "direct" or "private" — both are DMs
  if (!Array.isArray(msg.display_recipient)) {
    return { kind: "dm" };
  }
  const recipients = msg.display_recipient.filter((r) => r.id !== botUserId);
  if (recipients.length <= 1) {
    return { kind: "dm", dmRecipients: msg.display_recipient };
  }
  return { kind: "group-dm", dmRecipients: msg.display_recipient };
}

export type ZulipReactionEvent = {
  id?: number;
  type: "reaction";
  op: "add" | "remove";
  message_id: number;
  emoji_name: string;
  emoji_code: string;
  user_id: number;
  user?: {
    email?: string;
    full_name?: string;
    user_id?: number;
  };
  message?: ZulipEventMessage;
};

export type ZulipUpdateMessageEvent = {
  id?: number;
  type: "update_message";
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
  stream_id?: number;
  orig_stream_id?: number;
};

export type ZulipEvent = {
  id?: number;
  type?: string;
  message?: ZulipEventMessage;
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
  stream_id?: number;
  orig_stream_id?: number;
  // Reaction fields (inlined from ZulipReactionEvent to avoid discriminant conflict on 'type')
  op?: "add" | "remove";
  message_id?: number;
  emoji_name?: string;
  emoji_code?: string;
  user_id?: number;
  user?: { email?: string; full_name?: string; user_id?: number };
};

export type ZulipEventsResponse = {
  result: "success" | "error";
  msg?: string;
  events?: ZulipEvent[];
  last_event_id?: number;
};

export type ZulipMeResponse = {
  result: "success" | "error";
  msg?: string;
  user_id?: number;
  email?: string;
  full_name?: string;
};

export type ZulipMessageSource = "poll" | "catchup" | "freshness" | "recovery";

export type ZulipTraceContext = {
  source: ZulipMessageSource;
};

export type ReactionTransitionController = {
  transition: (
    stage: ZulipReactionWorkflowStage,
    options?: { abortSignal?: AbortSignal; force?: boolean },
  ) => Promise<void>;
};

export type PreparedZulipMessage = {
  msg: ZulipEventMessage;
  source: ZulipMessageSource;
  kind: ZulipMessageKind;
  /** Stream name (only for stream messages). */
  stream: string;
  /** Topic (only for stream messages). */
  topic: string;
  /** DM recipients (only for dm/group-dm messages). */
  dmRecipients?: ZulipDmRecipient[];
  content: string;
  isRecovery: boolean;
  queuedReactionStarted: boolean;
  reactionController: ReactionTransitionController | null;
  trace: ZulipTraceContext;
  batch?: { messageSids: string[]; messageSidFirst: string; messageSidLast: string };
};

export const DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;
export const KEEPALIVE_INITIAL_DELAY_MS = 25_000;
export const KEEPALIVE_REPEAT_INTERVAL_MS = 60_000;
export const ZULIP_RECOVERY_NOTICE = "🔄 Gateway restarted - resuming the previous task now...";

/**
 * Shared context threaded through all monitor functions that were previously
 * closures inside the `run()` scope of `monitorZulipProvider`.
 */
export type MonitorContext = {
  readonly core: ReturnType<typeof getZulipRuntime>;
  readonly cfg: OpenClawConfig;
  readonly account: ResolvedZulipAccount;
  readonly runtime: RuntimeEnv;
  readonly auth: ZulipAuth;
  readonly botUserId: number;
  readonly botDisplayName: string;
  readonly abortSignal: AbortSignal;
  readonly pairing: ReturnType<typeof createChannelPairingController>;
  readonly opts: MonitorZulipOptions;
  readonly logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
  readonly dedupe: ReturnType<typeof createDedupeCache>;
  processedMessageState: ZulipProcessedMessageState;
  processedMessageWriteChain: Promise<void>;
  readonly topicTracker: TopicRenameTracker;
  readonly streamIdToName: Map<number, string>;
  readonly reactionMessageContexts: Map<
    number,
    { stream: string; topic: string; capturedAt: number }
  >;
  readonly logTrace: (params: {
    milestone: string;
    messageId?: number;
    stream?: string;
    topic?: string;
    sessionKey?: string;
    source?: ZulipMessageSource;
    extra?: Record<string, boolean | number | string | undefined>;
  }) => void;
  readonly persistProcessedMessageState: () => Promise<void>;
};
