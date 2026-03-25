import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerZulipSubagentHooks } from "./subagent-hooks.js";

vi.mock("./zulip/accounts.js", () => ({
  resolveZulipTopicBindingFlags: vi.fn(() => ({ enabled: true, spawnSubagentSessions: true })),
}));

vi.mock("./zulip/topic-bindings.js", () => ({
  createTopicBinding: vi.fn(() => ({
    stream: "general",
    topic: "parent / child",
    sessionKey: "child-key",
    accountId: "default",
  })),
  listTopicBindingsBySessionKey: vi.fn(() => []),
  unbindTopicBindingsBySessionKey: vi.fn(() => 1),
  resolveTopicForSubagent: vi.fn(() => "parent / child"),
}));

import { resolveZulipTopicBindingFlags } from "./zulip/accounts.js";
import {
  createTopicBinding,
  listTopicBindingsBySessionKey,
  unbindTopicBindingsBySessionKey,
} from "./zulip/topic-bindings.js";

function createMockApi() {
  const handlers = new Map<string, Function>();
  return {
    config: { channels: { zulip: { enabled: true } } },
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    getHandler: (event: string) => handlers.get(event),
  };
}

describe("registerZulipSubagentHooks", () => {
  let api: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    api = createMockApi();
    registerZulipSubagentHooks(api as any);
  });

  it("registers 3 event handlers", () => {
    expect(api.on).toHaveBeenCalledTimes(3);
    expect(api.on).toHaveBeenCalledWith("subagent_spawning", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("subagent_ended", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("subagent_delivery_target", expect.any(Function));
  });

  describe("subagent_spawning", () => {
    it("returns early when threadRequested is false", async () => {
      const handler = api.getHandler("subagent_spawning")!;
      const result = await handler({
        threadRequested: false,
        requester: { channel: "zulip", accountId: "default", to: "stream:general#topic" },
        childSessionKey: "child-1",
        agentId: "agent-1",
        label: "child",
      });
      expect(result).toBeUndefined();
    });

    it("returns early when channel !== 'zulip'", async () => {
      const handler = api.getHandler("subagent_spawning")!;
      const result = await handler({
        threadRequested: true,
        requester: { channel: "slack", accountId: "default", to: "stream:general#topic" },
        childSessionKey: "child-1",
        agentId: "agent-1",
        label: "child",
      });
      expect(result).toBeUndefined();
    });

    it("returns error when bindings disabled", async () => {
      vi.mocked(resolveZulipTopicBindingFlags).mockReturnValueOnce({
        enabled: false,
        spawnSubagentSessions: true,
      } as any);
      const handler = api.getHandler("subagent_spawning")!;
      const result = await handler({
        threadRequested: true,
        requester: { channel: "zulip", accountId: "default", to: "stream:general#topic" },
        childSessionKey: "child-1",
        agentId: "agent-1",
        label: "child",
      });
      expect(result).toEqual({
        status: "error",
        error: expect.stringContaining("disabled"),
      });
    });

    it("returns error when spawnSubagentSessions disabled", async () => {
      vi.mocked(resolveZulipTopicBindingFlags).mockReturnValueOnce({
        enabled: true,
        spawnSubagentSessions: false,
      } as any);
      const handler = api.getHandler("subagent_spawning")!;
      const result = await handler({
        threadRequested: true,
        requester: { channel: "zulip", accountId: "default", to: "stream:general#topic" },
        childSessionKey: "child-1",
        agentId: "agent-1",
        label: "child",
      });
      expect(result).toEqual({
        status: "error",
        error: expect.stringContaining("spawnSubagentSessions"),
      });
    });

    it("creates topic binding on success", async () => {
      const handler = api.getHandler("subagent_spawning")!;
      await handler({
        threadRequested: true,
        requester: { channel: "zulip", accountId: "default", to: "stream:general#parent-topic" },
        childSessionKey: "child-1",
        agentId: "agent-1",
        label: "child",
      });
      expect(createTopicBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "general",
          sessionKey: "child-1",
          agentId: "agent-1",
          accountId: "default",
          label: "child",
          boundBy: "system",
          targetKind: "subagent",
        }),
      );
    });

    it("returns { status: 'ok', threadBindingReady: true }", async () => {
      const handler = api.getHandler("subagent_spawning")!;
      const result = await handler({
        threadRequested: true,
        requester: { channel: "zulip", accountId: "default", to: "stream:general#parent-topic" },
        childSessionKey: "child-1",
        agentId: "agent-1",
        label: "child",
      });
      expect(result).toEqual({ status: "ok", threadBindingReady: true });
    });

    it("returns error on exception", async () => {
      vi.mocked(createTopicBinding).mockImplementationOnce(() => {
        throw new Error("bind boom");
      });
      const handler = api.getHandler("subagent_spawning")!;
      const result = await handler({
        threadRequested: true,
        requester: { channel: "zulip", accountId: "default", to: "stream:general#parent-topic" },
        childSessionKey: "child-1",
        agentId: "agent-1",
        label: "child",
      });
      expect(result).toEqual({
        status: "error",
        error: expect.stringContaining("bind boom"),
      });
    });
  });

  describe("subagent_ended", () => {
    it("calls unbindTopicBindingsBySessionKey", () => {
      const handler = api.getHandler("subagent_ended")!;
      handler({
        targetSessionKey: "child-1",
        accountId: "default",
        targetKind: "subagent",
        reason: "completed",
      });
      expect(unbindTopicBindingsBySessionKey).toHaveBeenCalledWith({
        targetSessionKey: "child-1",
        accountId: "default",
        targetKind: "subagent",
        reason: "completed",
      });
    });
  });

  describe("subagent_delivery_target", () => {
    it("returns early when expectsCompletionMessage is false", () => {
      const handler = api.getHandler("subagent_delivery_target")!;
      const result = handler({
        expectsCompletionMessage: false,
        requesterOrigin: { channel: "zulip", accountId: "default" },
        childSessionKey: "child-1",
      });
      expect(result).toBeUndefined();
    });

    it("returns early when requesterChannel !== 'zulip'", () => {
      const handler = api.getHandler("subagent_delivery_target")!;
      const result = handler({
        expectsCompletionMessage: true,
        requesterOrigin: { channel: "slack", accountId: "default" },
        childSessionKey: "child-1",
      });
      expect(result).toBeUndefined();
    });

    it("returns origin with stream:topic from binding", () => {
      vi.mocked(listTopicBindingsBySessionKey).mockReturnValueOnce([
        { stream: "general", topic: "parent / child", accountId: "default", sessionKey: "child-1" },
      ] as any);
      const handler = api.getHandler("subagent_delivery_target")!;
      const result = handler({
        expectsCompletionMessage: true,
        requesterOrigin: { channel: "zulip", accountId: "default" },
        childSessionKey: "child-1",
      });
      expect(result).toEqual({
        origin: {
          channel: "zulip",
          accountId: "default",
          to: "stream:general#parent / child",
        },
      });
    });
  });
});
