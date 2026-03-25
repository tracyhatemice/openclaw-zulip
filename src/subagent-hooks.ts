import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveZulipTopicBindingFlags } from "./zulip/accounts.js";
import {
  createTopicBinding,
  listTopicBindingsBySessionKey,
  resolveTopicForSubagent,
  unbindTopicBindingsBySessionKey,
} from "./zulip/topic-bindings.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "error";
}

export function registerZulipSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "zulip") {
      return;
    }
    const flags = resolveZulipTopicBindingFlags({
      cfg: api.config,
      accountId: event.requester?.accountId,
    });
    if (!flags.enabled) {
      return {
        status: "error" as const,
        error:
          "Zulip topic bindings are disabled (set channels.zulip.topicBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
      };
    }
    if (!flags.spawnSubagentSessions) {
      return {
        status: "error" as const,
        error:
          "Zulip topic-bound subagent spawns are disabled for this account (set channels.zulip.topicBindings.spawnSubagentSessions=true to enable).",
      };
    }
    try {
      const to = event.requester?.to ?? "";
      // Parse stream:topic from the requester's target
      const streamMatch = to.match(/^(?:stream:)?([^#]+)(?:#(.*))?$/i);
      if (!streamMatch) {
        return {
          status: "error" as const,
          error: `Unable to parse Zulip target for topic binding: ${to}`,
        };
      }
      const stream = streamMatch[1]!.trim();
      const parentTopic = streamMatch[2]?.trim() || "general chat";

      const topic = resolveTopicForSubagent({
        stream,
        parentTopic,
        label: event.label,
        sessionKey: event.childSessionKey,
      });

      const binding = createTopicBinding({
        stream,
        topic,
        sessionKey: event.childSessionKey,
        agentId: event.agentId,
        accountId: event.requester?.accountId ?? "default",
        label: event.label,
        boundBy: "system",
        targetKind: "subagent",
      });

      if (!binding) {
        return {
          status: "error" as const,
          error:
            "Unable to create a Zulip topic binding for this subagent session.",
        };
      }
      return { status: "ok" as const, threadBindingReady: true };
    } catch (err) {
      return {
        status: "error" as const,
        error: `Zulip topic bind failed: ${summarizeError(err)}`,
      };
    }
  });

  api.on("subagent_ended", (event) => {
    unbindTopicBindingsBySessionKey({
      targetSessionKey: event.targetSessionKey,
      accountId: event.accountId,
      targetKind: event.targetKind as "subagent" | undefined,
      reason: event.reason,
    });
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "zulip") {
      return;
    }
    const requesterAccountId = event.requesterOrigin?.accountId?.trim();
    const bindings = listTopicBindingsBySessionKey({
      targetSessionKey: event.childSessionKey,
      ...(requesterAccountId ? { accountId: requesterAccountId } : {}),
      targetKind: "subagent",
    });
    if (bindings.length === 0) {
      return;
    }

    const binding = bindings[0];
    if (!binding) {
      return;
    }
    return {
      origin: {
        channel: "zulip",
        accountId: binding.accountId,
        to: `stream:${binding.stream}#${binding.topic}`,
      },
    };
  });
}
