import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { getZulipRuntime } from "../runtime.js";
import type { ZulipApiSuccess, ZulipAuth } from "./client.js";
import { normalizeZulipBaseUrl } from "./normalize.js";

const HTTP_URL_RE = /^https?:\/\//i;
const USER_UPLOAD_MARKER = "/user_uploads/";
const MB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 5 * MB;

function cleanCandidateUrl(raw: string): string {
  // Zulip content may include HTML entities when apply_markdown=true.
  let cleaned = raw.replace(/&amp;/g, "&").trim();
  // Trim common Markdown/HTML delimiters.
  cleaned = cleaned.replace(/^[<("'[]+/, "");
  cleaned = cleaned.replace(/[>")'\],.!?;:]+$/, "");
  return cleaned;
}

function resolveUploadUrl(raw: string, baseUrl: string): string | null {
  const base = normalizeZulipBaseUrl(baseUrl);
  if (!base) {
    return null;
  }
  const cleaned = cleanCandidateUrl(raw);
  if (!cleaned.includes(USER_UPLOAD_MARKER)) {
    return null;
  }
  try {
    const url = cleaned.startsWith("/")
      ? new URL(cleaned, base)
      : HTTP_URL_RE.test(cleaned)
        ? new URL(cleaned)
        : null;
    if (!url) {
      return null;
    }
    // Only allow uploads hosted on the same origin as the configured Zulip server.
    const baseOrigin = new URL(base).origin;
    if (url.origin !== baseOrigin) {
      return null;
    }
    if (!url.pathname.includes(USER_UPLOAD_MARKER)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function extractZulipUploadUrls(content: string, baseUrl: string): string[] {
  const text = content ?? "";
  if (!text.includes(USER_UPLOAD_MARKER)) {
    return [];
  }

  // Match either absolute URLs or /user_uploads/... paths. Keep it permissive and clean after.
  const re =
    /https?:\/\/[^\s<>"')\]]+\/user_uploads\/[^\s<>"')\]]+|\/user_uploads\/[^\s<>"')\]]+/gi;
  const matches = text.match(re) ?? [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const resolved = resolveUploadUrl(match, baseUrl);
    if (!resolved) {
      continue;
    }
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function resolveFilenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    return base || undefined;
  } catch {
    return undefined;
  }
}

export type ZulipInboundUpload = {
  url: string;
  path: string;
  contentType?: string;
  placeholder: string;
};

type ZulipTemporaryUrlResponse = ZulipApiSuccess & {
  url?: string;
};

/**
 * Resolve the `/user_uploads/{realm_id}/{filename}` portion of an absolute
 * upload URL. Returns null when the URL does not point at the Zulip uploads
 * endpoint on the configured origin.
 */
function extractUploadPathId(uploadUrl: string, baseOrigin: string | undefined): string | null {
  if (!baseOrigin) {
    return null;
  }
  try {
    const parsed = new URL(uploadUrl);
    if (parsed.origin !== baseOrigin) {
      return null;
    }
    const idx = parsed.pathname.indexOf(USER_UPLOAD_MARKER);
    if (idx === -1) {
      return null;
    }
    const pathId = parsed.pathname.slice(idx + USER_UPLOAD_MARKER.length);
    return pathId.length > 0 ? pathId : null;
  } catch {
    return null;
  }
}

/**
 * Ask the Zulip API for a temporary unauthenticated URL to an uploaded file.
 * See `get-file-temporary-url` in doc/zulip.yaml — the temporary URL is valid
 * for `SIGNED_ACCESS_TOKEN_VALIDITY_IN_SECONDS` seconds and must be fetched
 * immediately. This lets us download files regardless of whether the Zulip
 * server is backed by local storage or S3.
 */
async function fetchZulipUploadTemporaryUrl(params: {
  auth: ZulipAuth;
  pathId: string;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const base = normalizeZulipBaseUrl(params.auth.baseUrl);
  if (!base) {
    return null;
  }
  const apiUrl = new URL(`${base}/api/v1/user_uploads/${params.pathId}`);
  const token = Buffer.from(`${params.auth.email}:${params.auth.apiKey}`, "utf8").toString(
    "base64",
  );
  const res = await fetch(apiUrl, {
    method: "GET",
    headers: {
      Authorization: `Basic ${token}`,
      Accept: "application/json",
    },
    signal: params.abortSignal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zulip temporary URL lookup failed (${res.status}): ${text.slice(0, 200)}`);
  }
  let json: ZulipTemporaryUrlResponse | null = null;
  try {
    json = text ? (JSON.parse(text) as ZulipTemporaryUrlResponse) : null;
  } catch {
    json = null;
  }
  if (!json || json.result !== "success" || !json.url) {
    return null;
  }
  return new URL(json.url, base).toString();
}

export async function downloadZulipUploads(params: {
  cfg: OpenClawConfig;
  accountId: string;
  auth: ZulipAuth;
  content: string;
  abortSignal?: AbortSignal;
  maxFiles?: number;
}): Promise<ZulipInboundUpload[]> {
  const core = getZulipRuntime();
  const logger = core.logging.getChildLogger({ channel: "zulip" });

  const maxBytes =
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.zulip?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.zulip?.mediaMaxMb,
      accountId: params.accountId,
    }) ?? DEFAULT_MAX_BYTES;

  const urls = extractZulipUploadUrls(params.content, params.auth.baseUrl);
  if (urls.length === 0) {
    return [];
  }
  const maxFiles = Math.max(0, Math.floor(params.maxFiles ?? 3));
  const limited = maxFiles > 0 ? urls.slice(0, maxFiles) : urls;

  const base = normalizeZulipBaseUrl(params.auth.baseUrl);
  const baseOrigin = base ? new URL(base).origin : undefined;
  // Allow the configured Zulip origin even when it resolves to a private IP
  // (common for self-hosted instances). The signed temporary URL is served by
  // the same origin and may hit internal DNS.
  const ssrfPolicy: SsrFPolicy | undefined = baseOrigin
    ? {
        allowedHostnames: [new URL(baseOrigin).hostname],
        hostnameAllowlist: [new URL(baseOrigin).hostname],
        allowPrivateNetwork: true,
      }
    : undefined;

  const out: ZulipInboundUpload[] = [];
  for (const url of limited) {
    try {
      const pathId = extractUploadPathId(url, baseOrigin);
      if (!pathId) {
        logger.debug?.(`[zulip] skipping upload download: unable to resolve path id for ${url}`);
        continue;
      }
      const temporaryUrl = await fetchZulipUploadTemporaryUrl({
        auth: params.auth,
        pathId,
        abortSignal: params.abortSignal,
      });
      if (!temporaryUrl) {
        logger.warn(`[zulip] no temporary URL returned for upload ${url}`);
        continue;
      }
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: temporaryUrl,
        maxBytes,
        ssrfPolicy,
      });
      const label = fetched.fileName ?? resolveFilenameFromUrl(url);
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
        label,
      );
      out.push({
        url,
        path: saved.path,
        contentType: saved.contentType ?? fetched.contentType,
        placeholder: label ? `[Zulip upload: ${label}]` : "[Zulip upload]",
      });
    } catch (err) {
      logger.warn(`[zulip] inbound upload download failed for ${url}: ${String(err)}`);
    }
  }
  return out;
}

type ZulipUploadResponse = ZulipApiSuccess & {
  /** Preferred field since Zulip 9.0. */
  url?: string;
  /** @deprecated Use `url` instead. */
  uri?: string;
};

export async function uploadZulipFile(params: {
  auth: ZulipAuth;
  buffer: Uint8Array;
  filename: string;
  contentType?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const base = normalizeZulipBaseUrl(params.auth.baseUrl);
  if (!base) {
    throw new Error("Missing Zulip baseUrl");
  }

  const url = new URL(`${base}/api/v1/user_uploads`);
  const token = Buffer.from(`${params.auth.email}:${params.auth.apiKey}`, "utf8").toString(
    "base64",
  );

  const form = new FormData();
  const blob = new Blob([params.buffer as BlobPart], {
    type: params.contentType?.trim() || "application/octet-stream",
  });
  form.append("file", blob, params.filename);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${token}`,
    },
    body: form,
    signal: params.abortSignal,
  });
  const text = await res.text();
  let json: ZulipUploadResponse | null = null;
  try {
    json = text ? (JSON.parse(text) as ZulipUploadResponse) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg =
      json && typeof json === "object" && typeof json.msg === "string"
        ? json.msg
        : text?.trim()
          ? text.trim()
          : `HTTP ${res.status}`;
    throw new Error(`Zulip API error (${res.status}): ${msg}`);
  }
  const uploadPath = json?.url ?? json?.uri;
  if (!json || json.result !== "success" || !uploadPath) {
    throw new Error("Zulip upload failed: missing url");
  }

  // Zulip returns a relative "/user_uploads/..." path.
  return new URL(uploadPath, base).toString();
}

export async function resolveOutboundMedia(params: {
  cfg: OpenClawConfig;
  accountId: string;
  mediaUrl: string;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: OutboundMediaLoadOptions["mediaLocalRoots"];
  mediaReadFile?: OutboundMediaLoadOptions["mediaReadFile"];
}): Promise<{ buffer: Uint8Array; contentType?: string; filename?: string }> {
  const source = params.mediaUrl.trim();
  if (!source) {
    throw new Error("Missing mediaUrl");
  }

  const maxBytes =
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.zulip?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.zulip?.mediaMaxMb,
      accountId: params.accountId,
    }) ?? DEFAULT_MAX_BYTES;

  const result = await loadOutboundMediaFromUrl(source, {
    maxBytes,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });

  return {
    buffer: new Uint8Array(result.buffer),
    contentType: result.contentType,
    filename: result.fileName,
  };
}
