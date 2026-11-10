# PhoneBridge security model (backend)

- **Two separate credentials.** Assistant token (`PHONEBRIDGE_MCP_TOKEN`, Worker secret) for `/mcp`. Device tokens (random 256-bit, issued at pairing, only SHA-256 hashes stored) for `/device/*`. A device token cannot call MCP and vice versa.
- **Constant-time comparison** of the assistant token.
- **Pairing:** one-time 8-character code, 10-minute expiry, one active code at a time, stored hashed, 8 failed attempts per 10 minutes locks pairing.
- **Session approval:** commands are refused until the owner approves on the phone. The assistant has no approve tool. Approval window 2 minutes; sessions last 1 to 60 minutes (default 15) and expire server-side by alarm.
- **Emergency stop:** the phone can end all sessions instantly; the assistant can end or disconnect and optionally revoke (unpair) a device.
- **Capability gating:** a device tool is advertised and callable only if the phone reported that capability; unknown capabilities are dropped.
- **Input validation** on every tool; terminal commands pass an allowlist and a no-shell-metacharacter rule (the phone must enforce it again).
- **CORS / Origin:** browser origins limited to `ALLOWED_ORIGINS`; other browser origins get 403 (DNS-rebinding protection). Server-to-server clients without an Origin header are unaffected.
- **Audit log** (last 200 events): pairing, sessions, command method names and success flags. It never stores typed text, file contents or tokens.
- **Credential rotation:** `POST /device/rotate` replaces the device token; replace `PHONEBRIDGE_MCP_TOKEN` in the dashboard at any time.
- **Xirsys:** credentials stay in Worker secrets, are used only server-side, and are never returned or logged. Only the short-lived ICE servers are given to an authenticated device.

## Known limits
- The `/mcp/<token>` path form puts the token in a URL (logs). Prefer the header form when your client supports it.
- No per-token rate limiting on `/mcp` beyond Cloudflare's platform protections; use a long random token. Add a Cloudflare WAF rate-limit rule if you want more.
- Frames and files go through the WebSocket (1 MiB message cap), so file transfer is limited to roughly 700 KB per call until the WebRTC data channel exists.
