import { describe, it, expect } from "vitest";
import { parseZulipTarget, formatZulipStreamTarget } from "./targets";

describe("parseZulipTarget", () => {
  it("returns null for empty string", () => {
    expect(parseZulipTarget("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseZulipTarget("   ")).toBeNull();
  });

  it("returns null when there is no stream: prefix", () => {
    expect(parseZulipTarget("general")).toBeNull();
  });

  it("returns null for stream: with no name after it", () => {
    expect(parseZulipTarget("stream:")).toBeNull();
  });

  it("parses stream:general into a stream target", () => {
    expect(parseZulipTarget("stream:general")).toEqual({
      kind: "stream",
      stream: "general",
    });
  });

  it("parses stream:general#topic into stream and topic", () => {
    expect(parseZulipTarget("stream:general#topic")).toEqual({
      kind: "stream",
      stream: "general",
      topic: "topic",
    });
  });

  it("strips the zulip: prefix before parsing", () => {
    expect(parseZulipTarget("zulip:stream:general#topic")).toEqual({
      kind: "stream",
      stream: "general",
      topic: "topic",
    });
  });

  it("returns null when stream name is only a # (empty after normalization)", () => {
    // "stream:#general" → hashIdx=0, streamRaw="", which normalizes to ""
    // so the parser sees an empty stream name before the # and returns null
    expect(parseZulipTarget("stream:#general")).toBeNull();
  });

  it("omits topic when topic portion is empty after #", () => {
    expect(parseZulipTarget("stream:foo#")).toEqual({
      kind: "stream",
      stream: "foo",
    });
  });

  it("handles case-insensitive Stream: prefix", () => {
    expect(parseZulipTarget("Stream:general")).toEqual({
      kind: "stream",
      stream: "general",
    });
  });

  it("handles case-insensitive ZULIP: prefix", () => {
    expect(parseZulipTarget("ZULIP:stream:general")).toEqual({
      kind: "stream",
      stream: "general",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseZulipTarget("  stream:general#topic  ")).toEqual({
      kind: "stream",
      stream: "general",
      topic: "topic",
    });
  });
});

describe("formatZulipStreamTarget", () => {
  it("formats stream-only target", () => {
    expect(formatZulipStreamTarget({ stream: "general" })).toBe(
      "stream:general",
    );
  });

  it("formats stream and topic target", () => {
    expect(formatZulipStreamTarget({ stream: "general", topic: "greetings" })).toBe(
      "stream:general#greetings",
    );
  });

  it("strips leading # from the stream name in output", () => {
    expect(formatZulipStreamTarget({ stream: "#general" })).toBe(
      "stream:general",
    );
  });
});
