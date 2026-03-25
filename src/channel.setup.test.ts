import { describe, it, expect, vi } from "vitest";

vi.mock("./setup-core.js", () => ({
  zulipSetupAdapter: { detect: vi.fn() },
}));

vi.mock("./setup-surface.js", () => ({
  zulipSetupWizard: { channel: "zulip" },
}));

vi.mock("./shared.js", () => ({
  createZulipPluginBase: vi.fn(() => ({
    channel: "zulip",
    capabilities: { supportsThreads: false },
    config: { schema: {} },
    setup: { detect: vi.fn() },
  })),
}));

import { zulipSetupPlugin } from "./channel.setup.js";

describe("zulipSetupPlugin", () => {
  it("exports zulipSetupPlugin", () => {
    expect(zulipSetupPlugin).toBeDefined();
  });

  it("has capabilities property", () => {
    expect(zulipSetupPlugin.capabilities).not.toBeUndefined();
  });

  it("has config property", () => {
    expect(zulipSetupPlugin.config).not.toBeUndefined();
  });

  it("spreads base properties", () => {
    expect(zulipSetupPlugin).toHaveProperty("setup");
  });

  it("channel is 'zulip'", () => {
    expect(zulipSetupPlugin.channel).toBe("zulip");
  });
});
