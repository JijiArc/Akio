# PhoneBridge backend: deploy from the browser (no PC)

The Worker now has several files and a Durable Object, so the dashboard's single-file editor is not enough. The easiest browser-only route is **GitHub + Cloudflare's Git integration**.

## 1. Put the project on GitHub
1. github.com → **New repository** → name it `phonebridge` (private is best).
2. **Add file → Upload files**, drag in everything from this folder (`src/`, `wrangler.jsonc`, `package.json`, `.gitignore`, `docs/`, `plugin/`, `test/`). Do **not** upload `node_modules` or `.dev.vars`.

## 2. Connect it to the existing Worker
1. dash.cloudflare.com → **Workers & Pages** → `phonebridge-mcp` → **Settings** → **Build** (labels may differ slightly) → **Connect** to Git and choose the repo.
2. Deploy command: `npx wrangler deploy`. Branch: `main`.
3. The first deploy applies the Durable Object migration (`v1`, class `Hub`).
4. `wrangler.jsonc` sets `keep_vars: true`, so variables you set in the dashboard are kept, and **secrets are never touched** by deploys. The name `phonebridge-mcp` matches your existing Worker, so it is updated in place.

## 3. Secrets
Already present: `PHONEBRIDGE_MCP_TOKEN` (the assistant token). It must be long and random (32+ characters). Replace it under **Settings → Variables and Secrets** if it is short.

### Xirsys secret names
I could not read your secret names from here. The Worker looks for these (first match wins):

| Field | Names it accepts |
|---|---|
| ident | `XIRSYS_IDENT`, `XIRSYS_USERNAME`, `XIRSYS_USER` |
| secret | `XIRSYS_SECRET`, `XIRSYS_KEY`, `XIRSYS_PASSWORD`, `XIRSYS_API_KEY` |
| channel | `XIRSYS_CHANNEL` |
| gateway (optional) | `XIRSYS_GATEWAY`, `XIRSYS_HOST` (default `global.xirsys.net`) |

Also accepted: one secret `XIRSYS_AUTH` = `ident:secret`, or `XIRSYS_URL` = `https://ident:secret@gateway/_turn/channel`.

If your existing names differ, add a plain **variable** (not secret) `XIRSYS_BINDINGS` with JSON mapping, e.g. `{"ident":"MY_IDENT_NAME","secret":"MY_SECRET_NAME","channel":"MY_CHANNEL_NAME"}`. No code change and no need to reveal values.

Check it: once a phone is paired, `phone_connection_status` reports which logical fields were found and which secret **names** matched.

## 4. Verify
- Open `https://phonebridge-mcp.ikira0x0.workers.dev/health` → `{"status":"online","version":"0.2.0"}`.
- Connect Claude (below), call `phone_status`. Before the Android app exists it truthfully reports no paired devices.

## 5. Connect Claude
**Claude Code / Cowork plugin:** zip the `plugin/` folder (or add it from a repo), install it, and set the environment variable `PHONEBRIDGE_MCP_TOKEN` to your token. The plugin sends it as a Bearer header.

**Custom connector in claude.ai:** Add the URL `https://phonebridge-mcp.ikira0x0.workers.dev/mcp/<YOUR_TOKEN>`. As far as I know the connector form has no field for a custom header, so the token goes in the path (the Worker accepts `/mcp/<token>`). A token in a URL can appear in logs, so use a token dedicated to this and rotate it if the URL ever leaks. Verify the current form options in your connector settings.

ChatGPT: same URL options; use whichever auth method its connector screen offers.

## What is and is not built
- Built and tested locally: everything in the Worker (see `docs/TEST-REPORT.md`).
- Not built yet: the Android app. Device tools (`phone_tap`, `phone_screen_capture`, ...) are defined and relayed, but they only appear in the tool list after a phone reports the capability.
- Design note: the Worker cannot be a WebRTC peer. Commands travel over the authenticated signaling WebSocket through the Durable Object. `/device/ice` hands the phone Xirsys ICE servers for a later direct WebRTC channel (screen streaming to a viewer page).
