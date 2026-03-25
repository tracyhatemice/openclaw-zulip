export type ZulipReactionWorkflowStageConfig = {
  queued?: string;
  processing?: string;
  toolRunning?: string;
  retrying?: string;
  success?: string;
  partialSuccess?: string;
  failure?: string;
};

export type ZulipReactionWorkflowConfig = {
  /** Enable stage-based workflow reactions. Defaults to false for backward compatibility. */
  enabled?: boolean;
  /** Remove previous stage emoji before posting the next stage emoji. Defaults to true. */
  replaceStageReaction?: boolean;
  /** Minimum delay between stage transitions in milliseconds. Defaults to 1500ms. */
  minTransitionMs?: number;
  /** Emoji mapping by workflow stage. */
  stages?: ZulipReactionWorkflowStageConfig;
};

export type ZulipGenericReactionCallbackConfig = {
  /**
   * Enable synthetic callbacks for non-button reactions.
   * Defaults to false to keep existing behavior unchanged.
   */
  enabled?: boolean;
  /**
   * Include reaction removal events (`op: "remove"`).
   * Defaults to false to avoid noise/loops.
   */
  includeRemoveOps?: boolean;
};

export type ZulipReactionConfig = {
  enabled?: boolean;
  onStart?: string;
  onSuccess?: string;
  onFailure?: string;
  /**
   * Whether to remove the `onStart` reaction after responding (default: true).
   * Set to false to leave the `onStart` reaction (e.g. ":eyes:") on the message.
   */
  clearOnFinish?: boolean;
  /**
   * Optional stage-based reactions for richer status signaling.
   * Disabled by default so legacy behavior remains unchanged.
   */
  workflow?: ZulipReactionWorkflowConfig;
  /**
   * Optional synthetic callback path for non-button reactions.
   * Disabled by default for safety.
   */
  genericCallback?: ZulipGenericReactionCallbackConfig;
};

export type ZulipDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

export type ZulipStreamPolicy = "open" | "allowlist" | "disabled";

export type ZulipGroupDmConfig = {
  /** Enable group DM (huddle) support. Default: false. */
  enabled?: boolean;
};

export type ZulipDmConfig = {
  /** DM policy. Default: "pairing". */
  policy?: ZulipDmPolicy;
  /** Sender IDs allowed to DM (integers). "open" requires ["*"]. */
  allowFrom?: (string | number)[];
  /** Group DM config. Inherits DM policy for sender auth. */
  groupDm?: ZulipGroupDmConfig;
};

export type ZulipStreamEntryConfig = {
  /** Per-stream policy override. Inherits from account-level streamPolicy if unset. */
  streamPolicy?: ZulipStreamPolicy;
  /** Per-stream requireMention override. Default: true. */
  requireMention?: boolean;
  /** Per-stream sender allowlist (sender_id integers). */
  allowFrom?: (string | number)[];
};

export type ZulipTopicBindingsConfig = {
  /** Enable topic-based thread bindings for subagent sessions. */
  enabled?: boolean;
  /** Allow subagent spawning to create dedicated topics. */
  spawnSubagentSessions?: boolean;
};

export type ZulipAccountConfig = {
  name?: string;
  enabled?: boolean;
  configWrites?: boolean;

  baseUrl?: string;
  email?: string;
  apiKey?: string;

  /** Stream access policy. Default: "allowlist". */
  streamPolicy?: ZulipStreamPolicy;
  /** Stream allowlist. Record<streamId|"*", StreamEntryConfig>. */
  streams?: Record<string, ZulipStreamEntryConfig>;

  /**
   * Default topic when target omits a topic.
   */
  defaultTopic?: string;

  /** Direct message configuration. */
  dm?: ZulipDmConfig;

  /** Topic binding configuration for subagent sessions. */
  topicBindings?: ZulipTopicBindingsConfig;

  /** Reaction indicators while responding. */
  reactions?: ZulipReactionConfig;

  /** Maximum chars before chunking. */
  textChunkLimit?: number;

  /** Maximum inbound/outbound media size in MB (default: 5MB). */
  mediaMaxMb?: number;

  /**
   * Require @mention to respond in streams (default: true).
   * When true, the bot only replies when mentioned by name or @-syntax.
   */
  requireMention?: boolean;
};
