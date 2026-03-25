import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  zulipRequest: vi.fn(async () => ({ result: "success" })),
}));

import { zulipRequest } from "./client.js";
import {
  sendZulipDirectTypingStart,
  sendZulipDirectTypingStop,
  sendZulipStreamTypingStart,
  sendZulipStreamTypingStop,
} from "./typing.js";
import type { ZulipAuth } from "./client.js";

const mockRequest = vi.mocked(zulipRequest);

const auth: ZulipAuth = {
  baseUrl: "https://chat.example.com",
  email: "bot@example.com",
  apiKey: "test-api-key",
};

beforeEach(() => {
  mockRequest.mockClear();
  mockRequest.mockResolvedValue({ result: "success" });
});

// ---------------------------------------------------------------------------
// sendZulipDirectTypingStart
// ---------------------------------------------------------------------------
describe("sendZulipDirectTypingStart", () => {
  it("sends type:direct with user IDs", async () => {
    await sendZulipDirectTypingStart({ auth, to: [10, 20] });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.type).toBe("direct");
  });

  it("sends to as a JSON array of IDs", async () => {
    await sendZulipDirectTypingStart({ auth, to: [10, 20] });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.to).toBe(JSON.stringify([10, 20]));
  });
});

// ---------------------------------------------------------------------------
// sendZulipDirectTypingStop
// ---------------------------------------------------------------------------
describe("sendZulipDirectTypingStop", () => {
  it("sends op:stop with type:direct", async () => {
    await sendZulipDirectTypingStop({ auth, to: [10, 20] });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.op).toBe("stop");
    expect(form.type).toBe("direct");
  });

  it("sends to as a JSON array of IDs", async () => {
    await sendZulipDirectTypingStop({ auth, to: [10, 20] });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.to).toBe(JSON.stringify([10, 20]));
  });
});

// ---------------------------------------------------------------------------
// sendZulipStreamTypingStart
// ---------------------------------------------------------------------------
describe("sendZulipStreamTypingStart", () => {
  it("sends stream_id (integer) instead of to", async () => {
    await sendZulipStreamTypingStart({ auth, streamId: 42, topic: "release" });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.stream_id).toBe(42);
    expect(form).not.toHaveProperty("to");
  });

  it("sends op:start with type:stream", async () => {
    await sendZulipStreamTypingStart({ auth, streamId: 42, topic: "release" });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.op).toBe("start");
    expect(form.type).toBe("stream");
  });

  it("includes topic in form params", async () => {
    await sendZulipStreamTypingStart({ auth, streamId: 42, topic: "release" });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.topic).toBe("release");
  });
});

// ---------------------------------------------------------------------------
// sendZulipStreamTypingStop
// ---------------------------------------------------------------------------
describe("sendZulipStreamTypingStop", () => {
  it("sends stream_id with op:stop", async () => {
    await sendZulipStreamTypingStop({ auth, streamId: 42, topic: "release" });
    const { form } = mockRequest.mock.calls[0][0];
    expect(form.stream_id).toBe(42);
    expect(form.op).toBe("stop");
  });
});

// ---------------------------------------------------------------------------
// Error handling (best-effort)
// ---------------------------------------------------------------------------
describe("error handling", () => {
  it("does not throw when zulipRequest throws", async () => {
    mockRequest.mockRejectedValue(new Error("network failure"));

    await expect(sendZulipDirectTypingStart({ auth, to: [1] })).resolves.toBeUndefined();
    await expect(sendZulipDirectTypingStop({ auth, to: [1] })).resolves.toBeUndefined();
    await expect(sendZulipStreamTypingStart({ auth, streamId: 1, topic: "t" })).resolves.toBeUndefined();
    await expect(sendZulipStreamTypingStop({ auth, streamId: 1, topic: "t" })).resolves.toBeUndefined();
  });

  it("all functions return void (undefined)", async () => {
    const results = await Promise.all([
      sendZulipDirectTypingStart({ auth, to: [1] }),
      sendZulipDirectTypingStop({ auth, to: [1] }),
      sendZulipStreamTypingStart({ auth, streamId: 1, topic: "t" }),
      sendZulipStreamTypingStop({ auth, streamId: 1, topic: "t" }),
    ]);
    for (const r of results) {
      expect(r).toBeUndefined();
    }
  });
});
