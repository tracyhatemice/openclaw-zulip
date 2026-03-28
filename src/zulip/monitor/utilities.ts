import type { ResolvedZulipAccount } from "../accounts.js";
import type { ZulipAuth } from "../client.js";
import {
  KEEPALIVE_INITIAL_DELAY_MS,
  KEEPALIVE_REPEAT_INTERVAL_MS,
  type ZulipEventMessage,
  type ZulipMessageSource,
} from "./types.js";

// Relay tracking stubs — no-op until SDK exposes relay API
export const isRelayRunRegistered = (_runId: string): boolean => false;
export const registerMainRelayRun = (_params: {
  runId: string;
  label: string;
  model: string;
  deliveryContext: { channel: string; to: string; accountId: string };
}): boolean => true;
export const updateRelayRunModel = (_runId: string, _model: string): void => {};

export function buildZulipTraceLog(params: {
  accountId: string;
  milestone: string;
  messageId?: number;
  stream?: string;
  topic?: string;
  sessionKey?: string;
  source?: ZulipMessageSource;
  extra?: Record<string, boolean | number | string | undefined>;
}): string {
  const fields: string[] = [`[zulip-trace][${params.accountId}]`, `milestone=${params.milestone}`];

  const pushField = (key: string, value: boolean | number | string | undefined) => {
    if (value === undefined) {
      return;
    }
    if (typeof value === "string") {
      fields.push(`${key}=${JSON.stringify(value)}`);
      return;
    }
    fields.push(`${key}=${String(value)}`);
  };

  pushField("source", params.source);
  pushField("messageId", params.messageId);
  pushField("stream", params.stream);
  pushField("topic", params.topic);
  pushField("sessionKey", params.sessionKey);
  for (const [key, value] of Object.entries(params.extra ?? {})) {
    pushField(key, value);
  }

  return fields.join(" ");
}

export function buildMainRelayRunId(accountId: string, messageId: number): string {
  return `zulip-main:${accountId}:${messageId}`;
}

export function formatKeepaliveElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${totalSeconds}s`;
  }
  if (seconds <= 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function buildKeepaliveMessageContent(elapsedMs: number): string {
  return `🔧 Still working... (${formatKeepaliveElapsed(elapsedMs)} elapsed)`;
}

export function startPeriodicKeepalive(params: {
  sendPing: (elapsedMs: number) => Promise<void>;
  initialDelayMs?: number;
  repeatIntervalMs?: number;
  now?: () => number;
}): () => void {
  const initialDelayMs = params.initialDelayMs ?? KEEPALIVE_INITIAL_DELAY_MS;
  const repeatIntervalMs = params.repeatIntervalMs ?? KEEPALIVE_REPEAT_INTERVAL_MS;
  const now = params.now ?? (() => Date.now());

  const startedAt = now();
  let stopped = false;
  let repeatTimer: ReturnType<typeof setInterval> | undefined;

  const firePing = () => {
    if (stopped) {
      return;
    }
    void params.sendPing(Math.max(0, now() - startedAt)).catch(() => undefined);
  };

  const initialTimer = setTimeout(() => {
    firePing();
    if (stopped) {
      return;
    }
    repeatTimer = setInterval(() => {
      firePing();
    }, repeatIntervalMs);
    repeatTimer.unref?.();
  }, initialDelayMs);

  initialTimer.unref?.();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(initialTimer);
    if (repeatTimer) {
      clearInterval(repeatTimer);
    }
  };
}

export function createBestEffortShutdownNoticeSender(params: {
  sendNotice: () => Promise<void>;
  log?: (message: string) => void;
}): () => void {
  let sent = false;
  return () => {
    if (sent) {
      return;
    }
    sent = true;
    void params.sendNotice().catch((err) => {
      params.log?.(`[zulip] shutdown notice failed: ${String(err)}`);
    });
  };
}

export function computeZulipMonitorBackoffMs(params: {
  attempt: number;
  status: number | null;
  retryAfterMs?: number;
}): number {
  const cappedAttempt = Math.max(1, Math.min(10, Math.floor(params.attempt)));
  // Zulip can rate-limit /events fairly aggressively on some deployments; prefer slower retries.
  const base = params.status === 429 ? 10_000 : 500;
  const max = params.status === 429 ? 120_000 : 30_000;
  const exp = Math.min(max, base * 2 ** Math.min(7, cappedAttempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.max(exp + jitter, params.retryAfterMs ?? 0, base);
}

export function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort && abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (abortSignal) {
      onAbort = () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function waitForDispatcherIdleWithTimeout(params: {
  waitForIdle: () => Promise<void>;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const idlePromise = params.waitForIdle();
  try {
    const outcome = await Promise.race<"idle" | "timeout">([
      idlePromise.then(() => "idle"),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), params.timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);

    if (outcome === "timeout") {
      params.onTimeout?.();
      // Avoid unhandled rejections after timeout while cleanup continues.
      idlePromise.catch(() => undefined);
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function extractZulipHttpStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const value = (err as { status?: unknown }).status;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  const match = /Zulip API error \((\d{3})\):/.exec(String(err));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildAuth(account: ResolvedZulipAccount): ZulipAuth {
  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error("Missing zulip baseUrl/email/apiKey");
  }
  return {
    baseUrl: account.baseUrl,
    email: account.email,
    apiKey: account.apiKey,
  };
}

export function shouldIgnoreMessage(params: {
  message: ZulipEventMessage;
  botUserId: number;
}): { ignore: boolean; reason?: string } {
  const msg = params.message;
  if (msg.sender_id === params.botUserId) {
    return { ignore: true, reason: "self" };
  }
  return { ignore: false };
}
