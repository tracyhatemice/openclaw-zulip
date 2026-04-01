# openclaw-zulip

OpenClaw Zulip channel plugin — extracted from jamie-dit/zulip-claw and updated to work with the latest OpenClaw plugin system (2026.03.23).

## Install

### Fresh install

```bash
openclaw plugins install . ; cd ~/.openclaw/extensions/zulip ; npm install ; npm install openclaw@latest ; openclaw gateway restart
```

Then run `openclaw config` -> `Channels` -> `Add Channel` -> `Zulip` and fill in the required fields.

### Existing install

Make a copy of `openclaw.json` for both with and without the Zulip plugin, so you can easily switch between them when testing.

```bash
# remove any existing Zulip plugin and reset to the no-Zulip config;
# openclaw.json.nozulip has no zulip entries.
rm -rf ~/.openclaw/extensions/zulip && cp ~/.openclaw/openclaw.json.nozulip ~/.openclaw/openclaw.json && openclaw gateway restart

# install the Zulip plugin and switch to the Zulip config;
# openclaw.json.zulip has the Zulip channel configured with "openclaw config" command.
openclaw plugins install . ; cd ~/.openclaw/extensions/zulip ; npm install ; cd ; cp ~/.openclaw/openclaw.json.zulip ~/.openclaw/openclaw.json && openclaw gateway restart
```

## Manual Configuration

The Zulip channel is configured under `channels.zulip` in `openclaw.json`. You can use `openclaw config` for interactive setup or edit the file directly.

### Minimal example

```jsonc
{
  "channels": {
    "zulip": {
      "baseUrl": "https://your-org.zulipchat.com",
      "email": "bot-email@your-org.zulipchat.com",
      "apiKey": "your-bot-api-key",
      "streams": {
        "general": {}
      }
    }
  }
}
```

### Full example with all options

```jsonc
{
  "channels": {
    "zulip": {
      // -- Connection --
      "baseUrl": "https://your-org.zulipchat.com",
      "email": "bot-email@your-org.zulipchat.com",
      "apiKey": "your-bot-api-key",

      // -- Stream access --
      // "open" = respond in any stream, "allowlist" = only listed streams, "disabled" = ignore all
      "streamPolicy": "allowlist",  // default: "allowlist"
      "streams": {
        "general": {
          "streamPolicy": "open",       // per-stream override
          "requireMention": false,      // respond without @mention
          "allowFrom": [12345, 67890]   // restrict to these sender IDs
        },
        "engineering": {}               // inherits account-level settings
      },

      // -- Mention behavior --
      "requireMention": true,  // default: true — only respond when @mentioned

      // -- Topic defaults --
      "defaultTopic": "general chat",  // fallback topic when target omits one

      // -- Direct messages --
      "dm": {
        // "open" = accept from anyone, "pairing" = only paired users,
        // "allowlist" = only listed sender IDs, "disabled" = ignore DMs
        "policy": "pairing",          // default: "pairing"
        "allowFrom": ["*"],           // required for "open" policy; sender IDs for "allowlist"
        "groupDm": {
          "enabled": false            // default: false — enable group DM (huddle) support
        }
      },

      // -- Actions (gated capabilities) --
      "actions": {
        // Enabled by default:
        "memberInfo": true,           // look up user info
        "search": true,               // search messages
        "edit": true,                 // edit message content
        "delete": true,               // delete messages

        // Disabled by default (opt-in):
        "channelCreate": false,       // create new streams
        "channelEdit": false,         // edit stream name/description
        "channelDelete": false,       // archive/delete streams
        "topicEdit": false,           // rename/move topics
        "topicResolve": false         // resolve/unresolve topics (✔ prefix)
      },

      // -- Reactions --
      "reactions": {
        "enabled": true,
        "onStart": "eyes",            // emoji shown when processing starts
        "onSuccess": "check_mark",    // emoji shown on success
        "onFailure": "x",             // emoji shown on failure
        "clearOnFinish": true,        // remove onStart emoji after responding

        // Optional: stage-based workflow reactions
        "workflow": {
          "enabled": false,
          "replaceStageReaction": true,   // remove previous stage emoji
          "minTransitionMs": 1500,        // minimum delay between stages
          "stages": {
            "queued": "hourglass",
            "processing": "gear",
            "toolRunning": "hammer_and_wrench",
            "retrying": "repeat",
            "success": "check_mark",
            "partialSuccess": "warning",
            "failure": "x"
          }
        },

        // Optional: synthetic callbacks for non-button reactions
        "genericCallback": {
          "enabled": false,
          "includeRemoveOps": false
        }
      },

      // -- Topic bindings (subagent sessions) --
      "topicBindings": {
        "enabled": false,             // enable topic-based thread bindings
        "spawnSubagentSessions": false // allow subagent spawning to create topics
      },

      // -- Keepalive --
      "keepaliveMessage": true,       // send periodic "still working" messages (default: true)

      // -- Limits --
      "textChunkLimit": 10000,        // max chars before chunking messages
      "mediaMaxMb": 5,                // max inbound/outbound media size in MB

      // -- Multi-account --
      // Override any account-level setting per account ID
      "accounts": {
        "secondary-bot": {
          "name": "Secondary Bot",
          "enabled": true,
          "baseUrl": "https://other-org.zulipchat.com",
          "email": "bot@other-org.zulipchat.com",
          "apiKey": "other-api-key",
          "streams": { "support": {} },
          "actions": {
            "topicEdit": true,
            "topicResolve": true
          }
        }
      }
    }
  }
}
```

## Config Reference

### Account-level settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | — | Display name for the account |
| `enabled` | boolean | `true` | Enable/disable this account |
| `configWrites` | boolean | — | Allow config writes from this account |
| `baseUrl` | string | **required** | Zulip server URL |
| `email` | string | **required** | Bot email address |
| `apiKey` | string | **required** | Bot API key |
| `streamPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | `"allowlist"` | Stream access policy |
| `streams` | Record\<string, StreamEntry\> | — | Stream-specific overrides |
| `requireMention` | boolean | `true` | Only respond when @mentioned |
| `defaultTopic` | string | `"general chat"` | Fallback topic name |
| `dm` | DmConfig | — | Direct message settings |
| `topicBindings` | TopicBindingsConfig | — | Subagent topic binding settings |
| `actions` | ActionsConfig | — | Gated action toggles |
| `reactions` | ReactionConfig | — | Reaction indicator settings |
| `keepaliveMessage` | boolean | `true` | Send periodic "still working" messages |
| `textChunkLimit` | number | `10000` | Max chars before chunking |
| `mediaMaxMb` | number | `5` | Max media size in MB |

### Stream entry

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `streamPolicy` | `"open"` \| `"allowlist"` \| `"disabled"` | inherits | Per-stream policy override |
| `requireMention` | boolean | inherits | Per-stream mention override |
| `allowFrom` | (string \| number)[] | — | Restrict to these sender IDs |

### DM config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `policy` | `"open"` \| `"pairing"` \| `"allowlist"` \| `"disabled"` | `"pairing"` | DM access policy |
| `allowFrom` | (string \| number)[] | — | Sender IDs; `["*"]` required for `"open"` |
| `groupDm.enabled` | boolean | `false` | Enable group DM (huddle) support |

### Actions config

All actions are boolean toggles. Actions not listed here (`send`, `read`, `react`, `channel-list`, `topic-list`, `sendWithReactions`) are always available.

| Key | Default | Description |
|-----|---------|-------------|
| `channelCreate` | `false` | Create new streams |
| `channelEdit` | `false` | Edit stream name/description |
| `channelDelete` | `false` | Archive/delete streams |
| `topicEdit` | `false` | Rename/move topics (propagate modes: `change_one`, `change_later`, `change_all`) |
| `topicResolve` | `false` | Resolve/unresolve topics (toggle `✔` prefix) |
| `memberInfo` | `true` | Look up user information |
| `search` | `true` | Search messages |
| `edit` | `true` | Edit message content |
| `delete` | `true` | Delete messages |

### Topic bindings config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable topic-based thread bindings for subagent sessions |
| `spawnSubagentSessions` | boolean | `false` | Allow subagent spawning to create dedicated topics |

### Reaction config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | — | Enable reaction indicators |
| `onStart` | string | — | Emoji when processing starts |
| `onSuccess` | string | — | Emoji on success |
| `onFailure` | string | — | Emoji on failure |
| `clearOnFinish` | boolean | `true` | Remove onStart emoji after responding |
| `workflow.enabled` | boolean | `false` | Enable stage-based workflow reactions |
| `workflow.replaceStageReaction` | boolean | `true` | Remove previous stage emoji |
| `workflow.minTransitionMs` | number | `1500` | Min delay between stage transitions (ms) |
| `workflow.stages.*` | string | — | Emoji per stage (`queued`, `processing`, `toolRunning`, `retrying`, `success`, `partialSuccess`, `failure`) |
| `genericCallback.enabled` | boolean | `false` | Enable synthetic callbacks for non-button reactions |
| `genericCallback.includeRemoveOps` | boolean | `false` | Include reaction removal events |

## Upstream Sync

```bash
git fetch upstream
git subtree pull --prefix=. upstream main --squash -- extensions/zulip
```
