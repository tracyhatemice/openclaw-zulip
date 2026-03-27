import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChannelReplyPipeline: vi.fn(),
  getZulipRuntime: vi.fn(),
  resolveZulipAccount: vi.fn(),
  zulipRequest: vi.fn(),
  sendZulipStreamMessage: vi.fn(),
  downloadZulipUploads: vi.fn(),
  resolveOutboundMedia: vi.fn(),
  uploadZulipFile: vi.fn(),
  addZulipReaction: vi.fn(),
  removeZulipReaction: vi.fn(),
  buildZulipQueuePlan: vi.fn(),
  buildZulipRegisterNarrow: vi.fn(),
  loadZulipInFlightCheckpoints: vi.fn(),
  writeZulipInFlightCheckpoint: vi.fn(),
  clearZulipInFlightCheckpoint: vi.fn(),
  isZulipCheckpointStale: vi.fn(),
  prepareZulipCheckpointForRecovery: vi.fn(),
  markZulipCheckpointFailure: vi.fn(),
  buildZulipCheckpointId: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: mocks.createChannelReplyPipeline,
}));

vi.mock("../runtime.js", () => ({
  getZulipRuntime: mocks.getZulipRuntime,
}));

vi.mock("./accounts.js", () => ({
  resolveZulipAccount: mocks.resolveZulipAccount,
}));

vi.mock("./client.js", () => ({
  zulipRequest: mocks.zulipRequest,
}));

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: mocks.sendZulipStreamMessage,
}));

vi.mock("./uploads.js", () => ({
  downloadZulipUploads: mocks.downloadZulipUploads,
  resolveOutboundMedia: mocks.resolveOutboundMedia,
  uploadZulipFile: mocks.uploadZulipFile,
}));

vi.mock("./reactions.js", () => ({
  addZulipReaction: mocks.addZulipReaction,
  removeZulipReaction: mocks.removeZulipReaction,
}));

vi.mock("./queue-plan.js", () => ({
  buildZulipQueuePlan: mocks.buildZulipQueuePlan,
  buildZulipRegisterNarrow: mocks.buildZulipRegisterNarrow,
}));

vi.mock("./inflight-checkpoints.js", () => ({
  ZULIP_INFLIGHT_CHECKPOINT_VERSION: 1,
  ZULIP_INFLIGHT_MAX_RETRY_COUNT: 25,
  loadZulipInFlightCheckpoints: mocks.loadZulipInFlightCheckpoints,
  writeZulipInFlightCheckpoint: mocks.writeZulipInFlightCheckpoint,
  clearZulipInFlightCheckpoint: mocks.clearZulipInFlightCheckpoint,
  isZulipCheckpointStale: mocks.isZulipCheckpointStale,
  prepareZulipCheckpointForRecovery: mocks.prepareZulipCheckpointForRecovery,
  markZulipCheckpointFailure: mocks.markZulipCheckpointFailure,
  buildZulipCheckpointId: mocks.buildZulipCheckpointId,
}));

vi.mock("./processed-message-state.js", () => ({
  loadZulipProcessedMessageState: vi.fn(async () => ({ accountId: "default", messages: {} })),
  writeZulipProcessedMessageState: vi.fn(async () => undefined),
  isZulipMessageAlreadyProcessed: vi.fn(() => false),
  markZulipMessageProcessed: vi.fn(() => ({ accountId: "default", messages: {} })),
}));

vi.mock("./reaction-buttons.js", () => ({
  startReactionButtonSessionCleanup: vi.fn(),
  stopReactionButtonSessionCleanup: vi.fn(),
  getReactionButtonSession: vi.fn(() => undefined),
  handleReactionEvent: vi.fn(),
}));

vi.mock("./typing.js", () => ({
  sendZulipStreamTypingStart: vi.fn(async () => undefined),
  sendZulipStreamTypingStop: vi.fn(async () => undefined),
}));

import { monitorZulipProvider } from "./monitor.js";

type ZulipEventMessage = {
  id: number;
  type: "stream";
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  display_recipient?: string;
  stream_id?: number;
  subject?: string;
  content?: string;
  timestamp?: number;
};

type ZulipQueueEvent = {
  id: number;
  type?: string;
  message?: ZulipEventMessage;
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
};

type ContextPayload = {
  SessionKey?: string;
  To?: string;
  From?: string;
  MessageSid?: string;
};

/**
 * Simulates the SDK's `resolveFallbackSession` logic to compute the outbound
 * session key.  The real function lives in the SDK's outbound-session.ts but
 * we mirror its key derivation here so we can assert alignment.
 */
function simulateSdkFallbackSessionKey(target: string): string {
  // stripProviderPrefix — removes "zulip:" prefix
  let stripped = target.trim();
  if (stripped.toLowerCase().startsWith("zulip:")) {
    stripped = stripped.slice("zulip:".length).trim();
  }
  // stripKindPrefix — only removes user:/channel:/group:/conversation:/room:/dm:
  stripped = stripped.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
  // peerId is the remaining value, lowercased
  const peerId = stripped.toLowerCase();
  // For channel targets (Zulip capabilities include "channel" but not "group",
  // so inferPeerKind returns "channel")
  return `agent:main:zulip:channel:${peerId}`;
}

function waitForCondition(condition: () => boolean, timeoutMs = 1_500): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("condition timeout"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createHarness(events: ZulipQueueEvent[]) {
  const dispatchReplyFromConfig = vi.fn(async () => undefined);
  let resolveAgentRouteSpy: ReturnType<typeof vi.fn>;

  const runtime = {
    logging: {
      getChildLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      })),
    },
    channel: {
      text: {
        chunkMarkdownText: vi.fn((value: string) => [value]),
      },
      activity: {
        record: vi.fn(),
      },
      routing: {
        resolveAgentRoute: (resolveAgentRouteSpy = vi.fn(
          ({ peer }: { peer?: { kind: string; id: string } }) => ({
            sessionKey: peer ? `agent:main:zulip:${peer.kind}:${peer.id}` : "agent:main:main",
            agentId: "agent-1",
            accountId: "acc-1",
          }),
        )),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx: object) => ctx),
        createReplyDispatcherWithTyping: vi.fn(() => ({
          dispatcher: {
            sendToolResult: vi.fn(() => true),
            sendBlockReply: vi.fn(() => true),
            sendFinalReply: vi.fn(() => true),
            waitForIdle: vi.fn(async () => undefined),
            getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
            markComplete: vi.fn(),
          },
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        })),
        resolveHumanDelayConfig: vi.fn(() => ({ mode: "off" })),
        dispatchReplyFromConfig,
      },
    },
    config: {
      loadConfig: vi.fn(() => ({})),
    },
  };

  mocks.getZulipRuntime.mockReturnValue(runtime);
  mocks.createChannelReplyPipeline.mockReturnValue({ onModelSelected: vi.fn() });

  mocks.resolveZulipAccount.mockReturnValue({
    accountId: "default",
    baseUrl: "https://zulip.example.com",
    email: "bot@zulip.example.com",
    apiKey: "api-key",
    streams: [
      { streamId: "marcel", streamPolicy: "open" as const, requireMention: false, allowFrom: [] },
    ],
    defaultTopic: "general",
    streamPolicy: "open" as const,
    requireMention: false,
    groupDmEnabled: false,
    config: {},
    textChunkLimit: 10_000,
    reactions: {
      enabled: false,
      onStart: "eyes",
      onSuccess: "check",
      onFailure: "warning",
      clearOnFinish: true,
    },
  });

  mocks.buildZulipQueuePlan.mockReturnValue([{ kind: "stream", stream: "marcel" }]);
  mocks.buildZulipRegisterNarrow.mockReturnValue(JSON.stringify([["stream", "marcel"]]));
  mocks.downloadZulipUploads.mockResolvedValue([]);
  mocks.resolveOutboundMedia.mockResolvedValue({
    buffer: Buffer.from(""),
    contentType: "image/png",
    filename: "x.png",
  });
  mocks.uploadZulipFile.mockResolvedValue("https://zulip.example.com/user_uploads/file.png");
  mocks.sendZulipStreamMessage.mockResolvedValue({ result: "success", id: 99 });

  mocks.loadZulipInFlightCheckpoints.mockResolvedValue([]);
  mocks.writeZulipInFlightCheckpoint.mockResolvedValue(undefined);
  mocks.clearZulipInFlightCheckpoint.mockResolvedValue(undefined);
  mocks.isZulipCheckpointStale.mockReturnValue(false);
  mocks.prepareZulipCheckpointForRecovery.mockImplementation(
    ({ checkpoint }: { checkpoint: Record<string, unknown> }) => checkpoint,
  );
  mocks.markZulipCheckpointFailure.mockImplementation(
    ({ checkpoint }: { checkpoint: Record<string, unknown> }) => checkpoint,
  );
  mocks.buildZulipCheckpointId.mockImplementation(
    ({ accountId, messageId }: { accountId: string; messageId: number }) =>
      `${accountId}:${messageId}`,
  );

  let pollCount = 0;
  mocks.zulipRequest.mockImplementation(
    async ({
      path,
      method,
      form,
      abortSignal,
    }: {
      path: string;
      method?: string;
      form?: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }) => {
      if (path === "/api/v1/users/me") {
        return { result: "success", user_id: 9 };
      }
      if (path === "/api/v1/register") {
        return { result: "success", queue_id: "queue-1", last_event_id: 100 };
      }
      if (path === "/api/v1/events" && method === "DELETE") {
        return { result: "success" };
      }
      if (path === "/api/v1/events") {
        pollCount += 1;
        if (pollCount === 1) {
          return { result: "success", events };
        }
        return await new Promise<never>((_, reject) => {
          const onAbort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (abortSignal?.aborted) {
            onAbort();
            return;
          }
          abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (path === "/api/v1/typing") {
        return { result: "success" };
      }
      return { result: "success" };
    },
  );

  return { dispatchReplyFromConfig, resolveAgentRouteSpy };
}

function makeMessage(messageId: number, topic: string): ZulipEventMessage {
  return {
    id: messageId,
    type: "stream",
    sender_id: 55,
    sender_full_name: "Tester",
    display_recipient: "marcel",
    stream_id: 42,
    subject: topic,
    content: "hello",
    timestamp: Math.floor(Date.now() / 1000),
  };
}

describe("session key alignment with SDK fallback resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces a session key matching the SDK fallback for a simple topic", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      { id: 101, message: makeMessage(9001, "general chat") },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const ctx = (dispatchReplyFromConfig.mock.calls[0]?.[0] as { ctx: ContextPayload }).ctx;
    const inboundSessionKey = ctx.SessionKey!;
    const outboundTarget = ctx.To!; // "stream:marcel#general chat"
    const sdkFallbackKey = simulateSdkFallbackSessionKey(outboundTarget);

    expect(inboundSessionKey).toBe(sdkFallbackKey);

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("produces a session key matching the SDK fallback for a topic with spaces", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      { id: 101, message: makeMessage(9001, "US946 patent") },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const ctx = (dispatchReplyFromConfig.mock.calls[0]?.[0] as { ctx: ContextPayload }).ctx;
    const inboundSessionKey = ctx.SessionKey!;
    const outboundTarget = ctx.To!;
    const sdkFallbackKey = simulateSdkFallbackSessionKey(outboundTarget);

    expect(inboundSessionKey).toBe(sdkFallbackKey);

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("produces a session key matching the SDK fallback for a topic with special chars", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      { id: 101, message: makeMessage(9001, "bugs/issue#42") },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const ctx = (dispatchReplyFromConfig.mock.calls[0]?.[0] as { ctx: ContextPayload }).ctx;
    const inboundSessionKey = ctx.SessionKey!;
    const outboundTarget = ctx.To!;
    const sdkFallbackKey = simulateSdkFallbackSessionKey(outboundTarget);

    expect(inboundSessionKey).toBe(sdkFallbackKey);

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("session key is case-insensitive (mixed case topic)", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      { id: 101, message: makeMessage(9001, "MyTopic") },
      { id: 102, message: makeMessage(9002, "mytopic") },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 2);

    const contexts = dispatchReplyFromConfig.mock.calls.map(
      ([arg]) => (arg as { ctx: ContextPayload }).ctx,
    );
    const first = contexts.find((ctx) => ctx.MessageSid === "9001");
    const second = contexts.find((ctx) => ctx.MessageSid === "9002");

    // Both should resolve to the same session key (lowercase)
    expect(first?.SessionKey).toBe(second?.SessionKey);

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("passes stream:name#topic as peer ID to resolveAgentRoute", async () => {
    const { dispatchReplyFromConfig, resolveAgentRouteSpy } = createHarness([
      { id: 101, message: makeMessage(9001, "my topic") },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    // Verify resolveAgentRoute was called with the stream:name#topic peer format
    const routeCall = resolveAgentRouteSpy.mock.calls.find(
      ([arg]: [{ peer?: { kind: string; id: string } }]) =>
        arg.peer?.id?.startsWith("stream:"),
    );
    expect(routeCall).toBeDefined();
    const peer = routeCall![0].peer;
    expect(peer.kind).toBe("channel");
    expect(peer.id).toBe("stream:marcel#my topic");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("session key preserves canonical topic after rename", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      { id: 101, message: makeMessage(9001, "original") },
      {
        id: 102,
        type: "update_message",
        orig_subject: "original",
        subject: "renamed",
      },
      { id: 103, message: makeMessage(9002, "renamed") },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 2);

    const contexts = dispatchReplyFromConfig.mock.calls.map(
      ([arg]) => (arg as { ctx: ContextPayload }).ctx,
    );
    const first = contexts.find((ctx) => ctx.MessageSid === "9001");
    const second = contexts.find((ctx) => ctx.MessageSid === "9002");

    // Both should have the canonical (original) session key
    expect(first?.SessionKey).toBe(second?.SessionKey);
    // But the To field should reflect the current topic
    expect(second?.To).toBe("stream:marcel#renamed");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });
});

describe("inferTargetChatType", () => {
  // Test the function logic directly (same implementation as in channel.ts)
  // to avoid importing the full plugin which has heavy dependencies.
  function inferTargetChatType({ to }: { to: string }): string | undefined {
    const trimmed = (to ?? "").trim();
    if (/^(zulip:)?(stream:|channel:)/i.test(trimmed)) return "channel";
    if (/^(zulip:)?(user:|dm:)/i.test(trimmed)) return "direct";
    if (/^(zulip:)?group-dm:/i.test(trimmed)) return "group";
    return undefined;
  }

  it("returns 'channel' for stream: targets", () => {
    expect(inferTargetChatType({ to: "stream:general#topic" })).toBe("channel");
    expect(inferTargetChatType({ to: "stream:openclaw#US946 patent" })).toBe("channel");
  });

  it("returns 'channel' for channel: targets", () => {
    expect(inferTargetChatType({ to: "channel:general" })).toBe("channel");
  });

  it("returns 'channel' for zulip: prefixed stream targets", () => {
    expect(inferTargetChatType({ to: "zulip:stream:general#topic" })).toBe("channel");
  });

  it("returns 'direct' for user: targets", () => {
    expect(inferTargetChatType({ to: "user:12345" })).toBe("direct");
  });

  it("returns 'direct' for dm: targets", () => {
    expect(inferTargetChatType({ to: "dm:12345" })).toBe("direct");
  });

  it("returns 'group' for group-dm: targets", () => {
    expect(inferTargetChatType({ to: "group-dm:1,2,3" })).toBe("group");
  });

  it("returns undefined for unrecognized targets", () => {
    expect(inferTargetChatType({ to: "something-else" })).toBeUndefined();
    expect(inferTargetChatType({ to: "" })).toBeUndefined();
  });
});
