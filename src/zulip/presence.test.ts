import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  zulipRequest: vi.fn(async () => ({ result: "success" })),
}));

import type { ZulipAuth } from "./client.js";
import { zulipRequest } from "./client.js";
import { getZulipRealmPresence, getZulipUserPresence, setZulipPresence } from "./presence.js";

function makeAuth(): ZulipAuth {
  return {
    baseUrl: "https://zulip.example",
    email: "bot@zulip.example",
    apiKey: "test-api-key",
  };
}

describe("setZulipPresence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls POST /api/v1/users/me/presence with status form param", async () => {
    await setZulipPresence({ auth: makeAuth(), status: "active" });

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/users/me/presence",
        form: { status: "active" },
      }),
    );
  });

  it('sends "active" status', async () => {
    await setZulipPresence({ auth: makeAuth(), status: "active" });

    const call = vi.mocked(zulipRequest).mock.calls[0][0];
    expect(call.form).toEqual({ status: "active" });
  });

  it('sends "idle" status', async () => {
    await setZulipPresence({ auth: makeAuth(), status: "idle" });

    const call = vi.mocked(zulipRequest).mock.calls[0][0];
    expect(call.form).toEqual({ status: "idle" });
  });

  it("swallows errors and does not throw", async () => {
    vi.mocked(zulipRequest).mockRejectedValueOnce(new Error("network failure"));

    await expect(setZulipPresence({ auth: makeAuth(), status: "active" })).resolves.toBeUndefined();
  });
});

describe("getZulipRealmPresence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls GET /api/v1/realm/presence", async () => {
    await getZulipRealmPresence({ auth: makeAuth() });

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/realm/presence",
      }),
    );
  });

  it("returns the response data", async () => {
    const payload = { result: "success", presences: { "user@z.io": { aggregated: { status: "active" } } } };
    vi.mocked(zulipRequest).mockResolvedValueOnce(payload);

    const result = await getZulipRealmPresence({ auth: makeAuth() });

    expect(result).toEqual(payload);
  });
});

describe("getZulipUserPresence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls GET with userId in path", async () => {
    await getZulipUserPresence({ auth: makeAuth(), userId: 42 });

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/users/42/presence",
      }),
    );
  });

  it("encodes userId in path", async () => {
    await getZulipUserPresence({ auth: makeAuth(), userId: "user@example.com" });

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/v1/users/user%40example.com/presence",
      }),
    );
  });
});
