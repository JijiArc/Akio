# Test report (backend only)

Run on: local `wrangler dev` (workerd), `node test/smoke.mjs`. Result: **52 passed, 0 failed**.

## Actually executed
Health, 404, auth (missing/wrong token, device token rejected on MCP), CORS preflight allow/deny, Origin 403, GET 405, invalid JSON, `initialize` version negotiation, notifications (202), unknown method, `tools/list` (core only, then capability-gated), unknown tool, input validation (core and device tools), pairing (wrong code, single use, success), offline detection, Durable Object WebSocket hello/heartbeat, session request -> approve/deny/emergency stop/end, command relay incl. device errors, terminal allowlist, audit log (no tokens), token rotation, revoke.

The phone in these tests was a **simulated WebSocket client written in Node**, not the Android app.

## Not tested
- Xirsys ICE retrieval with real credentials (only the "not configured" path ran locally).
- The deployed Worker at `*.workers.dev` (I cannot deploy or reach it from here).
- Command timeout path, session expiry by alarm, and hibernation wake-ups.
- Any WebRTC behavior (direct, TURN, reconnection), and everything Android-side.
