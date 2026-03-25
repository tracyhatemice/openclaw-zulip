import { describe, it, expect } from "vitest";
import {
  normalizeZulipBaseUrl,
  normalizeStreamName,
  normalizeTopic,
  normalizeEmojiName,
  ensureBlankLineBeforeTables,
} from "./normalize";

describe("normalizeZulipBaseUrl", () => {
  it("returns undefined for undefined", () => {
    expect(normalizeZulipBaseUrl(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(normalizeZulipBaseUrl(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeZulipBaseUrl("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeZulipBaseUrl("   ")).toBeUndefined();
  });

  it("removes a single trailing slash", () => {
    expect(normalizeZulipBaseUrl("https://chat.zulip.org/")).toBe(
      "https://chat.zulip.org",
    );
  });

  it("removes multiple trailing slashes", () => {
    expect(normalizeZulipBaseUrl("https://chat.zulip.org///")).toBe(
      "https://chat.zulip.org",
    );
  });

  it("preserves URL without trailing slash", () => {
    expect(normalizeZulipBaseUrl("https://chat.zulip.org")).toBe(
      "https://chat.zulip.org",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeZulipBaseUrl("  https://chat.zulip.org/  ")).toBe(
      "https://chat.zulip.org",
    );
  });
});

describe("normalizeStreamName", () => {
  it("returns empty string for undefined", () => {
    expect(normalizeStreamName(undefined)).toBe("");
  });

  it("returns empty string for null", () => {
    expect(normalizeStreamName(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizeStreamName("")).toBe("");
  });

  it("strips leading # from stream name", () => {
    expect(normalizeStreamName("#general")).toBe("general");
  });

  it("preserves name without leading #", () => {
    expect(normalizeStreamName("general")).toBe("general");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeStreamName("  general  ")).toBe("general");
  });

  it("handles # with space before name", () => {
    expect(normalizeStreamName("# stream")).toBe(" stream");
  });

  it("strips only the first leading #", () => {
    expect(normalizeStreamName("##double")).toBe("#double");
  });
});

describe("normalizeTopic", () => {
  it("returns empty string for undefined", () => {
    expect(normalizeTopic(undefined)).toBe("");
  });

  it("returns empty string for null", () => {
    expect(normalizeTopic(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizeTopic("")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTopic("  my topic  ")).toBe("my topic");
  });

  it("preserves content as-is beyond trimming", () => {
    expect(normalizeTopic("#special/topic")).toBe("#special/topic");
  });
});

describe("normalizeEmojiName", () => {
  it("returns empty string for undefined", () => {
    expect(normalizeEmojiName(undefined)).toBe("");
  });

  it("returns empty string for null", () => {
    expect(normalizeEmojiName(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizeEmojiName("")).toBe("");
  });

  it("strips leading and trailing colons", () => {
    expect(normalizeEmojiName(":eyes:")).toBe("eyes");
  });

  it("handles name without colons", () => {
    expect(normalizeEmojiName("eyes")).toBe("eyes");
  });

  it("strips only leading colon", () => {
    expect(normalizeEmojiName(":eyes")).toBe("eyes");
  });

  it("strips only trailing colon", () => {
    expect(normalizeEmojiName("eyes:")).toBe("eyes");
  });

  it("trims whitespace around colons", () => {
    expect(normalizeEmojiName("  :thumbs_up:  ")).toBe("thumbs_up");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeEmojiName("   ")).toBe("");
  });
});

describe("ensureBlankLineBeforeTables", () => {
  it("returns content unchanged when there are no tables", () => {
    const content = "Hello world\nThis is a paragraph.\nNo tables here.";
    expect(ensureBlankLineBeforeTables(content)).toBe(content);
  });

  it("inserts a blank line when a table follows text directly", () => {
    const input = "Some text\n| A | B |\n| - | - |\n| 1 | 2 |";
    const expected = "Some text\n\n| A | B |\n| - | - |\n| 1 | 2 |";
    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });

  it("does not insert a blank line when one already exists before the table", () => {
    const content = "Some text\n\n| A | B |\n| - | - |\n| 1 | 2 |";
    expect(ensureBlankLineBeforeTables(content)).toBe(content);
  });

  it("does not insert extra blank lines between consecutive table rows", () => {
    const content = "| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |";
    expect(ensureBlankLineBeforeTables(content)).toBe(content);
  });

  it("does not insert a blank line when the table is at the start of content", () => {
    const content = "| A | B |\n| - | - |\n| 1 | 2 |";
    expect(ensureBlankLineBeforeTables(content)).toBe(content);
  });

  it("does not modify pipe lines inside a backtick fenced code block", () => {
    const content = "Some text\n```\n| not | a | table |\n```\nMore text";
    expect(ensureBlankLineBeforeTables(content)).toBe(content);
  });

  it("does not modify pipe lines inside a tilde fenced code block", () => {
    const content = "Some text\n~~~\n| not | a | table |\n~~~\nMore text";
    expect(ensureBlankLineBeforeTables(content)).toBe(content);
  });

  it("handles multiple tables separated by text", () => {
    const input = [
      "Intro",
      "| A | B |",
      "| - | - |",
      "Middle paragraph",
      "| C | D |",
      "| - | - |",
    ].join("\n");
    const expected = [
      "Intro",
      "",
      "| A | B |",
      "| - | - |",
      "Middle paragraph",
      "",
      "| C | D |",
      "| - | - |",
    ].join("\n");
    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });

  it("inserts a blank line for a table immediately after a code block ends", () => {
    const input = "```\ncode\n```\n| A | B |\n| - | - |";
    const expected = "```\ncode\n```\n\n| A | B |\n| - | - |";
    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });

  it("handles empty input", () => {
    expect(ensureBlankLineBeforeTables("")).toBe("");
  });
});
