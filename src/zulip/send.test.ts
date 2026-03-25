import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  zulipRequestWithRetry: vi.fn(async () => ({ result: "success", id: 42 })),
}));

import { zulipRequestWithRetry } from "./client.js";
import {
  sendZulipStreamMessage,
  sendZulipDirectMessage,
  editZulipStreamMessage,
} from "./send.js";
import type { ZulipAuth } from "./client.js";

const mockRequest = vi.mocked(zulipRequestWithRetry);

const auth: ZulipAuth = {
  baseUrl: "https://chat.example.com",
  email: "bot@example.com",
  apiKey: "test-api-key",
};

beforeEach(() => {
  mockRequest.mockClear();
});

// ---------------------------------------------------------------------------
// sendZulipStreamMessage
// ---------------------------------------------------------------------------
describe("sendZulipStreamMessage", () => {
  it("calls POST /api/v1/messages", async () => {
    await sendZulipStreamMessage({ auth, stream: "general", topic: "greetings", content: "hello" });
    expect(mockRequest).toHaveBeenCalledOnce();
    const call = mockRequest.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v1/messages");
  });

  it("sends type:stream, to, topic, and content as form params", async () => {
    await sendZulipStreamMessage({ auth, stream: "engineering", topic: "deploys", content: "v2 is out" });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form).toEqual({
      type: "stream",
      to: "engineering",
      topic: "deploys",
      content: "v2 is out",
    });
  });

  it("uses maxRetries: 5", async () => {
    await sendZulipStreamMessage({ auth, stream: "s", topic: "t", content: "c" });
    const { retry } = mockRequest.mock.calls[0][0];
    expect(retry.maxRetries).toBe(5);
  });

  it("normalizes content by inserting blank line before tables", async () => {
    const raw = "some text\n| col1 | col2 |\n| --- | --- |";
    await sendZulipStreamMessage({ auth, stream: "s", topic: "t", content: raw });
    const { form } = mockRequest.mock.calls[0][0];
    // ensureBlankLineBeforeTables should insert a blank line between "some text" and the table
    expect(form.content).toBe("some text\n\n| col1 | col2 |\n| --- | --- |");
  });

  it("returns the response including id", async () => {
    const result = await sendZulipStreamMessage({ auth, stream: "s", topic: "t", content: "c" });
    expect(result).toEqual({ result: "success", id: 42 });
  });
});

// ---------------------------------------------------------------------------
// sendZulipDirectMessage
// ---------------------------------------------------------------------------
describe("sendZulipDirectMessage", () => {
  it("sends type:direct", async () => {
    await sendZulipDirectMessage({ auth, to: "user@example.com", content: "hi" });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.type).toBe("direct");
  });

  it("wraps to in a JSON array", async () => {
    await sendZulipDirectMessage({ auth, to: "user@example.com", content: "hi" });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.to).toBe(JSON.stringify(["user@example.com"]));
  });

  it("works with a numeric recipient", async () => {
    await sendZulipDirectMessage({ auth, to: 12345, content: "hi" });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.to).toBe(JSON.stringify([12345]));
  });

  it("normalizes content before sending", async () => {
    const raw = "heading\n| a |\n| - |";
    await sendZulipDirectMessage({ auth, to: 1, content: raw });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.content).toBe("heading\n\n| a |\n| - |");
  });
});

// ---------------------------------------------------------------------------
// editZulipStreamMessage
// ---------------------------------------------------------------------------
describe("editZulipStreamMessage", () => {
  it("sends PATCH method", async () => {
    await editZulipStreamMessage({ auth, messageId: 99, content: "edited" });
    const call = mockRequest.mock.calls[0][0];
    expect(call.method).toBe("PATCH");
  });

  it("includes messageId in the path", async () => {
    await editZulipStreamMessage({ auth, messageId: 777, content: "edited" });
    const call = mockRequest.mock.calls[0][0];
    expect(call.path).toBe("/api/v1/messages/777");
  });

  it("uses maxRetries: 3 (fewer than send)", async () => {
    await editZulipStreamMessage({ auth, messageId: 1, content: "c" });
    const { retry } = mockRequest.mock.calls[0][0];
    expect(retry.maxRetries).toBe(3);
  });
});
