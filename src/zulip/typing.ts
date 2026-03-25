import type { ZulipAuth } from "./client.js";
import { zulipRequest } from "./client.js";

/**
 * Send a typing indicator to a Zulip stream/topic.
 * Indicates the bot is composing a message.
 */
export async function sendZulipTypingStart(params: {
  auth: ZulipAuth;
  stream: string;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "start",
        type: "stream",
        to: JSON.stringify([params.stream]),
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best-effort; typing indicators are non-critical.
  }
}

/**
 * Send a typing stop indicator to a Zulip stream/topic.
 */
export async function sendZulipTypingStop(params: {
  auth: ZulipAuth;
  stream: string;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "stop",
        type: "stream",
        to: JSON.stringify([params.stream]),
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Send a DM typing indicator.
 */
export async function sendZulipDirectTypingStart(params: {
  auth: ZulipAuth;
  to: (string | number)[];
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "start",
        type: "direct",
        to: JSON.stringify(params.to),
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best-effort.
  }
}
