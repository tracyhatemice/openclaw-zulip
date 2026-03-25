import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zulipRequest, zulipRequestWithRetry } from "./client.js";
import type { ZulipAuth, ZulipHttpError } from "./client.js";

const mockAuth: ZulipAuth = {
  baseUrl: "https://zulip.example",
  email: "bot@test.com",
  apiKey: "test-key",
};

function mockResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("zulipRequest", () => {
  it("constructs correct URL from baseUrl + path", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { result: "success" }));

    await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });

    const calledUrl = mockFetch.mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toBe("https://zulip.example/api/v1/messages");
  });

  it("adds query parameters to URL", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { result: "success" }));

    await zulipRequest({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      query: { num_before: 10, num_after: 5 },
    });

    const calledUrl = mockFetch.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get("num_before")).toBe("10");
    expect(calledUrl.searchParams.get("num_after")).toBe("5");
  });

  it("skips undefined query values", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { result: "success" }));

    await zulipRequest({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      query: { anchor: "newest", num_before: undefined },
    });

    const calledUrl = mockFetch.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get("anchor")).toBe("newest");
    expect(calledUrl.searchParams.has("num_before")).toBe(false);
  });

  it("sends Authorization header with Base64 email:apiKey", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { result: "success" }));

    await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });

    const expectedToken = Buffer.from("bot@test.com:test-key", "utf8").toString("base64");
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect((options.headers as Record<string, string>).Authorization).toBe(
      `Basic ${expectedToken}`,
    );
  });

  it("sends form data as URL-encoded body with Content-Type header", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { result: "success" }));

    await zulipRequest({
      auth: mockAuth,
      method: "POST",
      path: "/api/v1/messages",
      form: { type: "stream", to: "general", content: "hello" },
    });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const bodyParams = new URLSearchParams(options.body as string);
    expect(bodyParams.get("type")).toBe("stream");
    expect(bodyParams.get("to")).toBe("general");
    expect(bodyParams.get("content")).toBe("hello");
  });

  it("skips undefined form values", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { result: "success" }));

    await zulipRequest({
      auth: mockAuth,
      method: "POST",
      path: "/api/v1/messages",
      form: { type: "stream", topic: undefined },
    });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const bodyParams = new URLSearchParams(options.body as string);
    expect(bodyParams.get("type")).toBe("stream");
    expect(bodyParams.has("topic")).toBe(false);
  });

  it('throws "Missing Zulip baseUrl" for empty baseUrl', async () => {
    await expect(
      zulipRequest({
        auth: { baseUrl: "", email: "bot@test.com", apiKey: "key" },
        method: "GET",
        path: "/api/v1/messages",
      }),
    ).rejects.toThrow("Missing Zulip baseUrl");
  });

  it("returns parsed JSON on 200 response", async () => {
    const responseBody = { result: "success", messages: [{ id: 1 }] };
    mockFetch.mockResolvedValue(mockResponse(200, responseBody));

    const data = await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });

    expect(data).toEqual(responseBody);
  });

  it("throws ZulipHttpError on 400 with msg from response body", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(400, { result: "error", msg: "Invalid request" }),
    );

    try {
      await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Invalid request");
      expect((err as Error).message).toContain("400");
    }
  });

  it("sets status on ZulipHttpError", async () => {
    mockFetch.mockResolvedValue(mockResponse(403, { result: "error", msg: "Forbidden" }));

    try {
      await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ZulipHttpError).status).toBe(403);
    }
  });

  it("parses retry-after header into retryAfterMs (seconds to ms)", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(429, { result: "error", msg: "Rate limited" }, { "retry-after": "2.5" }),
    );

    try {
      await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ZulipHttpError).retryAfterMs).toBe(2500);
    }
  });

  it("handles missing retry-after header (retryAfterMs undefined)", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(500, { result: "error", msg: "Server error" }),
    );

    try {
      await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ZulipHttpError).retryAfterMs).toBeUndefined();
    }
  });

  it("handles empty response body (readJson returns {})", async () => {
    const emptyRes = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: async () => "",
      json: async () => ({}),
    } as Response;
    mockFetch.mockResolvedValue(emptyRes);

    const data = await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });

    expect(data).toEqual({});
  });

  it("handles invalid JSON response body", async () => {
    const badRes = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers(),
      text: async () => "<html>Bad Gateway</html>",
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response;
    mockFetch.mockResolvedValue(badRes);

    try {
      await zulipRequest({ auth: mockAuth, method: "GET", path: "/api/v1/messages" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Invalid JSON response");
    }
  });

  it("passes abort signal to fetch", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { result: "success" }));
    const controller = new AbortController();

    await zulipRequest({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      abortSignal: controller.signal,
    });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.signal).toBe(controller.signal);
  });
});

describe("zulipRequestWithRetry", () => {
  it("returns on first success", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { result: "success" }));

    const data = await zulipRequestWithRetry({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
    });

    expect(data).toEqual({ result: "success" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 status", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    mockFetch
      .mockResolvedValueOnce(mockResponse(429, { result: "error", msg: "Rate limited" }))
      .mockResolvedValueOnce(mockResponse(200, { result: "success" }));

    const promise = zulipRequestWithRetry({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      retry: { baseDelayMs: 100, maxDelayMs: 5000 },
    });

    await vi.advanceTimersByTimeAsync(200);

    const data = await promise;
    expect(data).toEqual({ result: "success" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 502 status", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    mockFetch
      .mockResolvedValueOnce(mockResponse(502, { result: "error", msg: "Bad Gateway" }))
      .mockResolvedValueOnce(mockResponse(200, { result: "success" }));

    const promise = zulipRequestWithRetry({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      retry: { baseDelayMs: 100, maxDelayMs: 5000 },
    });

    await vi.advanceTimersByTimeAsync(200);

    const data = await promise;
    expect(data).toEqual({ result: "success" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 status", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    mockFetch
      .mockResolvedValueOnce(mockResponse(503, { result: "error", msg: "Unavailable" }))
      .mockResolvedValueOnce(mockResponse(200, { result: "success" }));

    const promise = zulipRequestWithRetry({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      retry: { baseDelayMs: 100, maxDelayMs: 5000 },
    });

    await vi.advanceTimersByTimeAsync(200);

    const data = await promise;
    expect(data).toEqual({ result: "success" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 504 status", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    mockFetch
      .mockResolvedValueOnce(mockResponse(504, { result: "error", msg: "Gateway Timeout" }))
      .mockResolvedValueOnce(mockResponse(200, { result: "success" }));

    const promise = zulipRequestWithRetry({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      retry: { baseDelayMs: 100, maxDelayMs: 5000 },
    });

    await vi.advanceTimersByTimeAsync(200);

    const data = await promise;
    expect(data).toEqual({ result: "success" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 400 status (throws immediately)", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(400, { result: "error", msg: "Bad request" }),
    );

    await expect(
      zulipRequestWithRetry({
        auth: mockAuth,
        method: "GET",
        path: "/api/v1/messages",
      }),
    ).rejects.toThrow("Bad request");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401 status (throws immediately)", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(401, { result: "error", msg: "Unauthorized" }),
    );

    await expect(
      zulipRequestWithRetry({
        auth: mockAuth,
        method: "GET",
        path: "/api/v1/messages",
      }),
    ).rejects.toThrow("Unauthorized");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws after maxRetries exceeded", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    mockFetch.mockResolvedValue(
      mockResponse(429, { result: "error", msg: "Rate limited" }),
    );

    const promise = zulipRequestWithRetry({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 5000 },
    }).catch((err: Error) => err);

    // Advance through attempt 0 delay (100ms) and attempt 1 delay (200ms)
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Rate limited");
    // 1 initial + 2 retries = 3
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("uses default maxRetries of 4", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    mockFetch.mockResolvedValue(
      mockResponse(503, { result: "error", msg: "Unavailable" }),
    );

    const promise = zulipRequestWithRetry({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      retry: { baseDelayMs: 100, maxDelayMs: 5000 },
    }).catch((err: Error) => err);

    // Advance enough time for all retries to complete
    // attempt 0: 100ms, attempt 1: 200ms, attempt 2: 400ms, attempt 3: 800ms
    await vi.advanceTimersByTimeAsync(20_000);

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Unavailable");
    // 1 initial + 4 retries = 5
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("respects custom retry config", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    mockFetch
      .mockResolvedValueOnce(mockResponse(429, { result: "error", msg: "Rate limited" }))
      .mockResolvedValueOnce(mockResponse(429, { result: "error", msg: "Rate limited" }))
      .mockResolvedValueOnce(mockResponse(200, { result: "success" }));

    const promise = zulipRequestWithRetry({
      auth: mockAuth,
      method: "GET",
      path: "/api/v1/messages",
      retry: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 1000 },
    });

    // attempt 0 delay: 50ms, attempt 1 delay: 100ms
    await vi.advanceTimersByTimeAsync(300);

    const data = await promise;
    expect(data).toEqual({ result: "success" });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
