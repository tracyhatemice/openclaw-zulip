import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/core";
import type {
  ZulipAccountConfig,
  ZulipReactionConfig,
  ZulipStreamEntryConfig,
  ZulipStreamPolicy,
  ZulipTopicBindingsConfig,
} from "../types.js";
import { normalizeEmojiName, normalizeStreamName, normalizeTopic } from "./normalize.js";

export type ZulipTokenSource = "env" | "config" | "none";
export type ZulipBaseUrlSource = "env" | "config" | "none";
export type ZulipEmailSource = "env" | "config" | "none";

export type ZulipReactionWorkflowStage =
  | "queued"
  | "processing"
  | "toolRunning"
  | "retrying"
  | "success"
  | "partialSuccess"
  | "failure";

export type ResolvedZulipReactionWorkflow = {
  enabled: boolean;
  replaceStageReaction: boolean;
  minTransitionMs: number;
  stages: {
    queued?: string;
    processing?: string;
    toolRunning?: string;
    retrying?: string;
    success: string;
    partialSuccess?: string;
    failure: string;
  };
};

export type ResolvedZulipGenericReactionCallback = {
  enabled: boolean;
  includeRemoveOps: boolean;
};

export type ResolvedZulipReactions = {
  enabled: boolean;
  onStart: string;
  onSuccess: string;
  onFailure: string;
  clearOnFinish: boolean;
  workflow: ResolvedZulipReactionWorkflow;
  genericCallback: ResolvedZulipGenericReactionCallback;
};

export type ResolvedZulipStreamEntry = {
  streamId: string;
  streamPolicy: ZulipStreamPolicy;
  requireMention: boolean;
  allowFrom: string[];
};

export type ResolvedZulipAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl?: string;
  email?: string;
  apiKey?: string;
  baseUrlSource: ZulipBaseUrlSource;
  emailSource: ZulipEmailSource;
  apiKeySource: ZulipTokenSource;
  streamPolicy: ZulipStreamPolicy;
  streams: ResolvedZulipStreamEntry[];
  requireMention: boolean;
  defaultTopic: string;
  reactions: ResolvedZulipReactions;
  textChunkLimit: number;
  keepaliveMessage: boolean;
  groupDmEnabled: boolean;
  config: ZulipAccountConfig;
};

const DEFAULT_TOPIC = "general chat";
const DEFAULT_TEXT_CHUNK_LIMIT = 10_000;

const DEFAULT_REACTIONS: ResolvedZulipReactions = {
  enabled: true,
  onStart: "eyes",
  onSuccess: "check",
  onFailure: "warning",
  clearOnFinish: true,
  workflow: {
    enabled: true,
    replaceStageReaction: true,
    minTransitionMs: 1500,
    stages: {
      queued: "eyes",
      processing: "eyes",
      success: "check",
      partialSuccess: "warning",
      failure: "warning",
    },
  },
  genericCallback: {
    enabled: false,
    includeRemoveOps: false,
  },
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.zulip?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listZulipAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultZulipAccountId(cfg: OpenClawConfig): string {
  const ids = listZulipAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZulipAccountConfig | undefined {
  const accounts = cfg.channels?.zulip?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZulipAccountConfig | undefined;
}

function mergeZulipAccountConfig(cfg: OpenClawConfig, accountId: string): ZulipAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.zulip ?? {}) as ZulipAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function normalizeAllowFromEntries(entries?: (string | number)[]): string[] {
  if (!entries) return [];
  return entries.map((e) => String(e).trim()).filter(Boolean);
}

function resolveStreamEntries(
  raw: Record<string, ZulipStreamEntryConfig> | undefined,
  accountStreamPolicy: ZulipStreamPolicy,
  accountRequireMention: boolean,
): ResolvedZulipStreamEntry[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw)
    .filter(([key]) => key.trim())
    .map(([key, entry]) => {
      const streamId = normalizeStreamName(key) || key.trim();
      const cfg = entry ?? {};
      return {
        streamId,
        streamPolicy: cfg.streamPolicy ?? accountStreamPolicy,
        requireMention: cfg.requireMention ?? accountRequireMention,
        allowFrom: normalizeAllowFromEntries(cfg.allowFrom),
      };
    });
}

function resolveWorkflowMinTransitionMs(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_REACTIONS.workflow.minTransitionMs;
  }
  return Math.floor(raw);
}

function resolveReactions(config: ZulipReactionConfig | undefined): ResolvedZulipReactions {
  if (!config) {
    return DEFAULT_REACTIONS;
  }
  const enabled = config.enabled !== false;
  const onStart = normalizeEmojiName(config.onStart) || DEFAULT_REACTIONS.onStart;
  const onSuccess = normalizeEmojiName(config.onSuccess) || DEFAULT_REACTIONS.onSuccess;
  const onFailure = normalizeEmojiName(config.onFailure) || DEFAULT_REACTIONS.onFailure;
  const clearOnFinish = config.clearOnFinish !== false;

  const workflowStages = config.workflow?.stages;
  const workflow = {
    enabled: config.workflow?.enabled === true,
    replaceStageReaction: config.workflow?.replaceStageReaction !== false,
    minTransitionMs: resolveWorkflowMinTransitionMs(config.workflow?.minTransitionMs),
    stages: {
      queued: normalizeEmojiName(workflowStages?.queued) || onStart,
      processing: normalizeEmojiName(workflowStages?.processing) || onStart,
      toolRunning: normalizeEmojiName(workflowStages?.toolRunning) || undefined,
      retrying: normalizeEmojiName(workflowStages?.retrying) || undefined,
      success: normalizeEmojiName(workflowStages?.success) || onSuccess,
      partialSuccess: normalizeEmojiName(workflowStages?.partialSuccess) || onFailure,
      failure: normalizeEmojiName(workflowStages?.failure) || onFailure,
    },
  } satisfies ResolvedZulipReactionWorkflow;

  const genericCallback = {
    enabled: config.genericCallback?.enabled === true,
    includeRemoveOps: config.genericCallback?.includeRemoveOps === true,
  } satisfies ResolvedZulipGenericReactionCallback;

  return { enabled, onStart, onSuccess, onFailure, clearOnFinish, workflow, genericCallback };
}

export function resolveZulipAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZulipAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.zulip?.enabled !== false;
  const merged = mergeZulipAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envUrl = allowEnv ? process.env.ZULIP_URL?.trim() : undefined;
  const envEmail = allowEnv ? process.env.ZULIP_EMAIL?.trim() : undefined;
  const envKey = allowEnv ? process.env.ZULIP_API_KEY?.trim() : undefined;

  const configUrl = merged.baseUrl?.trim();
  const configEmail = merged.email?.trim();
  const configKey = merged.apiKey?.trim();

  const baseUrl = (configUrl || envUrl)?.replace(/\/+$/, "") || undefined;
  const email = configEmail || envEmail || undefined;
  const apiKey = configKey || envKey || undefined;

  const baseUrlSource: ZulipBaseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";
  const emailSource: ZulipEmailSource = configEmail ? "config" : envEmail ? "env" : "none";
  const apiKeySource: ZulipTokenSource = configKey ? "config" : envKey ? "env" : "none";

  const streamPolicy: ZulipStreamPolicy = merged.streamPolicy ?? "allowlist";
  const requireMention = merged.requireMention !== false;
  const streams = resolveStreamEntries(merged.streams, streamPolicy, requireMention);
  const defaultTopic = normalizeTopic(merged.defaultTopic) || DEFAULT_TOPIC;
  const reactions = resolveReactions(merged.reactions);
  const textChunkLimit =
    typeof merged.textChunkLimit === "number" ? merged.textChunkLimit : DEFAULT_TEXT_CHUNK_LIMIT;
  const keepaliveMessage = merged.keepaliveMessage !== false;
  const groupDmEnabled = merged.dm?.groupDm?.enabled === true;

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    baseUrl,
    email,
    apiKey,
    baseUrlSource,
    emailSource,
    apiKeySource,
    streamPolicy,
    streams,
    requireMention,
    defaultTopic,
    reactions,
    textChunkLimit,
    keepaliveMessage,
    groupDmEnabled,
    config: merged,
  };
}

export function resolveZulipTopicBindingFlags(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): { enabled: boolean; spawnSubagentSessions: boolean } {
  const account = resolveZulipAccount(params);
  // Single cast location — Zulip plugin config isn't on the SDK's OpenClawConfig type
  const zulipCfg = params.cfg.channels?.zulip as Record<string, unknown> | undefined;
  const baseBindings = zulipCfg?.topicBindings as ZulipTopicBindingsConfig | undefined;
  const accountBindings = (
    zulipCfg?.accounts as Record<string, Record<string, unknown>> | undefined
  )?.[account.accountId]?.topicBindings as ZulipTopicBindingsConfig | undefined;
  const sessionBindings = (params.cfg.session as Record<string, unknown> | undefined)
    ?.threadBindings as { enabled?: boolean } | undefined;
  return {
    enabled:
      accountBindings?.enabled ?? baseBindings?.enabled ?? sessionBindings?.enabled ?? true,
    spawnSubagentSessions:
      accountBindings?.spawnSubagentSessions ??
      baseBindings?.spawnSubagentSessions ??
      false,
  };
}

export function listEnabledZulipAccounts(cfg: OpenClawConfig): ResolvedZulipAccount[] {
  return listZulipAccountIds(cfg)
    .map((accountId) => resolveZulipAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
