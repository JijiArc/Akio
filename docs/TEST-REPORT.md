# Test report (backend only)

Run on: local `wrangler dev` (workerd), `node test/smoke.mjs`. Result: **77 passed, 0 failed** (version 0.3.0, protocol v1).

## Actually executed
Everything in 0.2.0 (health, auth, CORS/Origin, MCP protocol, pairing, offline detection, sessions approve/deny/emergency stop, command relay, terminal allowlist, audit, token rotation, revoke) plus:
- all tools advertised up front, annotations, screenshot tools removed
- session levels (observe/operate/admin): insufficient_level, admin ttl clamp, destructive commands carry confirm=device
- error frames for binary, invalid JSON, unknown command id and oversized frames; ping answered with pong
- fast failure when the socket closes mid-command; non-idempotent commands become `unknown`, idempotent ones are re-queued and complete after reconnect
- offline queue for read-only tools, resend on hello, cancel on session end
- the 15 s timeout path, with the late response stored and retrievable
- oversized results truncated and flagged

The phone is a **simulated WebSocket client written in Node**, not the Android app.

## Not tested
- Xirsys ICE retrieval with real credentials (only the "not configured" path ran locally).
- The deployed Worker at `*.workers.dev`.
- The 90 s liveness expiry (needs a silent socket for 90 s), session expiry by alarm, and real hibernation wake-ups.
- Any WebRTC behavior, FCM wake-ups, and everything Android-side.
