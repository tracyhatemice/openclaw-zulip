import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./setup-core.js", () => ({
  ZULIP_URL_HELP_LINES: ["Help line 1"],
  zulipSetupAdapter: {},
}));

vi.mock("./zulip/accounts.js", () => ({
  listZulipAccountIds: vi.fn(() => ["default"]),
  resolveZulipAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    baseUrl: "https://zulip.example",
    email: "bot@test.com",
    apiKey: "test-key",
    streams: [{ streamId: "general", streamPolicy: "open" as const, requireMention: true, allowFrom: [] }],
  })),
}));

vi.mock("./zulip/probe.js", () => ({
  probeZulip: vi.fn(async () => ({
    ok: true,
    bot: { fullName: "TestBot", email: "bot@test.com", userId: 1 },
  })),
}));

vi.mock("openclaw/plugin-sdk/setup", () => ({
  createStandardChannelSetupStatus: vi.fn((opts) => ({ configured: true, ...opts })),
  patchChannelConfigForAccount: vi.fn((params) => params.cfg),
  setSetupChannelEnabled: vi.fn((cfg) => cfg),
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
}));

import { zulipSetupWizard } from "./setup-surface.js";
import { resolveZulipAccount } from "./zulip/accounts.js";
import { patchChannelConfigForAccount } from "openclaw/plugin-sdk/setup";

describe("zulipSetupWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports zulipSetupWizard with channel 'zulip'", () => {
    expect(zulipSetupWizard).toBeDefined();
    expect(zulipSetupWizard.channel).toBe("zulip");
  });

  it("has 3 credentials (url, userId, token)", () => {
    expect(zulipSetupWizard.credentials).toHaveLength(3);
    const keys = zulipSetupWizard.credentials!.map((c: any) => c.inputKey);
    expect(keys).toEqual(["url", "userId", "token"]);
  });

  it("has 1 text input (groupChannels)", () => {
    expect(zulipSetupWizard.textInputs).toHaveLength(1);
    expect(zulipSetupWizard.textInputs![0].inputKey).toBe("groupChannels");
  });

  it("credential inspect returns configured state", () => {
    const urlCred = zulipSetupWizard.credentials![0] as any;
    const result = urlCred.inspect({
      cfg: { channels: { zulip: { baseUrl: "https://zulip.example" } } },
      accountId: "default",
    });
    expect(result.accountConfigured).toBe(true);
    expect(result.hasConfiguredValue).toBe(true);
    expect(resolveZulipAccount).toHaveBeenCalled();
  });

  it("credential applySet patches config", () => {
    const urlCred = zulipSetupWizard.credentials![0] as any;
    const cfg = { channels: { zulip: {} } };
    urlCred.applySet({ cfg, accountId: "default", value: "https://new.zulip.example" });
    expect(patchChannelConfigForAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        channel: "zulip",
        accountId: "default",
        patch: expect.objectContaining({ enabled: true, baseUrl: "https://new.zulip.example" }),
      }),
    );
  });

  it("text input currentValue returns streams", () => {
    const textInput = zulipSetupWizard.textInputs![0] as any;
    const result = textInput.currentValue({
      cfg: { channels: { zulip: { streams: ["general"] } } },
      accountId: "default",
    });
    expect(result).toBe("general");
  });

  it("text input validate rejects empty", () => {
    const textInput = zulipSetupWizard.textInputs![0] as any;
    const error = textInput.validate({ value: "" });
    expect(error).toBeDefined();
    expect(error).toContain("required");
  });

  it("stepOrder is 'credentials-first'", () => {
    expect(zulipSetupWizard.stepOrder).toBe("credentials-first");
  });
});
