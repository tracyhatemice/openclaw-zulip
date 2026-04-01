import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  zulipRequest: vi.fn(async () => ({ result: "success" })),
  zulipRequestWithRetry: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./accounts.js", () => ({
  resolveZulipAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    baseUrl: "https://zulip.example",
    email: "bot@test.com",
    apiKey: "test-key",
    streams: [{ streamId: "general", streamPolicy: "open" as const, requireMention: false, allowFrom: [] }],
    streamPolicy: "open" as const,
    requireMention: false,
    groupDmEnabled: false,
    defaultTopic: "general chat",
    reactions: { enabled: true },
    textChunkLimit: 10000,
    config: {},
  })),
}));

vi.mock("./reactions.js", () => ({
  addZulipReaction: vi.fn(async () => undefined),
  removeZulipReaction: vi.fn(async () => undefined),
}));

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: vi.fn(async () => ({ result: "success", id: 42 })),
  editZulipMessageTopic: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./uploads.js", () => ({
  uploadZulipFile: vi.fn(async () => "/user_uploads/1/file.png"),
  resolveOutboundMedia: vi.fn(async () => ({
    buffer: Buffer.from(""),
    contentType: "image/png",
    filename: "file.png",
  })),
}));

vi.mock("./reaction-buttons.js", () => ({
  sendWithReactionButtons: vi.fn(async () => ({ messageId: 42 })),
}));

import { zulipRequest, zulipRequestWithRetry } from "./client.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";
import { editZulipMessageTopic, sendZulipStreamMessage } from "./send.js";
import { sendWithReactionButtons } from "./reaction-buttons.js";
import { zulipMessageActions } from "./actions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: {
  actions?: Record<string, boolean>;
  accountActions?: Record<string, Record<string, boolean>>;
}) {
  return {
    channels: {
      zulip: {
        actions: overrides?.actions ?? {},
        accounts: overrides?.accountActions
          ? Object.fromEntries(
              Object.entries(overrides.accountActions).map(([k, v]) => [
                k,
                { actions: v },
              ]),
            )
          : undefined,
      },
    },
  };
}

function makeCtx(
  action: string,
  params: Record<string, unknown>,
  cfgOverrides?: Parameters<typeof makeConfig>[0],
  accountId = "default",
) {
  return {
    action: action as any,
    params,
    cfg: makeConfig(cfgOverrides),
    accountId,
  };
}

// ---------------------------------------------------------------------------
// describeMessageTool
// ---------------------------------------------------------------------------

describe("describeMessageTool", () => {
  it("returns base actions", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig(),
      accountId: "default",
    });
    expect(result.actions).toContain("send");
    expect(result.actions).toContain("read");
    expect(result.actions).toContain("react");
    expect(result.actions).toContain("channel-list");
    expect(result.actions).toContain("topic-list");
    expect(result.actions).toContain("member-info");
    expect(result.actions).toContain("search");
    expect(result.actions).toContain("edit");
    expect(result.actions).toContain("delete");
    expect(result.actions).toContain("poll");
  });

  it("includes channel-create when enabled in config", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig({ actions: { channelCreate: true } }),
      accountId: "default",
    });
    expect(result.actions).toContain("channel-create");
  });

  it("excludes channel-create when not enabled (defaults disabled)", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig(),
      accountId: "default",
    });
    expect(result.actions).not.toContain("channel-create");
  });

  it("includes channel-edit when enabled", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig({ actions: { channelEdit: true } }),
      accountId: "default",
    });
    expect(result.actions).toContain("channel-edit");
  });

  it("includes channel-delete when enabled", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig({ actions: { channelDelete: true } }),
      accountId: "default",
    });
    expect(result.actions).toContain("channel-delete");
  });
});

// ---------------------------------------------------------------------------
// extractToolSend
// ---------------------------------------------------------------------------

describe("extractToolSend", () => {
  it("extracts target from args.target", () => {
    const result = zulipMessageActions.extractToolSend({
      args: { target: "stream:general#topic" },
    });
    expect(result).toEqual({
      to: "stream:general#topic",
      accountId: undefined,
    });
  });

  it("extracts target from args.to (fallback)", () => {
    const result = zulipMessageActions.extractToolSend({
      args: { to: "stream:general#topic" },
    });
    expect(result).toEqual({
      to: "stream:general#topic",
      accountId: undefined,
    });
  });

  it("returns null for missing target", () => {
    const result = zulipMessageActions.extractToolSend({ args: {} });
    expect(result).toBeNull();
  });

  it("returns null for empty target", () => {
    const result = zulipMessageActions.extractToolSend({
      args: { target: "   " },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleAction - read
// ---------------------------------------------------------------------------

describe("handleAction - read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: "success",
      messages: [{ id: 1, content: "hello" }],
    });
  });

  it("calls GET /api/v1/messages with narrow", async () => {
    await zulipMessageActions.handleAction(
      makeCtx("read", { target: "stream:general#topic" }),
    );
    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/messages",
        query: expect.objectContaining({
          anchor: "newest",
          narrow: expect.stringContaining("general"),
        }),
      }),
    );
  });

  it("returns messages array", async () => {
    const res = await zulipMessageActions.handleAction(
      makeCtx("read", { target: "stream:general#topic" }),
    );
    const details = res.details as any;
    expect(details.ok).toBe(true);
    expect(details.messages).toEqual([{ id: 1, content: "hello" }]);
    expect(details.count).toBe(1);
  });

  it("uses stream and topic from target", async () => {
    await zulipMessageActions.handleAction(
      makeCtx("read", { target: "stream:dev#bugs" }),
    );
    const call = (zulipRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const narrow = JSON.parse(call.query.narrow);
    expect(narrow).toEqual(
      expect.arrayContaining([
        ["stream", "dev"],
        ["topic", "bugs"],
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// handleAction - search
// ---------------------------------------------------------------------------

describe("handleAction - search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: "success",
      messages: [],
    });
  });

  it("includes search query in narrow", async () => {
    await zulipMessageActions.handleAction(
      makeCtx("search", {
        target: "stream:general#topic",
        query: "hello world",
      }),
    );
    const call = (zulipRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const narrow = JSON.parse(call.query.narrow);
    expect(narrow).toEqual(
      expect.arrayContaining([["search", "hello world"]]),
    );
  });

  it("throws when search action is disabled", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx(
          "search",
          { target: "stream:general#topic", query: "test" },
          { actions: { search: false } },
        ),
      ),
    ).rejects.toThrow(/disabled/i);
  });
});

// ---------------------------------------------------------------------------
// handleAction - send
// ---------------------------------------------------------------------------

describe("handleAction - send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends stream message via sendZulipStreamMessage", async () => {
    await zulipMessageActions.handleAction(
      makeCtx("send", {
        target: "stream:general#topic",
        message: "Hello!",
      }),
    );
    expect(sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "general",
        topic: "topic",
        content: "Hello!",
      }),
    );
  });

  it("returns messageId", async () => {
    const res = await zulipMessageActions.handleAction(
      makeCtx("send", {
        target: "stream:general#topic",
        message: "Hello!",
      }),
    );
    const details = res.details as any;
    expect(details.messageId).toBe("42");
  });

  it("throws for invalid target", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("send", { target: "invalid-target", message: "hi" }),
      ),
    ).rejects.toThrow(/Invalid Zulip target/);
  });
});

// ---------------------------------------------------------------------------
// handleAction - edit
// ---------------------------------------------------------------------------

describe("handleAction - edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends PATCH to /api/v1/messages/{id}", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "edit",
        { messageId: "100", message: "updated" },
        { actions: { edit: true } },
      ),
    );
    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        path: "/api/v1/messages/100",
        form: { content: "updated" },
      }),
    );
  });

  it("throws when edit action disabled", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx(
          "edit",
          { messageId: "100", message: "updated" },
          { actions: { edit: false } },
        ),
      ),
    ).rejects.toThrow(/disabled/i);
  });
});

// ---------------------------------------------------------------------------
// handleAction - delete
// ---------------------------------------------------------------------------

describe("handleAction - delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends DELETE to /api/v1/messages/{id}", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "delete",
        { messageId: "200" },
        { actions: { delete: true } },
      ),
    );
    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/api/v1/messages/200",
      }),
    );
  });

  it("throws when delete action disabled", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx(
          "delete",
          { messageId: "200" },
          { actions: { delete: false } },
        ),
      ),
    ).rejects.toThrow(/disabled/i);
  });
});

// ---------------------------------------------------------------------------
// handleAction - react
// ---------------------------------------------------------------------------

describe("handleAction - react", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls addZulipReaction", async () => {
    await zulipMessageActions.handleAction(
      makeCtx("react", { messageId: "300", emoji: "thumbs_up" }),
    );
    expect(addZulipReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 300,
        emojiName: "thumbs_up",
      }),
    );
  });

  it("calls removeZulipReaction when remove=true", async () => {
    await zulipMessageActions.handleAction(
      makeCtx("react", {
        messageId: "300",
        emoji: "thumbs_up",
        remove: true,
      }),
    );
    expect(removeZulipReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 300,
        emojiName: "thumbs_up",
      }),
    );
    expect(addZulipReaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleAction - channel-list
// ---------------------------------------------------------------------------

describe("handleAction - channel-list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: "success",
      streams: [{ name: "general", stream_id: 1 }],
    });
  });

  it("calls GET /api/v1/streams", async () => {
    await zulipMessageActions.handleAction(makeCtx("channel-list", {}));
    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/streams",
      }),
    );
  });

  it("returns streams array", async () => {
    const res = await zulipMessageActions.handleAction(
      makeCtx("channel-list", {}),
    );
    const details = res.details as any;
    expect(details.streams).toEqual([{ name: "general", stream_id: 1 }]);
    expect(details.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handleAction - channel-create
// ---------------------------------------------------------------------------

describe("handleAction - channel-create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends subscription JSON", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "channel-create",
        { name: "new-channel", description: "A new channel" },
        { actions: { channelCreate: true } },
      ),
    );
    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/users/me/subscriptions",
        form: expect.objectContaining({
          subscriptions: expect.stringContaining("new-channel"),
        }),
      }),
    );
  });

  it("throws when channel-create disabled (default)", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("channel-create", { name: "new-channel" }),
      ),
    ).rejects.toThrow(/disabled/i);
  });
});

// ---------------------------------------------------------------------------
// handleAction - channel-edit
// ---------------------------------------------------------------------------

describe("handleAction - channel-edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves streamId and sends PATCH", async () => {
    // First call resolves stream list for streamId lookup
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: "success",
      streams: [{ name: "general", stream_id: 1 }],
    });
    await zulipMessageActions.handleAction(
      makeCtx(
        "channel-edit",
        { target: "stream:general", newName: "renamed" },
        { actions: { channelEdit: true } },
      ),
    );
    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        path: "/api/v1/streams/1",
      }),
    );
  });

  it('throws "No channel updates" when no fields provided', async () => {
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: "success",
      streams: [{ name: "general", stream_id: 1 }],
    });
    await expect(
      zulipMessageActions.handleAction(
        makeCtx(
          "channel-edit",
          { target: "stream:general" },
          { actions: { channelEdit: true } },
        ),
      ),
    ).rejects.toThrow(/No channel updates/);
  });
});

// ---------------------------------------------------------------------------
// handleAction - channel-delete
// ---------------------------------------------------------------------------

describe("handleAction - channel-delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends DELETE to /api/v1/streams/{id}", async () => {
    (zulipRequest as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        result: "success",
        streams: [{ name: "general", stream_id: 1 }],
      })
      .mockResolvedValueOnce({ result: "success" });

    await zulipMessageActions.handleAction(
      makeCtx(
        "channel-delete",
        { target: "stream:general" },
        { actions: { channelDelete: true } },
      ),
    );
    // Second zulipRequest call is the DELETE
    const deleteCalls = (zulipRequest as ReturnType<typeof vi.fn>).mock.calls;
    expect(deleteCalls[1][0]).toMatchObject({
      method: "DELETE",
      path: "/api/v1/streams/1",
    });
  });
});

// ---------------------------------------------------------------------------
// handleAction - topic-list
// ---------------------------------------------------------------------------

describe("handleAction - topic-list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves streamId and calls topics endpoint", async () => {
    (zulipRequest as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        result: "success",
        streams: [{ name: "general", stream_id: 5 }],
      })
      .mockResolvedValueOnce({
        result: "success",
        topics: [{ name: "greetings", max_id: 10 }],
      });

    const res = await zulipMessageActions.handleAction(
      makeCtx("topic-list", { target: "stream:general" }),
    );
    const details = res.details as any;
    expect(details.topics).toEqual([{ name: "greetings", max_id: 10 }]);
    expect(details.streamId).toBe(5);

    const calls = (zulipRequest as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toMatchObject({
      method: "GET",
      path: "/api/v1/users/me/5/topics",
    });
  });
});

// ---------------------------------------------------------------------------
// handleAction - member-info
// ---------------------------------------------------------------------------

describe("handleAction - member-info", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves user identifier and calls users endpoint", async () => {
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: "success",
      user: { user_id: 10, full_name: "Test User" },
    });

    const res = await zulipMessageActions.handleAction(
      makeCtx("member-info", { target: "user@test.com" }),
    );
    const details = res.details as any;
    expect(details.ok).toBe(true);
    expect(details.action).toBe("member-info");

    // Should call the users endpoint with the email
    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: expect.stringContaining("/api/v1/users/"),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleAction - unknown
// ---------------------------------------------------------------------------

describe("handleAction - unknown", () => {
  it('throws "Unsupported action" for unknown action', async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("nonexistent-action", {}),
      ),
    ).rejects.toThrow(/Unsupported action/);
  });
});

// ---------------------------------------------------------------------------
// handleAction - poll
// ---------------------------------------------------------------------------

describe("handleAction - poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends message with reaction button options", async () => {
    const res = await zulipMessageActions.handleAction(
      makeCtx("poll", {
        to: "stream:general#topic",
        pollQuestion: "Pick one",
        pollOption: ["Yes", "No"],
      }),
    );
    expect(sendWithReactionButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "general",
        topic: "topic",
        message: "Pick one",
        options: [
          { label: "Yes", value: "Yes" },
          { label: "No", value: "No" },
        ],
      }),
    );
    const details = res.details as any;
    expect(details.messageId).toBe("42");
  });

  it("parses string pollOption array", async () => {
    await zulipMessageActions.handleAction(
      makeCtx("poll", {
        to: "stream:general#topic",
        pollQuestion: "Pick",
        pollOption: ["alpha", "beta"],
      }),
    );
    expect(sendWithReactionButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { label: "alpha", value: "alpha" },
          { label: "beta", value: "beta" },
        ],
      }),
    );
  });

  it("throws when pollOption not provided", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("poll", {
          to: "stream:general#topic",
          pollQuestion: "Pick",
        }),
      ),
    ).rejects.toThrow(/pollOption must be an array/);
  });
});

// ---------------------------------------------------------------------------
// Action gating defaults
// ---------------------------------------------------------------------------

describe("action gating defaults", () => {
  it("channel-create defaults to disabled", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("channel-create", { name: "test" }),
      ),
    ).rejects.toThrow(/disabled/i);
  });

  it("channel-edit defaults to disabled", async () => {
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: "success",
      streams: [{ name: "general", stream_id: 1 }],
    });
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("channel-edit", {
          target: "stream:general",
          newName: "renamed",
        }),
      ),
    ).rejects.toThrow(/disabled/i);
  });

  it("channel-delete defaults to disabled", async () => {
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: "success",
      streams: [{ name: "general", stream_id: 1 }],
    });
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("channel-delete", { target: "stream:general" }),
      ),
    ).rejects.toThrow(/disabled/i);
  });

  it("member-info defaults to enabled", async () => {
    (zulipRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: "success",
      user: { user_id: 1 },
    });
    const res = await zulipMessageActions.handleAction(
      makeCtx("member-info", { target: "me" }),
    );
    const details = res.details as any;
    expect(details.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleAction - topic-edit
// ---------------------------------------------------------------------------

describe("handleAction - topic-edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls editZulipMessageTopic with correct params", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "topic-edit",
        { messageId: "100", topic: "New Topic" },
        { actions: { topicEdit: true } },
      ),
    );
    expect(editZulipMessageTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 100,
        topic: "New Topic",
        propagateMode: "change_all",
      }),
    );
  });

  it("defaults propagateMode to change_all", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "topic-edit",
        { messageId: "1", topic: "t" },
        { actions: { topicEdit: true } },
      ),
    );
    expect(editZulipMessageTopic).toHaveBeenCalledWith(
      expect.objectContaining({ propagateMode: "change_all" }),
    );
  });

  it("passes explicit propagateMode", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "topic-edit",
        { messageId: "1", topic: "t", propagateMode: "change_one" },
        { actions: { topicEdit: true } },
      ),
    );
    expect(editZulipMessageTopic).toHaveBeenCalledWith(
      expect.objectContaining({ propagateMode: "change_one" }),
    );
  });

  it("passes streamId for cross-stream moves", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "topic-edit",
        { messageId: "1", topic: "t", streamId: 42 },
        { actions: { topicEdit: true } },
      ),
    );
    expect(editZulipMessageTopic).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 42 }),
    );
  });

  it("throws when topic-edit action disabled", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx(
          "topic-edit",
          { messageId: "1", topic: "t" },
          { actions: { topicEdit: false } },
        ),
      ),
    ).rejects.toThrow(/disabled/i);
  });

  it("defaults to disabled", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("topic-edit", { messageId: "1", topic: "t" }),
      ),
    ).rejects.toThrow(/disabled/i);
  });

  it("throws when required params are missing", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("topic-edit", {}, { actions: { topicEdit: true } }),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleAction - topic-resolve
// ---------------------------------------------------------------------------

describe("handleAction - topic-resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds resolved prefix when resolving", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "topic-resolve",
        { messageId: "1", currentTopic: "Bug Report" },
        { actions: { topicResolve: true } },
      ),
    );
    expect(editZulipMessageTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "\u2714 Bug Report",
        propagateMode: "change_all",
      }),
    );
  });

  it("removes resolved prefix when unresolving", async () => {
    await zulipMessageActions.handleAction(
      makeCtx(
        "topic-resolve",
        { messageId: "1", currentTopic: "\u2714 Bug Report", unresolve: true },
        { actions: { topicResolve: true } },
      ),
    );
    expect(editZulipMessageTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "Bug Report",
        propagateMode: "change_all",
      }),
    );
  });

  it("returns alreadyInDesiredState when already resolved", async () => {
    const res = await zulipMessageActions.handleAction(
      makeCtx(
        "topic-resolve",
        { messageId: "1", currentTopic: "\u2714 Bug Report" },
        { actions: { topicResolve: true } },
      ),
    );
    const details = res.details as any;
    expect(details.alreadyInDesiredState).toBe(true);
    expect(editZulipMessageTopic).not.toHaveBeenCalled();
  });

  it("returns alreadyInDesiredState when already unresolved", async () => {
    const res = await zulipMessageActions.handleAction(
      makeCtx(
        "topic-resolve",
        { messageId: "1", currentTopic: "Bug Report", unresolve: true },
        { actions: { topicResolve: true } },
      ),
    );
    const details = res.details as any;
    expect(details.alreadyInDesiredState).toBe(true);
    expect(editZulipMessageTopic).not.toHaveBeenCalled();
  });

  it("throws when topic-resolve action disabled", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx(
          "topic-resolve",
          { messageId: "1", currentTopic: "t" },
          { actions: { topicResolve: false } },
        ),
      ),
    ).rejects.toThrow(/disabled/i);
  });

  it("defaults to disabled", async () => {
    await expect(
      zulipMessageActions.handleAction(
        makeCtx("topic-resolve", { messageId: "1", currentTopic: "t" }),
      ),
    ).rejects.toThrow(/disabled/i);
  });
});

// ---------------------------------------------------------------------------
// describeMessageTool - topic actions
// ---------------------------------------------------------------------------

describe("describeMessageTool - topic actions", () => {
  it("includes topic-edit when enabled", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig({ actions: { topicEdit: true } }),
      accountId: "default",
    });
    expect(result.actions).toContain("topic-edit");
  });

  it("excludes topic-edit when not enabled (defaults disabled)", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig(),
      accountId: "default",
    });
    expect(result.actions).not.toContain("topic-edit");
  });

  it("includes topic-resolve when enabled", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig({ actions: { topicResolve: true } }),
      accountId: "default",
    });
    expect(result.actions).toContain("topic-resolve");
  });

  it("excludes topic-resolve when not enabled (defaults disabled)", () => {
    const result = zulipMessageActions.describeMessageTool({
      cfg: makeConfig(),
      accountId: "default",
    });
    expect(result.actions).not.toContain("topic-resolve");
  });
});
