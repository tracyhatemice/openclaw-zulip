import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTopicBinding,
  listTopicBindingsBySessionKey,
  unbindTopicBindingsBySessionKey,
  resolveTopicForSubagent,
} from "./topic-bindings.js";

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    stream: "general",
    topic: "parent-topic",
    sessionKey: "sess-abc12345",
    agentId: "agent-1",
    accountId: "acct-1",
    boundBy: "system" as const,
    targetKind: "subagent" as const,
    ...overrides,
  };
}

// Clean up module-level bindings map between tests by unbinding all
// session keys used in tests.
const usedSessionKeys: string[] = [];

beforeEach(() => {
  for (const sk of usedSessionKeys) {
    unbindTopicBindingsBySessionKey({ targetSessionKey: sk });
  }
  usedSessionKeys.length = 0;
});

function tracked(sessionKey: string): string {
  if (!usedSessionKeys.includes(sessionKey)) {
    usedSessionKeys.push(sessionKey);
  }
  return sessionKey;
}

describe("createTopicBinding", () => {
  it("creates a record with all fields", () => {
    const sk = tracked("create-all-fields");
    const record = createTopicBinding(makeParams({ sessionKey: sk }));

    expect(record.stream).toBe("general");
    expect(record.topic).toBe("parent-topic");
    expect(record.sessionKey).toBe(sk);
    expect(record.agentId).toBe("agent-1");
    expect(record.accountId).toBe("acct-1");
    expect(record.boundBy).toBe("system");
    expect(record.targetKind).toBe("subagent");
  });

  it("sets createdAt to a timestamp", () => {
    const sk = tracked("create-timestamp");
    const before = Date.now();
    const record = createTopicBinding(makeParams({ sessionKey: sk }));
    const after = Date.now();

    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(record.createdAt).toBeLessThanOrEqual(after);
  });

  it("returns the created record", () => {
    const sk = tracked("create-returns");
    const record = createTopicBinding(makeParams({ sessionKey: sk, label: "my-label" }));

    expect(record).toEqual(
      expect.objectContaining({
        sessionKey: sk,
        label: "my-label",
      }),
    );
  });

  it("overwrites existing binding with same sessionKey+accountId", () => {
    const sk = tracked("create-overwrite");
    createTopicBinding(makeParams({ sessionKey: sk, agentId: "agent-old" }));
    const updated = createTopicBinding(makeParams({ sessionKey: sk, agentId: "agent-new" }));

    expect(updated.agentId).toBe("agent-new");

    const found = listTopicBindingsBySessionKey({ targetSessionKey: sk });
    expect(found).toHaveLength(1);
    expect(found[0].agentId).toBe("agent-new");
  });
});

describe("listTopicBindingsBySessionKey", () => {
  it("returns empty array when no bindings", () => {
    const result = listTopicBindingsBySessionKey({ targetSessionKey: "nonexistent" });
    expect(result).toEqual([]);
  });

  it("finds binding by sessionKey", () => {
    const sk = tracked("list-find");
    createTopicBinding(makeParams({ sessionKey: sk }));

    const result = listTopicBindingsBySessionKey({ targetSessionKey: sk });
    expect(result).toHaveLength(1);
    expect(result[0].sessionKey).toBe(sk);
  });

  it("filters by accountId when provided", () => {
    const sk = tracked("list-acct-filter");
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "acct-A" }));
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "acct-B" }));

    const result = listTopicBindingsBySessionKey({
      targetSessionKey: sk,
      accountId: "acct-A",
    });
    expect(result).toHaveLength(1);
    expect(result[0].accountId).toBe("acct-A");
  });

  it("filters by targetKind when provided", () => {
    const sk = tracked("list-kind-filter");
    createTopicBinding(makeParams({ sessionKey: sk }));

    const result = listTopicBindingsBySessionKey({
      targetSessionKey: sk,
      targetKind: "subagent",
    });
    expect(result).toHaveLength(1);

    // There is only one targetKind currently, so filtering by it should still match
    expect(result[0].targetKind).toBe("subagent");
  });

  it("returns all matches when no accountId filter is provided", () => {
    const sk = tracked("list-all-matches");
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "acct-X" }));
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "acct-Y" }));
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "acct-Z" }));

    const result = listTopicBindingsBySessionKey({ targetSessionKey: sk });
    expect(result).toHaveLength(3);
  });
});

describe("unbindTopicBindingsBySessionKey", () => {
  it("removes matching bindings and returns count", () => {
    const sk = tracked("unbind-remove");
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "acct-1" }));
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "acct-2" }));

    const removed = unbindTopicBindingsBySessionKey({ targetSessionKey: sk });
    expect(removed).toBe(2);

    const remaining = listTopicBindingsBySessionKey({ targetSessionKey: sk });
    expect(remaining).toEqual([]);
  });

  it("returns 0 when nothing matches", () => {
    const removed = unbindTopicBindingsBySessionKey({ targetSessionKey: "no-such-key" });
    expect(removed).toBe(0);
  });

  it("filters by accountId when provided", () => {
    const sk = tracked("unbind-acct-filter");
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "keep-me" }));
    createTopicBinding(makeParams({ sessionKey: sk, accountId: "remove-me" }));

    const removed = unbindTopicBindingsBySessionKey({
      targetSessionKey: sk,
      accountId: "remove-me",
    });
    expect(removed).toBe(1);

    const remaining = listTopicBindingsBySessionKey({ targetSessionKey: sk });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].accountId).toBe("keep-me");
  });
});

describe("resolveTopicForSubagent", () => {
  it("uses label when provided", () => {
    const topic = resolveTopicForSubagent({
      stream: "general",
      parentTopic: "parent",
      label: "child-task",
      sessionKey: "sess-12345678abcd",
    });
    expect(topic).toBe("parent / child-task");
  });

  it("falls back to sessionKey prefix when no label", () => {
    const topic = resolveTopicForSubagent({
      stream: "general",
      parentTopic: "parent",
      sessionKey: "abcdef1234567890",
    });
    expect(topic).toBe("parent / abcdef12");
  });

  it("sanitizes label by removing non-alphanumeric characters except space, dash, underscore", () => {
    const topic = resolveTopicForSubagent({
      stream: "general",
      parentTopic: "parent",
      label: "hello@world! foo#bar$baz_qux-123",
      sessionKey: "sess-xxx",
    });
    expect(topic).toBe("parent / helloworld foobarbaz_qux-123");
  });

  it("truncates label to 40 characters", () => {
    const longLabel = "a".repeat(60);
    const topic = resolveTopicForSubagent({
      stream: "general",
      parentTopic: "parent",
      label: longLabel,
      sessionKey: "sess-xxx",
    });
    const suffix = topic.replace("parent / ", "");
    expect(suffix).toHaveLength(40);
  });
});
