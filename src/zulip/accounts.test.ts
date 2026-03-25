import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
  resolveZulipTopicBindingFlags,
  listEnabledZulipAccounts,
} from "./accounts";

function makeConfig(zulip?: Record<string, unknown>): OpenClawConfig {
  return { channels: { zulip } } as OpenClawConfig;
}

describe("listZulipAccountIds", () => {
  it("returns ['default'] when no accounts configured", () => {
    expect(listZulipAccountIds(makeConfig())).toEqual(["default"]);
  });

  it("returns account IDs sorted alphabetically", () => {
    const cfg = makeConfig({
      accounts: { zeta: {}, alpha: {}, mid: {} },
    });
    expect(listZulipAccountIds(cfg)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("filters empty keys", () => {
    const cfg = makeConfig({
      accounts: { "": {}, valid: {} },
    });
    expect(listZulipAccountIds(cfg)).toEqual(["valid"]);
  });
});

describe("resolveDefaultZulipAccountId", () => {
  it("returns 'default' when default account exists", () => {
    const cfg = makeConfig({
      accounts: { default: {}, other: {} },
    });
    expect(resolveDefaultZulipAccountId(cfg)).toBe("default");
  });

  it("returns first account alphabetically when no default", () => {
    const cfg = makeConfig({
      accounts: { beta: {}, alpha: {} },
    });
    expect(resolveDefaultZulipAccountId(cfg)).toBe("alpha");
  });
});

describe("resolveZulipAccount", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.ZULIP_URL = process.env.ZULIP_URL;
    savedEnv.ZULIP_EMAIL = process.env.ZULIP_EMAIL;
    savedEnv.ZULIP_API_KEY = process.env.ZULIP_API_KEY;
    delete process.env.ZULIP_URL;
    delete process.env.ZULIP_EMAIL;
    delete process.env.ZULIP_API_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("returns enabled:true by default", () => {
    const result = resolveZulipAccount({ cfg: makeConfig() });
    expect(result.enabled).toBe(true);
  });

  it("returns enabled:false when base zulip disabled", () => {
    const cfg = makeConfig({ enabled: false });
    const result = resolveZulipAccount({ cfg });
    expect(result.enabled).toBe(false);
  });

  it("returns enabled:false when account disabled", () => {
    const cfg = makeConfig({
      accounts: { default: { enabled: false } },
    });
    const result = resolveZulipAccount({ cfg, accountId: "default" });
    expect(result.enabled).toBe(false);
  });

  it("reads baseUrl from config", () => {
    const cfg = makeConfig({
      accounts: { default: { baseUrl: "https://zulip.example.com" } },
    });
    const result = resolveZulipAccount({ cfg, accountId: "default" });
    expect(result.baseUrl).toBe("https://zulip.example.com");
    expect(result.baseUrlSource).toBe("config");
  });

  it("reads email from config", () => {
    const cfg = makeConfig({
      accounts: { default: { email: "bot@example.com" } },
    });
    const result = resolveZulipAccount({ cfg, accountId: "default" });
    expect(result.email).toBe("bot@example.com");
    expect(result.emailSource).toBe("config");
  });

  it("reads apiKey from config", () => {
    const cfg = makeConfig({
      accounts: { default: { apiKey: "secret123" } },
    });
    const result = resolveZulipAccount({ cfg, accountId: "default" });
    expect(result.apiKey).toBe("secret123");
    expect(result.apiKeySource).toBe("config");
  });

  it("falls back to ZULIP_URL env var for default account", () => {
    process.env.ZULIP_URL = "https://env.zulip.org/";
    process.env.ZULIP_EMAIL = "env@example.com";
    process.env.ZULIP_API_KEY = "envkey";
    const result = resolveZulipAccount({ cfg: makeConfig() });
    expect(result.baseUrl).toBe("https://env.zulip.org");
    expect(result.baseUrlSource).toBe("env");
    expect(result.email).toBe("env@example.com");
    expect(result.emailSource).toBe("env");
    expect(result.apiKey).toBe("envkey");
    expect(result.apiKeySource).toBe("env");
  });

  it("does NOT use env vars for non-default accounts", () => {
    process.env.ZULIP_URL = "https://env.zulip.org";
    process.env.ZULIP_EMAIL = "env@example.com";
    process.env.ZULIP_API_KEY = "envkey";
    const cfg = makeConfig({
      accounts: { custom: {} },
    });
    const result = resolveZulipAccount({ cfg, accountId: "custom" });
    expect(result.baseUrl).toBeUndefined();
    expect(result.email).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
    expect(result.baseUrlSource).toBe("none");
    expect(result.emailSource).toBe("none");
    expect(result.apiKeySource).toBe("none");
  });

  it("config takes precedence over env vars", () => {
    process.env.ZULIP_URL = "https://env.zulip.org";
    process.env.ZULIP_EMAIL = "env@example.com";
    process.env.ZULIP_API_KEY = "envkey";
    const cfg = makeConfig({
      accounts: {
        default: {
          baseUrl: "https://config.zulip.org",
          email: "config@example.com",
          apiKey: "configkey",
        },
      },
    });
    const result = resolveZulipAccount({ cfg, accountId: "default" });
    expect(result.baseUrl).toBe("https://config.zulip.org");
    expect(result.baseUrlSource).toBe("config");
    expect(result.email).toBe("config@example.com");
    expect(result.emailSource).toBe("config");
    expect(result.apiKey).toBe("configkey");
    expect(result.apiKeySource).toBe("config");
  });

  it("normalizes stream names (strips #)", () => {
    const cfg = makeConfig({
      accounts: { default: { streams: { "#general": {}, "#random": {} } } },
    });
    const result = resolveZulipAccount({ cfg, accountId: "default" });
    expect(result.streams.map((s) => s.streamId)).toEqual(["general", "random"]);
  });

  it("defaults streamPolicy to allowlist", () => {
    const result = resolveZulipAccount({ cfg: makeConfig() });
    expect(result.streamPolicy).toBe("allowlist");
  });

  it("defaults requireMention to true", () => {
    const result = resolveZulipAccount({ cfg: makeConfig() });
    expect(result.requireMention).toBe(true);
  });

  it("defaults defaultTopic to 'general chat'", () => {
    const result = resolveZulipAccount({ cfg: makeConfig() });
    expect(result.defaultTopic).toBe("general chat");
  });

  it("merges base config with account config (account overrides)", () => {
    const cfg = makeConfig({
      baseUrl: "https://base.zulip.org",
      email: "base@example.com",
      streams: { "#base-stream": {} },
      accounts: {
        default: {
          email: "override@example.com",
          streams: { "#override-stream": {} },
        },
      },
    });
    const result = resolveZulipAccount({ cfg, accountId: "default" });
    // baseUrl comes from base config
    expect(result.baseUrl).toBe("https://base.zulip.org");
    // email overridden by account
    expect(result.email).toBe("override@example.com");
    // streams overridden by account
    expect(result.streams.map((s) => s.streamId)).toEqual(["override-stream"]);
  });
});

describe("resolveZulipTopicBindingFlags", () => {
  it("returns enabled:true by default", () => {
    const result = resolveZulipTopicBindingFlags({ cfg: makeConfig() });
    expect(result.enabled).toBe(true);
  });

  it("account-level overrides base-level", () => {
    const cfg = makeConfig({
      topicBindings: { enabled: true },
      accounts: {
        default: { topicBindings: { enabled: false } },
      },
    });
    const result = resolveZulipTopicBindingFlags({ cfg, accountId: "default" });
    expect(result.enabled).toBe(false);
  });

  it("base-level overrides session-level", () => {
    const cfg = {
      channels: {
        zulip: {
          topicBindings: { enabled: false },
        },
      },
      session: {
        threadBindings: { enabled: true },
      },
    } as OpenClawConfig;
    const result = resolveZulipTopicBindingFlags({ cfg });
    expect(result.enabled).toBe(false);
  });

  it("spawnSubagentSessions defaults to false", () => {
    const result = resolveZulipTopicBindingFlags({ cfg: makeConfig() });
    expect(result.spawnSubagentSessions).toBe(false);
  });
});

describe("listEnabledZulipAccounts", () => {
  it("returns only enabled accounts", () => {
    const cfg = makeConfig({
      accounts: {
        enabled_one: { baseUrl: "https://a.example.com" },
        disabled_one: { enabled: false },
        enabled_two: { baseUrl: "https://b.example.com" },
      },
    });
    const result = listEnabledZulipAccounts(cfg);
    const ids = result.map((a) => a.accountId);
    expect(ids).toEqual(["enabled_one", "enabled_two"]);
  });

  it("returns empty when all disabled", () => {
    const cfg = makeConfig({
      enabled: false,
      accounts: {
        a: {},
        b: {},
      },
    });
    const result = listEnabledZulipAccounts(cfg);
    expect(result).toEqual([]);
  });
});
