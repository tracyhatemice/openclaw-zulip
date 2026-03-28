# OpenClaw Zulip Channel Plugin

OpenClaw channel plugin for Zulip. Branch `refractory` is an ongoing refinement toward feature parity with the bundled Discord plugin.

For global conventions (TypeScript style, commit format, testing standards), see the parent `openclaw/AGENTS.md`.

## Reference Sources

- **Discord plugin** (pattern source): `/home/ubuntu/project/openclaw/extensions/discord`
- **Other bundled plugins**: `/home/ubuntu/project/openclaw/extensions/`
- **Zulip OpenAPI spec**: `doc/zulip.yaml` — search by `operationId` to find endpoints
- **Discord OpenAPI spec**: `doc/discord.json` — use `jq` to query; cross-reference when implementing features that have Discord equivalents

**Concept mapping**: Zulip streams ~ Discord channels, Zulip topics ~ Discord threads.

When implementing new features, study the equivalent in the Discord plugin for code style and structure. Do not port directly — adapt patterns to Zulip's API model.

## Architecture

```
src/
  channel.ts              — Main channel plugin definition
  config-schema.ts        — Zod config validation
  types.ts                — Core types (ZulipAccountConfig, DmPolicy, etc.)
  subagent-hooks.ts       — Subagent integration hooks
  zulip/
    client.ts             — HTTP client, auth, retry logic (zulipRequest, zulipRequestWithRetry)
    accounts.ts           — Multi-account resolution
    actions.ts            — Action handlers (send, edit, delete, react, channel-*, topic-*)
    send.ts               — Zulip API: send messages, edit content, edit topics
    uploads.ts            — File upload / outbound media
    reactions.ts          — Emoji reaction add/remove
    reaction-buttons.ts   — Interactive button reactions (polling + cleanup)
    tool-progress.ts      — In-message tool progress display
    typing.ts             — Typing indicators (stream + DM)
    presence.ts           — User presence status
    targets.ts            — Parse/resolve Zulip targets (stream:name#topic)
    normalize.ts          — Normalize stream names, topics, markdown tables
    topic-bindings.ts     — Subagent session-to-topic mapping
    dedupe.ts             — Message deduplication
    dm-access.ts          — DM access control
    inflight-checkpoints.ts — Delivery state tracking / recovery
    probe.ts              — Health probe / connectivity check
    monitor/
      provider.ts         — Main event loop (register queue, poll events, topic rename tracking)
      message-handler.ts  — Inbound message processing, context building, agent dispatch
      reply-delivery.ts   — Outbound reply delivery with media support
      topic-management.ts — Topic key building, rename alias tracking, session continuity
      api.ts              — Monitor API helpers (fetchMe, fetchSubscriptions, registerQueue, pollEvents)
      types.ts            — Monitor types (ZulipEventMessage, ZulipUpdateMessageEvent, etc.)
      utilities.ts        — Helper utilities (shouldIgnoreMessage, etc.)
      reactions.ts        — Reaction event handling in monitor context
      keepalive-shutdown.ts — Graceful shutdown
```

## Zulip API Quick Reference

Spec: `doc/zulip.yaml`. Search by `operationId` to jump to the endpoint definition.

| Task | operationId | Line | Method + Path |
|---|---|---|---|
| Send message | `send-message` | L8731 | `POST /messages` |
| Get messages | `get-messages` | L8298 | `GET /messages` |
| Edit/move message topic | `update-message` | L10084 | `PATCH /messages/{id}` |
| Delete message | `delete-message` | L10469 | `DELETE /messages/{id}` |
| Add reaction | `add-reaction` | L9598 | `POST /messages/{id}/reactions` |
| Remove reaction | `remove-reaction` | L9668 | `DELETE /messages/{id}/reactions` |
| Upload file | `upload-file` | L10610 | `POST /user_uploads` |
| Get stream ID | `get-stream-id` | L6711 | `GET /get_stream_id` |
| List streams | `get-streams` | L23303 | `GET /streams` |
| Get stream by ID | `get-stream-by-id` | L23574 | `GET /streams/{id}` |
| Update stream | `update-stream` | L23661 | `PATCH /streams/{id}` |
| Archive stream | `archive-stream` | L23640 | `DELETE /streams/{id}` |
| Create channel | `create-channel` | L24577 | `POST /users/me/subscriptions` |
| Delete topic | `delete-topic` | L24237 | `POST /streams/{id}/delete_topic` |
| Set typing status | `set-typing-status` | L24341 | `POST /typing` |
| Get own user | `get-own-user` | L11379 | `GET /users/me` |
| Get user | `get-user` | L15777 | `GET /users/{id}` |
| Get users | `get-users` | L10824 | `GET /users` |
| Register event queue | `register-queue` | L17266 | `POST /register` |
| Get events | `get-events` | L339 | `GET /events` |
| Delete queue | `delete-queue` | L6676 | `DELETE /events` |
| Get user presence | `get-user-presence` | L11298 | `GET /users/{id}/presence` |
| Mark topic as read | `mark-topic-as-read` | L6850 | `POST /mark_topic_as_read` |
| Get subscribers | `get-subscribers` | L23259 | `GET /streams/{id}/members` |

## Discord API Quick Reference

Spec: `doc/discord.json`. Use `jq` to query (e.g., `jq '.paths["/channels/{channel_id}"]' doc/discord.json`).

| Task | operationId | Method + Path |
|---|---|---|
| Get channel | `get_channel` | `GET /channels/{id}` |
| Update channel | `update_channel` | `PATCH /channels/{id}` |
| Delete channel | `delete_channel` | `DELETE /channels/{id}` |
| List messages | `list_messages` | `GET /channels/{id}/messages` |
| Create message | `create_message` | `POST /channels/{id}/messages` |
| Get message | `get_message` | `GET /channels/{id}/messages/{id}` |
| Update message | `update_message` | `PATCH /channels/{id}/messages/{id}` |
| Delete message | `delete_message` | `DELETE /channels/{id}/messages/{id}` |
| Add reaction | `add_my_message_reaction` | `PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me` |
| Delete reaction | `delete_my_message_reaction` | `DELETE /channels/{id}/messages/{id}/reactions/{emoji}/@me` |
| Create thread from message | `create_thread_from_message` | `POST /channels/{id}/messages/{id}/threads` |
| Create thread | `create_thread` | `POST /channels/{id}/threads` |
| Join thread | `join_thread` | `PUT /channels/{id}/thread-members/@me` |
| List thread members | `list_thread_members` | `GET /channels/{id}/thread-members` |
| Create DM | `create_dm` | `POST /users/@me/channels` |
| List guild channels | `list_guild_channels` | `GET /guilds/{id}/channels` |
| Create guild channel | `create_guild_channel` | `POST /guilds/{id}/channels` |
| Get guild member | `get_guild_member` | `GET /guilds/{id}/members/{id}` |
| List guild members | `list_guild_members` | `GET /guilds/{id}/members` |

## Development Workflow

```bash
# Run all tests
npx vitest run

# Run a single test file
npx vitest run src/zulip/actions.test.ts

# Run tests matching a pattern
npx vitest run -t "topic-edit"
```

No `npm run build` script — use `npx vitest run` for validation. Commit style: conventional commits (`fix:`, `feat:`, `refactor:`, `chore:`).

## Adding a New Gated Action

All action handlers live in `src/zulip/actions.ts`. To add a new one:

1. Add the action name to `GATED_ACTIONS` array
2. Add a config key (e.g., `topicEdit?: boolean`) to `ZulipActionConfig` type
3. Add a `case` to `resolveActionConfigKey()` mapping action name to config key
4. Add to `DEFAULTS_TO_DISABLED` set if the action is destructive/mutation
5. Write a `handleXxx()` function following the existing pattern (use `resolveAuth`, `requireString`/`optionalString` helpers)
6. Add a `case` to the `handleAction` switch with `assertZulipActionEnabled` guard
7. Add conditional inclusion in `describeMessageTool` (same pattern as `channel-create`)
8. Add tests in `src/zulip/actions.test.ts` — cover: correct API call, throws when disabled, defaults-to-disabled if applicable
