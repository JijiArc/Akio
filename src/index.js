import { Hub } from "./hub.js";
import { handleRpc } from "./mcp.js";
import { getIceServers } from "./xirsys.js";
import { safeEqual, bearer, corsHeaders, allowedOrigins, json } from "./util.js";

export { Hub };

const MAX_BODY = 1_000_000;

async function readJson(request, max = MAX_BODY) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > max) return { error: "too_large" };
  const text = await request.text();
  if (text.length > max) return { error: "too_large" };
  try { return { value: JSON.parse(text) }; } catch { return { error: "parse" }; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      // Preflight carries no credentials; it only reveals which origins are allowed.
      return new Response(null, { status: 204, headers: cors });
    }

    if (path === "/health" && request.method === "GET") {
      return json({ service: "PhoneBridge MCP", status: "online", version: "0.3.0" }, 200, cors);
    }

    const hub = env.HUB.get(env.HUB.idFromName("main"));

    // ---------------- assistant side: MCP ----------------
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      const origin = request.headers.get("Origin");
      if (origin && !allowedOrigins(env).includes(origin)) return json({ error: "Origin not allowed" }, 403);

      if (!env.PHONEBRIDGE_MCP_TOKEN) return json({ error: "Server authentication is not configured" }, 503, cors);

      // Header auth (preferred). The path form /mcp/<token> exists only for clients that cannot send headers.
      let supplied = bearer(request);
      if (!supplied && path.startsWith("/mcp/")) supplied = decodeURIComponent(path.slice(5));
      if (!supplied || !(await safeEqual(supplied, env.PHONEBRIDGE_MCP_TOKEN))) {
        return json({ error: "Unauthorized" }, 401, { ...cors, "WWW-Authenticate": 'Bearer realm="phonebridge"' });
      }

      if (request.method !== "POST") {
        // Streamable HTTP: we do not offer a server-initiated SSE stream or session deletion.
        return json({ error: "Use POST for MCP requests" }, 405, { ...cors, Allow: "POST, OPTIONS" });
      }

      const r = await readJson(request);
      if (r.error === "too_large") return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413, cors);
      if (r.error) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400, cors);

      const out = await handleRpc(r.value, { env, hub });
      if (out === null) return new Response(null, { status: 202, headers: cors });
      return json(out, 200, cors);
    }

    // ---------------- phone side ----------------
    if (path === "/device/pair" && request.method === "POST") {
      const r = await readJson(request, 4096);
      if (r.error || !r.value || typeof r.value.code !== "string") return json({ error: "Bad request" }, 400);
      const res = await hub.pair(r.value.code, r.value);
      if (!res.ok) return json({ error: res.error }, res.error.code === "locked" ? 429 : 403);
      return json({ device_id: res.device_id, device_token: res.device_token, ws_url: `wss://${url.host}/device/ws` });
    }

    if (path.startsWith("/device/")) {
      const deviceId = await hub.authDevice(bearer(request));
      if (!deviceId) return json({ error: "Unauthorized" }, 401);

      if (path === "/device/ws") {
        const h = new Headers(request.headers);
        h.set("X-Device-Id", deviceId); // set only after authentication
        return hub.fetch(new Request(request, { headers: h }));
      }
      if (path === "/device/ice" && request.method === "GET") {
        const ice = await getIceServers(env);
        return json(ice.ok ? { iceServers: ice.iceServers } : { error: ice.error }, ice.ok ? 200 : 503);
      }
      if (path === "/device/rotate" && request.method === "POST") {
        const res = await hub.rotateDeviceToken(deviceId);
        return json(res.ok ? { device_token: res.device_token } : { error: res.error }, res.ok ? 200 : 400);
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
