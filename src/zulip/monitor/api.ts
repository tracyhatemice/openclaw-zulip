import { getZulipRuntime } from "../../runtime.js";
import type { ZulipAuth } from "../client.js";
import { zulipRequest } from "../client.js";
import { buildZulipRegisterNarrow } from "../queue-plan.js";
import type { ZulipEventsResponse, ZulipMeResponse, ZulipRegisterResponse } from "./types.js";

export async function fetchZulipMe(auth: ZulipAuth, abortSignal?: AbortSignal): Promise<ZulipMeResponse> {
  return await zulipRequest<ZulipMeResponse>({
    auth,
    method: "GET",
    path: "/api/v1/users/me",
    abortSignal,
  });
}

export async function fetchZulipSubscriptions(
  auth: ZulipAuth,
  abortSignal?: AbortSignal,
): Promise<Map<number, string>> {
  try {
    const res = await zulipRequest<{
      result: "success" | "error";
      subscriptions?: Array<{ stream_id: number; name: string }>;
    }>({
      auth,
      method: "GET",
      path: "/api/v1/users/me/subscriptions",
      abortSignal,
    });
    const map = new Map<number, string>();
    if (res.result === "success" && res.subscriptions) {
      for (const sub of res.subscriptions) {
        if (typeof sub.stream_id === "number" && sub.name) {
          map.set(sub.stream_id, sub.name);
        }
      }
    }
    return map;
  } catch {
    // Non-critical: stream ID resolution can also be populated from message events.
    return new Map<number, string>();
  }
}

export async function registerQueue(params: {
  auth: ZulipAuth;
  stream: string;
  isDmQueue?: boolean;
  abortSignal?: AbortSignal;
}): Promise<{ queueId: string; lastEventId: number }> {
  const core = getZulipRuntime();
  const entry: import("../queue-plan.js").ZulipQueuePlanEntry = params.isDmQueue
    ? { kind: "dm" }
    : { kind: "stream", stream: params.stream };
  const narrow = buildZulipRegisterNarrow(entry);
  const res = await zulipRequest<ZulipRegisterResponse>({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/register",
    form: {
      event_types: JSON.stringify(["message", "reaction", "update_message"]),
      apply_markdown: "false",
      narrow,
    },
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success" || !res.queue_id || typeof res.last_event_id !== "number") {
    throw new Error(res.msg || "Failed to register Zulip event queue");
  }
  core.logging
    .getChildLogger({ channel: "zulip" })
    .info(`[zulip] registered queue ${res.queue_id} (narrow=stream:${params.stream})`);
  return { queueId: res.queue_id, lastEventId: res.last_event_id };
}

export async function pollEvents(params: {
  auth: ZulipAuth;
  queueId: string;
  lastEventId: number;
  abortSignal?: AbortSignal;
}): Promise<ZulipEventsResponse> {
  // Wrap the parent signal with a per-poll timeout so we don't hang forever
  // if the Zulip server goes unresponsive during long-poll.
  // Must exceed Zulip's server-side long-poll timeout (typically 90s) to avoid
  // unnecessary client-side aborts that trigger queue re-registration and risk
  // dropping messages in the gap between old and new queues.
  const POLL_TIMEOUT_MS = 120_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onTimeout = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  timer = setTimeout(onTimeout, POLL_TIMEOUT_MS);

  const onParentAbort = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  params.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    return await zulipRequest<ZulipEventsResponse>({
      auth: params.auth,
      method: "GET",
      path: "/api/v1/events",
      query: {
        queue_id: params.queueId,
        last_event_id: params.lastEventId,
        // Be explicit: we want long-poll behavior to avoid tight polling loops that can trigger 429s.
        dont_block: false,
      },
      abortSignal: controller.signal,
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    params.abortSignal?.removeEventListener("abort", onParentAbort);
  }
}
