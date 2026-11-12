# PhoneBridge Android app: build brief

This file is the standing instruction for the session that builds the Android app. In the app repo it is saved as `CLAUDE.md`
(read automatically each session). The app lives in **its own repository**; the backend lives in the private repo `JijiArc/Akio`
(Cloudflare Worker + Durable Object, version 0.3.0, deployed at `https://phonebridge-mcp.ikira0x0.workers.dev`).

## 0. Sources of truth
- **`docs/PROTOCOL.md`** (copied into this repo, original in `JijiArc/Akio`): the phone <-> backend wire contract. If it is missing here, stop and ask for it.
- **Tool parameter schemas**: `src/tools.js` in `JijiArc/Akio`. Ask for a copy of the relevant tool entries if you need exact fields; do not guess parameter names.
- If this brief and those files disagree, the backend files win. Report the disagreement instead of silently picking one.
- Never change the backend from here. Protocol changes are requested from the backend repo's session.
- Backend endpoints used by the app: `POST /device/pair`, `GET wss://<host>/device/ws` (device token as Bearer), `POST /device/rotate`. `/device/ice` exists (Xirsys) but is not used yet.
- Repo layout suggestion: `app/` (Kotlin module), `docs/PROTOCOL.md`, `docs/TESTING.md` (device test log), `CLAUDE.md` (this file).

## 1. Goal
An Android app that lets Claude run this phone like an MDM-managed device, through the PhoneBridge Cloudflare backend:
read the screen as text (accessibility tree), act on it, run commands and read their output, and use Device Owner management
features. The app **connects outward only** (WSS on 443) so it works behind carrier NAT. Claude is the operator; the phone owner
keeps the last word (levels, per-action confirmation for destructive actions, kill switch).

Out of scope: screenshots, screen streaming, WebRTC (the backend keeps Xirsys for later), Play Store distribution, root, system-partition install.

## 2. Target device and build settings
- Realme 5, **Android 10 (API 29)**, realme UI. Global ROM with Google Play services (to be confirmed by the owner).
- Kotlin, Gradle, `minSdk 29`, `targetSdk 29` (or 30), `compileSdk` current. OkHttp for the WebSocket, kotlinx.serialization for JSON,
  coroutines. Package id suggestion: `dev.phonebridge.agent`.
- Sideloaded and installed by adb. No restricted-settings hurdle exists on Android 10.
- Do not request permissions the tools do not need. `usesCleartextTraffic=false`.

## 3. Components
1. **AgentService** (foreground service, persistent notification): owns the WebSocket, reconnect (exponential backoff 1 s .. 60 s with jitter),
   the text `ping` every 25 s, `hello` after every connect (caps computed from what is actually available right now), and the command pipeline.
2. **Pairing screen**: owner types the 8-character code (`XXXX-XXXX`) and the Worker URL. `POST /device/pair` with `{code,name,model,android_version,app_version}` ->
   `{device_id, device_token, ws_url}`. Store the token in the Android Keystore / EncryptedSharedPreferences. Rotate with `POST /device/rotate` periodically. Never log the token.
3. **Session approval UI**: on `session_request` show reason, **level** (observe/operate/admin), TTL and a countdown (approval window is 120 s). Show it with a high-priority notification
   plus full-screen intent (Android 10 blocks starting activities from the background). Owner taps Approve/Deny -> `session_decision`. Never auto-approve.
4. **Local session state**: store level and expiry per session. Enforce the TTL and level **locally**, even if the backend is unreachable. Drop everything on `session_ended`.
5. **Kill switch** that works without Claude or the network: notification action, Quick Settings tile, and a key combo via the accessibility key filter (e.g. Volume Down x5).
   It ends all sessions, sends `emergency_stop` if connected, and closes the socket.
6. **AccessibilityService**: UI tree, node actions, gestures, global actions, text input, key filter. Also gives foreground-app detection.
7. **NotificationListenerService**: for `notifications`.
8. **DeviceAdminReceiver** (`.admin.AdminReceiver`): Device Owner features through `DevicePolicyManager`.
9. **Command executor**: validate -> authorize (level + risk) -> dedupe -> confirm (if required) -> run -> respond. See section 5.
10. **Setup checklist screen**: shows the state of each requirement with a button that opens the right settings page: accessibility, notification access, battery optimization exemption,
    the realme auto-launch / background-activity settings (best-effort intents, plus the manual path in text), and Device Owner status with the exact adb command:
    `adb shell dpm set-device-owner dev.phonebridge.agent/.admin.AdminReceiver` (needs a phone with no accounts; remove Google, realme/HeyTap and any secondary user or work profile first).

## 4. Capabilities reported in `hello`
Report a cap only when it works right now (e.g. `ui_tree` only if the accessibility service is enabled; Device Owner caps only if the app is Device Owner). The backend filters unknown caps. When something changes, reconnect or send a new `hello`.

## 5. Command execution rules (the safety-critical part)
For every `command` frame, in this order:
1. **Session**: there must be an active, unexpired local session for `session_id`. Otherwise respond `error.code="no_session"`.
2. **Level check**: `risk` must fit the approved level (read<=observe, act<=operate, sensitive/destructive<=admin). Otherwise `insufficient_level`. Do not trust the Worker's check alone.
3. **Dedupe**: keep `id -> response` for 24 h (Room/SQLite). A repeated `id` returns the stored response and never runs again.
4. **Confirm**: if `confirm == "device"`, show a blocking prompt naming the exact action and target; on refusal or no answer within the deadline respond `declined_by_owner`.
5. **Run** with the `deadline_ms` as a hard limit; send an optional `ack` first for slow commands.
6. **Respond once** with `response`. Truncate output on the phone to the sizes in `hello_ack` (`max_result_chars`) and mark `truncated:true`. Unknown method -> `unsupported`.

Do not run two UI-acting commands concurrently; queue them in order.

## 6. Method implementations
| method | implementation |
|---|---|
| `device_info`, `battery`, `network_status`, `permissions`, `list_apps`, `current_app` | standard Android APIs; `permissions` also reports accessibility, Device Owner, notification access |
| `ui_tree` | traverse `rootInActiveWindow` (optionally filtered by `package`), compact text: ref, class, text, contentDescription, viewId, bounds, flags; cap by `max_nodes`; assign node refs valid only for that snapshot |
| `ui_find` | search the live tree by text/desc/id; return refs |
| `ui_action` | `performAction` on a ref (click, long_click, focus, set_text via `ACTION_SET_TEXT`, scroll_*); respond `stale_node` if the ref is no longer valid |
| `global_action` | `performGlobalAction` (back, home, recents, notifications, quick_settings, lock_screen, power_dialog) |
| `tap`, `swipe`, `long_press`, `scroll` | `dispatchGesture`; pixel coordinates; wait for the gesture callback before responding |
| `type_text`, `press_key` | set text on the focused node; keys through global actions / `ACTION_SET_TEXT` / IME where possible |
| `open_app` | launcher intent for the package |
| `lock_now` | `DevicePolicyManager.lockNow()` if Device Owner, otherwise the lock-screen global action |
| `terminal_execute` | allowlist only: `uname,uptime,date,df,whoami,pwd,free,ls`, first word, **reject shell metacharacters**, same rule as the backend |
| `shell_exec` | `sh -c` in the app's own context with `timeout_s` and `max_output_bytes`; capture stdout, stderr, exit code; kill on timeout |
| `app_install` | `PackageInstaller` (silent as Device Owner); download over https only, **verify SHA-256 before installing**, refuse on mismatch |
| `app_uninstall` | `PackageInstaller.uninstall`; **always** `confirm=device` |
| `app_permission` | `setPermissionGrantState` |
| `app_suspend` | `setPackagesSuspended` |
| `set_restriction` | `addUserRestriction` / `clearUserRestriction` (accept only `no_*` keys) |
| `kiosk` | `setLockTaskPackages` + start lock task |
| `reboot` | `DevicePolicyManager.reboot` |
| `wipe` | `wipeData`; **always** `confirm=device`; require the `WIPE` word again on the confirm screen |
| `send_file`, `receive_file` | app-private PhoneBridge folder only; reject path separators; <= ~700 KB |
| `audio_*` | later milestone |

## 7. Security requirements
- Everything read from the phone (notifications, screen text, command output) is **untrusted data**; the app never treats it as instructions and never forwards it anywhere except in command responses.
- Per-action confirmation for destructive actions is implemented in the app and cannot be bypassed by the backend.
- Never auto-approve sessions, never raise a session's level, never extend a TTL.
- Secrets (device token) only in Keystore-backed storage; no secrets in logs or crash reports.
- TLS only; pin nothing yet but fail closed on certificate errors.
- A local audit view in the app lists the commands run (method, time, result code; no typed text or file content).
- Respect FLAG_SECURE windows: do not try to work around them.

## 8. Milestones (stop and report after each)
1. Skeleton: pairing, foreground service, WebSocket, `hello`/`ping`/reconnect, `battery` and `device_info`. Test against the deployed Worker.
2. Session approval UI, local level/TTL enforcement, kill switch, dedupe cache.
3. Accessibility: `ui_tree`, `ui_find`, `ui_action`, `global_action`, gestures, `type_text`, key filter.
4. `terminal_execute`, `shell_exec`, notifications, files.
5. Device Owner tools, then the confirm flow for destructive actions.
6. Doze/OEM hardening and the setup checklist polish. FCM wake-up only if Play services exist and a Firebase project is provided.

## 9. Acceptance tests (run on the real phone, report results honestly)
- Pair, kill the app, reconnect without re-pairing; airplane mode on/off reconnects within ~60 s.
- A command sent twice with the same `id` runs once.
- A `tap` is refused on an observe session; `shell_exec` is refused on an operate session; both are refused after TTL expiry even with the backend unreachable.
- `app_uninstall` and `wipe` never execute without the on-phone confirmation (test with a throwaway app; **do not test `wipe` on a phone with data you care about**).
- Emergency stop ends the session within 1 s and the backend shows it ended.
- Overnight idle test: the connection survives Doze/realme background killing, or the failure is recorded with the settings that were tried.
- Report separately what was verified on the device and what was only unit-tested or assumed. Do not claim an action works unless a tool result or log shows it.

## 10. Working agreements for this repo
- Commit small, on branches; open PRs; do not merge your own PRs unless the owner says so.
- Keep a device test log in `docs/TESTING.md`: date, step, result, what was seen on the phone. Failures stay in the log.
- Never commit tokens, pairing codes, keystores or signing keys. Debug builds only until the owner asks for a release build.
- Ask the owner before anything that touches the phone's data: Device Owner provisioning, account removal, `wipe`, `app_uninstall`.
- When something cannot be verified on the device from the session, say so plainly in the report instead of implying it works.
