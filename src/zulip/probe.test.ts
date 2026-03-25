import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeZulip } from "./probe.js";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

function okResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(status: number, statusText: string, body?: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => JSON.parse(body ?? "{}"),
    text: async () => body ?? "",
  } as unknown as Response;
}

describe("probeZulip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:true with bot info on success", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ result: "success", user_id: 42, email: "bot@zulip.example", full_name: "Test Bot" }),
    );

    const result = await probeZulip("https://zulip.example", "bot@zulip.example", "api-key-123");

    expect(result.ok).toBe(true);
    expect(result.bot).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("extracts user_id, email, full_name from response", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ result: "success", user_id: 99, email: "agent@z.io", full_name: "Agent Smith" }),
    );

    const result = await probeZulip("https://zulip.example", "agent@z.io", "key");

    expect(result.bot).toEqual({ userId: 99, email: "agent@z.io", fullName: "Agent Smith" });
  });

  it('returns ok:false with "invalid baseUrl" for empty URL', async () => {
    const result = await probeZulip("", "bot@z.io", "key");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid baseUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with error message on 401", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, "Unauthorized"));

    const result = await probeZulip("https://zulip.example", "bot@z.io", "bad-key");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unauthorized");
  });

  it("extracts msg from error JSON body", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(401, "Unauthorized", JSON.stringify({ result: "error", msg: "Invalid API key" })),
    );

    const result = await probeZulip("https://zulip.example", "bot@z.io", "bad-key");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid API key");
  });

  it("falls back to statusText when body isn't JSON", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden", "not json at all"));

    const result = await probeZulip("https://zulip.example", "bot@z.io", "key");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Forbidden");
  });

  it('returns ok:false when result !== "success"', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ result: "error", msg: "Something went wrong" }),
    );

    const result = await probeZulip("https://zulip.example", "bot@z.io", "key");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Something went wrong");
  });

  it("returns ok:false with error message on network error", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));

    const result = await probeZulip("https://zulip.example", "bot@z.io", "key");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("fetch failed");
  });

  it("defaults userId to 0, email/fullName to null when missing", async () => {
    fetchMock.mockResolvedValue(okResponse({ result: "success" }));

    const result = await probeZulip("https://zulip.example", "bot@z.io", "key");

    expect(result.ok).toBe(true);
    expect(result.bot).toEqual({ userId: 0, email: null, fullName: null });
  });

  it("calls correct URL (/api/v1/users/me)", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ result: "success", user_id: 1, email: "b@z.io", full_name: "B" }),
    );

    await probeZulip("https://zulip.example/", "b@z.io", "key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://zulip.example/api/v1/users/me");
  });
});
