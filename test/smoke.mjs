// Smoke test against a locally running worker (npm run dev). Uses a SIMULATED phone
// (a Node WebSocket client) because the Android app does not exist yet.
import WebSocket from "ws";

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const TOKEN = process.env.TOKEN || "test-token-test-token-test-token-1234";
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${name}${c ? "" : "  " + extra}`); };

let rid = 1;
const rpc = async (method, params, headers = H) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const res = r.body?.result;
  return { rpc: r, data: res ? JSON.parse(res.content[0].text) : null, isError: res?.isError };
};

// --- basics ---
let r = await fetch(`${BASE}/health`);
ok(r.status === 200 && (await r.json()).status === "online", "GET /health");
r = await fetch(`${BASE}/nope`); ok(r.status === 404, "unknown path -> 404");
r = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" }); ok(r.status === 401, "MCP without token -> 401");
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" }); ok(r.status === 401, "MCP wrong token -> 401");
r = await fetch(`${BASE}/mcp`, { method: "GET", headers: H }); ok(r.status === 405, "GET /mcp -> 405");
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...H, Origin: "https://evil.example" }, body: "{}" }); ok(r.status === 403, "disallowed Origin -> 403");
r = await fetch(`${BASE}/mcp`, { method: "OPTIONS", headers: { Origin: "https://claude.ai" } });
ok(r.status === 204 && r.headers.get("access-control-allow-origin") === "https://claude.ai", "CORS preflight allows claude.ai");
r = await fetch(`${BASE}/mcp`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
ok(!r.headers.get("access-control-allow-origin"), "CORS preflight denies other origins");
r = await fetch(`${BASE}/mcp/${TOKEN}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
ok(r.status === 200, "path-token auth works");
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: H, body: "{not json" }); ok(r.status === 400, "invalid JSON -> 400 parse error");

// --- protocol ---
let x = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
ok(x.body.result?.protocolVersion === "2025-03-26" && x.body.result.serverInfo.name === "PhoneBridge", "initialize negotiates version");
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
ok(r.status === 202, "notification -> 202");
x = await rpc("nope"); ok(x.body.error?.code === -32601, "unknown method -> -32601");
x = await rpc("tools/list");
const names0 = x.body.result.tools.map((t) => t.name);
ok(names0.includes("phone_status") && !names0.includes("phone_tap"), "tools/list: core only before any device reports capabilities", names0.join());
x = await rpc("tools/call", { name: "phone_tap", arguments: {} }); ok(x.body.error?.code === -32602, "unadvertised tool -> -32602");

// --- no device yet: honest state ---
let c = await call("phone_status");
ok(c.data.ok && c.data.paired_count === 0, "phone_status: no device paired");
c = await call("phone_start_session", { reason: "test" });
ok(c.isError && c.data.error.code === "no_device_paired", "start_session without device -> real error");
c = await call("phone_start_session", {}); ok(c.isError && c.data.error.code === "invalid_arguments", "input validation rejects missing reason");
c = await call("phone_start_session", { reason: "x", ttl_minutes: 999 }); ok(c.isError && c.data.error.code === "invalid_arguments", "input validation rejects ttl out of range");

// --- pairing ---
r = await fetch(`${BASE}/device/pair`, { method: "POST", body: JSON.stringify({ code: "WRONG123" }) }); ok(r.status === 403, "wrong pairing code rejected");
c = await call("phone_create_pairing_code"); const code = c.data.code; ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), "pairing code created");
r = await fetch(`${BASE}/device/pair`, { method: "POST", body: JSON.stringify({ code, name: "Sim phone", model: "SIM", android_version: "10" }) });
const paired = await r.json(); ok(r.status === 200 && paired.device_token, "pairing succeeds");
r = await fetch(`${BASE}/device/pair`, { method: "POST", body: JSON.stringify({ code }) }); ok(r.status === 403, "pairing code is single-use");
const DT = paired.device_token;
r = await fetch(`${BASE}/device/ice`, { headers: { Authorization: "Bearer nope" } }); ok(r.status === 401, "device endpoints need device token");
r = await fetch(`${BASE}/device/ice`, { headers: { Authorization: `Bearer ${DT}` } });
const ice = await r.json();
ok(r.status === 503 ? ice.error.code === "xirsys_not_configured" : Array.isArray(ice.iceServers), `ICE endpoint (status ${r.status}: ${ice.error?.code || "iceServers returned"})`);
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${DT}` }, body: "{}" }); ok(r.status === 401, "device token cannot call MCP");

c = await call("phone_status"); ok(c.data.paired_count === 1 && c.data.devices[0].online === false, "paired but offline is reported as offline");
c = await call("phone_start_session", { reason: "test" }); ok(c.isError && c.data.error.code === "device_offline", "start_session while offline -> device_offline");

// --- simulated phone over WebSocket ---
const ws = new WebSocket(`${BASE.replace("http", "ws")}/device/ws`, { headers: { Authorization: `Bearer ${DT}` } });
const inbox = [];
ws.on("message", (m) => inbox.push(JSON.parse(m.toString())));
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.send(JSON.stringify({ type: "hello", caps: ["battery", "tap", "terminal_execute", "bogus"], app_version: "sim", battery: { level: 88, charging: false } }));
await new Promise((r) => setTimeout(r, 300));
ok(inbox.some((m) => m.type === "hello_ack" && !m.caps_accepted.includes("bogus")), "hello_ack, unknown caps dropped");
x = await rpc("tools/list"); const names1 = x.body.result.tools.map((t) => t.name);
ok(names1.includes("phone_battery") && names1.includes("phone_tap") && !names1.includes("phone_audio_effect"), "tools/list now advertises only reported device capabilities");
c = await call("phone_status"); ok(c.data.devices[0].online === true && c.data.devices[0].battery.level === 88, "phone_status shows online + battery");

c = await call("phone_battery", { session_id: "00000000-0000-0000-0000-000000000000" }); ok(c.isError && c.data.error.code === "unknown_session", "device tool with bad session rejected");

// session needs approval on the phone
const startP = call("phone_start_session", { reason: "smoke test", ttl_minutes: 5, wait_seconds: 5 });
await new Promise((r) => setTimeout(r, 400));
const req = inbox.find((m) => m.type === "session_request");
ok(!!req && req.reason === "smoke test", "phone receives session_request");
c = await call("phone_battery", { session_id: req.session_id }); ok(c.isError && c.data.error.code === "session_not_approved", "commands blocked before approval");
ws.send(JSON.stringify({ type: "session_decision", session_id: req.session_id, approved: true }));
c = await startP; ok(c.data.status === "active", "approval on phone activates session (wait returned early)");
const SID = req.session_id;

// command relay
ws.on("message", (m) => {
  const j = JSON.parse(m.toString());
  if (j.type !== "command") return;
  if (j.method === "battery") ws.send(JSON.stringify({ type: "response", id: j.id, ok: true, result: { level: 87 } }));
  else if (j.method === "tap") ws.send(JSON.stringify({ type: "response", id: j.id, ok: false, error: { code: "accessibility_disabled", message: "Enable the accessibility service" } }));
  // terminal_execute: never answered -> timeout path tested separately not to slow the suite
});
c = await call("phone_battery", { session_id: SID }); ok(c.data.ok && c.data.result.level === 87, "command relayed and answered by phone");
c = await call("phone_tap", { session_id: SID, x: 10, y: 20 }); ok(c.isError && c.data.error.code === "accessibility_disabled", "device error surfaces as structured tool error");
c = await call("phone_tap", { session_id: SID, x: -1, y: 20 }); ok(c.isError && c.data.error.code === "invalid_arguments", "device tool input validated");
c = await call("phone_terminal_execute", { session_id: SID, command: "rm -rf /" }); ok(c.isError && c.data.error.code === "command_not_allowed", "terminal allowlist blocks rm");
c = await call("phone_terminal_execute", { session_id: SID, command: "uname; id" }); ok(c.isError && c.data.error.code === "command_not_allowed", "terminal blocks shell metacharacters");
c = await call("phone_session_status", { session_id: SID }); ok(c.data.status === "active" && c.data.expires_in_s > 200, "session_status active with remaining time");

// emergency stop from phone
ws.send(JSON.stringify({ type: "emergency_stop" }));
await new Promise((r) => setTimeout(r, 300));
c = await call("phone_session_status", { session_id: SID }); ok(c.data.status === "ended" && c.data.ended_reason === "emergency_stop_by_device", "emergency stop ends session");
c = await call("phone_battery", { session_id: SID }); ok(c.isError && c.data.error.code === "session_not_active", "commands fail after session ends");

// denial path + assistant end
const p2 = call("phone_start_session", { reason: "deny me", wait_seconds: 5 });
await new Promise((r) => setTimeout(r, 400));
const req2 = inbox.filter((m) => m.type === "session_request").pop();
ws.send(JSON.stringify({ type: "session_decision", session_id: req2.session_id, approved: false }));
c = await p2; ok(c.data.status === "denied", "owner can deny a session");

c = await call("phone_start_session", { reason: "end me" });
const sid3 = c.data.session_id;
c = await call("phone_end_session", { session_id: sid3 }); ok(c.data.status === "ended", "assistant can end a session");
ok(inbox.some((m) => m.type === "session_ended" && m.session_id === sid3), "phone notified of session end");

// audit
c = await call("phone_audit_log", { limit: 100 });
ok(c.data.events.some((e) => e.e === "device_paired") && !JSON.stringify(c.data).includes(DT), "audit log present and contains no tokens");

// token rotation
r = await fetch(`${BASE}/device/rotate`, { method: "POST", headers: { Authorization: `Bearer ${DT}` } });
const rot = await r.json(); ok(r.status === 200 && rot.device_token && rot.device_token !== DT, "device token rotation");
r = await fetch(`${BASE}/device/ice`, { headers: { Authorization: `Bearer ${DT}` } }); ok(r.status === 401, "old device token invalid after rotation");

// disconnect + revoke
c = await call("phone_disconnect", { revoke: true }); ok(c.data.ok && c.data.revoked, "disconnect with revoke");
c = await call("phone_status"); ok(c.data.paired_count === 0, "device gone after revoke");
x = await rpc("tools/list"); ok(!x.body.result.tools.some((t) => t.name === "phone_tap"), "device tools disappear after revoke");

ws.terminate();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
