---
name: phonebridge
description: Use when the user wants to check on, pair, or control their own Android phone through PhoneBridge (battery, screenshots, taps, typing, opening apps, notifications, files, voice-changer audio). Covers pairing, session approval and honest reporting.
---

# PhoneBridge

PhoneBridge relays commands to the user's own Android phone through a Cloudflare Worker. Only trust what tool results say.

## Workflow

1. Call `phone_status`. If `paired_count` is 0, call `phone_create_pairing_code` and tell the user to enter the code in the PhoneBridge Android app within 10 minutes. If the device is offline, say so; do not proceed as if it were connected.
2. To act on the phone, call `phone_start_session` with a clear `reason` (it is shown to the owner). Use `wait_seconds` (up to 25) to wait for the answer. **Approval happens only on the phone.** Never try to work around it, and never say a session is active unless the result says `status: "active"`.
3. Pass the returned `session_id` to every device tool. Device tools only appear in the tool list when the phone app has reported that capability (and the needed Android permission). If a tool is missing, tell the user which permission or app feature is missing rather than guessing.
4. When finished, call `phone_end_session`. If the user asks to cut access, call `phone_disconnect` (add `revoke: true` to unpair completely).

## Rules

- Report failures exactly as returned (`device_offline`, `session_not_approved`, `capability_unavailable`, `timeout`). Never claim an action succeeded without `ok: true`.
- Ask the user before sensitive actions: typing into messaging or banking apps, sending files, reading notifications, recording audio.
- Do not read out or store tokens, pairing codes after use, or private screen content beyond what the task needs.
- `phone_terminal_execute` only runs allow-listed commands with no shell operators; do not try to bypass the allowlist.
- Sessions expire (default 15 minutes). Start a new one and get approval again if needed.
