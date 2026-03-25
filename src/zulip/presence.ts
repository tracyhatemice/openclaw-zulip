import type { ZulipAuth } from "./client.js";
import { zulipRequest } from "./client.js";

export type ZulipPresenceStatus = "active" | "idle";

/**
 * Set the bot's own presence status.
 */
export async function setZulipPresence(params: {
  auth: ZulipAuth;
  status: ZulipPresenceStatus;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/users/me/presence",
      form: {
        status: params.status,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best-effort; presence is non-critical.
  }
}

export type ZulipUserPresence = {
  userId: number;
  email?: string;
  status: ZulipPresenceStatus;
  timestamp: number;
};

/**
 * Get presence information for all active users in the realm.
 */
export async function getZulipRealmPresence(params: {
  auth: ZulipAuth;
  abortSignal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return await zulipRequest<Record<string, unknown>>({
    auth: params.auth,
    method: "GET",
    path: "/api/v1/realm/presence",
    abortSignal: params.abortSignal,
  });
}

/**
 * Get presence information for a specific user.
 */
export async function getZulipUserPresence(params: {
  auth: ZulipAuth;
  userId: string | number;
  abortSignal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return await zulipRequest<Record<string, unknown>>({
    auth: params.auth,
    method: "GET",
    path: `/api/v1/users/${encodeURIComponent(String(params.userId))}/presence`,
    abortSignal: params.abortSignal,
  });
}
