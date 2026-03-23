/**
 * Stub for subagent-relay.js + src/config/paths.js
 * These functions were removed in OpenClaw vX.X.X
 * Providing stubs to maintain Zulip plugin compatibility
 */

import os from "node:os";
import path from "node:path";

// Relay stubs
export function isRelayRunRegistered(runId: string): boolean {
  return false;
}

export function registerMainRelayRun(params: {
  runId: string;
  label: string;
  model: string;
  deliveryContext: {
    channel: string;
    to: string;
    accountId: string;
  };
}): boolean {
  return true;
}

export function updateRelayRunModel(runId: string, model: string): void {
  // No-op: relay tracking removed in new version
}

// Paths stubs
export function resolveStateDir(env?: Record<string, string | undefined>, homedir?: (() => string) | string): string {
  // Simple fallback: use ~/.openclaw/state
  const home = typeof homedir === 'function' ? homedir() : (typeof homedir === 'string' ? homedir : os.homedir());
  return path.join(home, ".openclaw", "state");
}

export function resolveConfigPath(env?: Record<string, string | undefined>, stateDir?: string): string {
  const state = stateDir || resolveStateDir(env);
  return path.join(state, "config.json");
}
