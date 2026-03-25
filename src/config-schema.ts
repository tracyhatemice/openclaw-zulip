import { z } from "zod";

const ReactionWorkflowStagesSchema = z
  .object({
    queued: z.string().optional(),
    processing: z.string().optional(),
    toolRunning: z.string().optional(),
    retrying: z.string().optional(),
    success: z.string().optional(),
    partialSuccess: z.string().optional(),
    failure: z.string().optional(),
  })
  .strict();

const ReactionWorkflowSchema = z
  .object({
    enabled: z.boolean().optional(),
    replaceStageReaction: z.boolean().optional(),
    minTransitionMs: z.number().int().nonnegative().optional(),
    stages: ReactionWorkflowStagesSchema.optional(),
  })
  .strict();

const GenericReactionCallbackSchema = z
  .object({
    enabled: z.boolean().optional(),
    includeRemoveOps: z.boolean().optional(),
  })
  .strict();

const ReactionSchema = z
  .object({
    enabled: z.boolean().optional(),
    onStart: z.string().optional(),
    onSuccess: z.string().optional(),
    onFailure: z.string().optional(),
    clearOnFinish: z.boolean().optional(),
    workflow: ReactionWorkflowSchema.optional(),
    genericCallback: GenericReactionCallbackSchema.optional(),
  })
  .strict();

const DmSchema = z
  .object({
    policy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
  })
  .strict();

const TopicBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    spawnSubagentSessions: z.boolean().optional(),
  })
  .strict();

const ActionsSchema = z
  .object({
    channelCreate: z.boolean().optional(),
    channelEdit: z.boolean().optional(),
    channelDelete: z.boolean().optional(),
    memberInfo: z.boolean().optional(),
    search: z.boolean().optional(),
    edit: z.boolean().optional(),
    delete: z.boolean().optional(),
  })
  .strict();

const ZulipAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    baseUrl: z.string().optional(),
    email: z.string().optional(),
    apiKey: z.string().optional(),
    streams: z.array(z.string()).optional(),
    alwaysReply: z.boolean().optional(),
    defaultTopic: z.string().optional(),
    dm: DmSchema.optional(),
    topicBindings: TopicBindingsSchema.optional(),
    actions: ActionsSchema.optional(),
    reactions: ReactionSchema.optional(),
    textChunkLimit: z.number().int().positive().optional(),
    mediaMaxMb: z.number().int().positive().optional(),
  })
  .strict();

export const ZulipConfigSchema = ZulipAccountSchemaBase.extend({
  accounts: z.record(z.string(), ZulipAccountSchemaBase.optional()).optional(),
}).strict();
