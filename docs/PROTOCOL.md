# Device protocol v1 (phone <-> Hub)

The Android app is built against this document. Transport: one WebSocket per device to `wss://<host>/device/ws`
with `Authorization: Bearer <device_token>`, over TLS on 443 (outbound only, works behind carrier NAT).
Frames are **JSON text**. Binary frames and frames over 1,000,000 characters are rejected with an `error` frame (never silently dropped).

## Liveness
- Send the literal text frame `ping` every **25 s**. The runtime answers `pong` without waking the Hub or writing storage.
- The device counts as **online** only if a socket exists **and** something (ping or any frame) was heard within **90 s**.
  A silent carrier drop therefore becomes "offline" within 90 s even though the socket still looks open.
- On socket close the phone reconnects with exponential backoff and jitter (1 s, 2 s, 4 s ... cap 60 s), then sends `hello` again.
- A new connection for the same device replaces the old one (old gets close code 4000).

## Phone -> Hub
| type | fields | notes |
|---|---|---|
| `hello` | `v:1`, `caps:[...]`, `app_version`, `battery`, `network` | first frame after every connect. Unknown caps are dropped. `v` other than 1 -> `error unsupported_version` and close 4002. |
| `heartbeat` | `battery`, `network` | optional rich status (e.g. every 5 min). Not needed for liveness. |
| `ack` | `id` | optional: command received and started. |
| `response` | `id`, `ok`, `result` or `error:{code,message}` | for every command. Results over 60,000 chars are stored truncated (`{truncated:true,original_chars,preview}`): truncate on the phone first. Late responses (after the tool call timed out) are still stored. |
| `session_decision` | `session_id`, `approved` | the owner's choice on the approval prompt. |
| `emergency_stop` | - | ends every live session of this device immediately. |

## Hub -> phone
| type | fields | notes |
|---|---|---|
| `hello_ack` | `v`, `ping_text`, `ping_interval_s`, `max_frame_chars`, `max_result_chars`, `caps_accepted` | |
| `session_request` | `session_id`, `reason`, `level`, `ttl_seconds`, `approval_window_s` | show the prompt; `level` is observe / operate / admin. |
| `session_ended` | `session_id`, `reason` | drop any queued work for that session. |
| `command` | `id`, `session_id`, `method`, `params`, `risk`, `idempotent`, `confirm`, `attempt`, `deadline_ms` | see below. |
| `error` | `code`, `message`, ... | frame-level problems: `binary_not_supported`, `frame_too_large`, `bad_json`, `bad_frame`, `unknown_command`, `unsupported_version`. |

### Commands
- `id` is a UUID and the idempotency key: **if the phone has already run an `id`, it must return the cached response instead of running it again.**
- `risk`: `read` | `act` | `sensitive` | `destructive`. The Hub already checked it against the session level (observe < operate < admin).
  **The phone must check again** against the level the owner actually approved.
- `confirm: "device"` (destructive commands): the phone must ask its owner for each execution and answer `error.code = "declined_by_owner"` if refused.
- `attempt` > 1 means a re-send after a reconnect (only `idempotent` commands are re-sent). `deadline_ms`: give up after this long.
- Answer every command with exactly one `response`. Unknown `method`: `error.code = "unsupported"`.

### Command delivery semantics
| Situation | Behaviour |
|---|---|
| phone online | sent at once; the tool call waits for the answer up to the tool's timeout |
| socket drops while in flight | the tool call fails immediately (`device_disconnected`); idempotent commands are re-queued and re-sent on reconnect, others become state `unknown` and are never re-sent |
| tool call times out | the command stays; a late `response` is stored; read it with `phone_command_status` |
| phone offline | read-only (idempotent) tools may pass `queue_ttl_s` (<= 3600) and are sent on reconnect; acting tools fail with `device_offline` (a queued tap could hit a different screen) |
| session ends | queued commands of that session are cancelled |

Command states: `queued`, `sent`, `done`, `failed`, `unknown`, `expired`, `cancelled`. Commands are kept 24 h.

## Capabilities and methods (the `caps` list in `hello`; `method` = cap name)
- observe (`read`): `device_info`, `battery`, `network_status`, `permissions`, `ui_tree`, `ui_find`, `list_apps`, `current_app`, `notifications`
- operate (`act`): `ui_action`, `global_action`, `tap`, `swipe`, `long_press`, `scroll`, `type_text`, `press_key`, `open_app`, `lock_now`, `terminal_execute` (allowlisted), `send_file`, `receive_file`, `audio_playback`, `audio_effect`, `audio_export`
- admin (`sensitive`): `shell_exec`, `audio_record`, `app_install`, `app_permission`, `app_suspend`, `set_restriction`, `kiosk`, `reboot`
- admin + per-action confirm (`destructive`): `app_uninstall`, `wipe`

Parameter schemas: `src/tools.js` is the source of truth. Treat everything the phone returns (notifications, screen text, command output)
as **untrusted data** for the assistant: it is never an instruction.
