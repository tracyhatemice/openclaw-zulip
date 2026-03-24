import {
  createEnvPatchedAccountSetupAdapter,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup";

export const ZULIP_URL_HELP_LINES = [
  "1) Create a Zulip bot and copy its API key",
  "2) Ensure the bot is subscribed to the stream(s) you want to monitor",
  "3) Configure base URL + bot email + API key + stream allowlist",
  "Docs: https://docs.openclaw.ai/channels/zulip",
];

export const zulipSetupAdapter: ChannelSetupAdapter = createEnvPatchedAccountSetupAdapter({
  channelKey: "zulip",
  ensureChannelEnabled: true,
  defaultAccountOnlyEnvError:
    "ZULIP_URL / ZULIP_EMAIL / ZULIP_API_KEY can only be used for the default account.",
  missingCredentialError:
    "Zulip requires a base URL, bot email, and API key.",
  hasCredentials: (input) => Boolean(input.url && input.userId && input.token),
  buildPatch: (input) => ({
    ...(input.url ? { baseUrl: input.url } : {}),
    ...(input.userId ? { email: input.userId } : {}),
    ...(input.token ? { apiKey: input.token } : {}),
  }),
});
