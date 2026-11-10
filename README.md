# @mgcrea/mcp-youtube

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an agent upload
videos to a YouTube channel and manage them: metadata, privacy and scheduling, thumbnails,
playlists.

The server is **read-only by default**. Uploading and every other mutating tool are not merely
refused when writes are off: they are never registered, so an agent cannot call them at all.

## Features

- **Resumable, chunked uploads** that survive dropped connections. The server asks YouTube how
  far it got and resumes from there, so a failure costs one chunk instead of the whole file.
  Large files upload in the background: `youtube_upload_video` waits up to `wait_seconds`, then
  hands back an `upload_id` for `youtube_get_upload`. MCP progress notifications are sent when
  the client asks for them.
- **Safe defaults for an agent.** Uploads default to **private** (the API itself defaults to
  public). The made-for-kids declaration is required, with no default. Only video files can be
  uploaded, from absolute paths.
- **The channel is always visible.** The Google consent screen picks the channel, so the token
  decides where an upload lands. Every response carries `channel`. `YOUTUBE_CHANNEL_ID` makes
  every tool refuse when the token belongs to a different channel.
- **Merge-safe updates.** `videos.update` replaces every part it is sent, so
  `youtube_update_video` reads the video first and changes only the fields you pass.
- **Remedies, not just errors.** Google's `reason` codes (`quotaExceeded`,
  `uploadLimitExceeded`, `invalid_grant`, ...) come back with what to do next.

## Setup

YouTube uploads need an OAuth client from a Google Cloud project you own. This takes about five
minutes, once.

1. [Create a project](https://console.cloud.google.com/projectcreate).
2. Enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. Configure the consent screen in **Google Auth Platform**:
   - **Branding**: an app name and your email.
   - **Audience**: External, then **Publish app**. While the app is in _Testing_, Google expires
     refresh tokens after 7 days. An unverified app in production is fine for your own account;
     you click past one warning at login.
4. Go to **Clients → Create client** and choose application type **Desktop app**. You don't
   register a redirect URI, because Desktop clients accept any loopback port.
5. Set `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`, and start the server.
6. Ask the agent to call `youtube_auth_login`. It opens the consent screen. Pick the channel
   uploads should go to; Brand Account channels are listed separately.

The refresh token is stored with mode 600 in `~/.config/youtube/tokens.json`. You don't need to
restart afterwards.

## Configure

Environment first, then `~/.config/youtube/config.json` (camelCase keys, strict), field by
field.

| Variable                | Required | Description                                                                        |
| ----------------------- | -------- | ---------------------------------------------------------------------------------- |
| `YOUTUBE_CLIENT_ID`     | yes      | Desktop-app OAuth client id (`….apps.googleusercontent.com`).                      |
| `YOUTUBE_CLIENT_SECRET` | yes      | Its secret. Google requires it even with PKCE.                                     |
| `YOUTUBE_ALLOW_WRITES`  | no       | `1` to register the upload and other write tools, and ask for the `youtube` scope. |
| `YOUTUBE_CHANNEL_ID`    | no       | Expected channel (`UC…`). Every tool refuses if the token acts as another.         |
| `YOUTUBE_REFRESH_TOKEN` | no       | Use this refresh token (memory only) instead of the token file.                    |
| `YOUTUBE_TOKEN_FILE`    | no       | Where the login is stored. Defaults to `~/.config/youtube/tokens.json`.            |
| `YOUTUBE_CHUNK_SIZE_MB` | no       | Upload chunk size, default 16.                                                     |
| `YOUTUBE_CONFIG`        | no       | Config file path.                                                                  |

A read-only install asks for `youtube.readonly` only. If you turn writes on after logging in,
`youtube_auth_status` reports the missing scope; log in again.

## Quota

Quota is counted per Google Cloud project and resets at midnight Pacific time.

- **Uploads** have their own bucket of **100 `videos.insert` calls per day** (since 2026-06-01).
- **Everything else** shares 10,000 units per day. A list or get costs 1 unit. An update,
  delete, thumbnail or playlist write costs 50.

YouTube also applies its own per-channel upload limit (`uploadLimitExceeded`), separate from
API quota.

## Tools

| Tool                      | What it does                                                           | Writes |
| ------------------------- | ---------------------------------------------------------------------- | ------ |
| `youtube_auth_status`     | Configured? Signed in? Which channel, scopes, quota model, setup steps | no     |
| `youtube_auth_login`      | Google consent in the browser, then stores the refresh token           | no     |
| `youtube_auth_logout`     | Revokes the token at Google and deletes it locally                     | no     |
| `youtube_get_channel`     | Your channel, including whether videos over 15 minutes are allowed     | no     |
| `youtube_list_videos`     | Your uploads, including private, unlisted and scheduled ones           | no     |
| `youtube_get_video`       | One video in full, including processing progress                       | no     |
| `youtube_list_playlists`  | Your playlists                                                         | no     |
| `youtube_list_categories` | Assignable categories for a region                                     | no     |
| `youtube_request`         | Any Data API v3 endpoint (GET only unless writes are on)               | gated  |
| `youtube_upload_video`    | Upload a local video, optionally with a thumbnail and playlist         | yes    |
| `youtube_get_upload`      | Follow an upload: progress, then video id and processing state         | no¹    |
| `youtube_update_video`    | Merge-update title, description, tags, privacy, schedule, disclosures  | yes    |
| `youtube_set_thumbnail`   | Custom thumbnail (needs a verified channel)                            | yes    |
| `youtube_create_playlist` | New playlist, private by default                                       | yes    |
| `youtube_add_to_playlist` | Add a video to a playlist                                              | yes    |
| `youtube_delete_video`    | Permanent delete, requires `confirm: true`                             | yes    |

¹ Registered only with writes on, since without them no upload can exist.

### Things worth knowing

- YouTube has no Shorts flag. A vertical or square video up to 3 minutes becomes a Short
  automatically.
- A channel without phone verification can't upload videos longer than 15 minutes or set
  custom thumbnails. Verify at <https://www.youtube.com/verify>.
- Uploads live in the server process. If the server restarts mid-upload, the upload is gone;
  start it again. An incomplete upload never creates a video.
- `youtube_upload_video` is not idempotent: every call creates a new video.

## Quick start

```bash
pnpm install
pnpm build
```

Then copy `.mcp.json.example` to `.mcp.json` and fill it in.

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest
pnpm typecheck
pnpm lint
pnpm format
```

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm + GHCR from the tag
```

## License

MIT
