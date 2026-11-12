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
ok(names0.includes("phone_status") && names0.includes("phone_tap") && names0.includes("phone_ui_tree") && names0.includes("phone_command_status"), "tools/list advertises every tool up front", names0.join());
ok(!names0.includes("phone_screen_capture") && !names0.includes("phone_screen_stream"), "screenshot/stream tools are gone");
const tl = x.body.result.tools;
ok(tl.find((t) => t.name === "phone_ui_tree").annotations.readOnlyHint === true && tl.find((t) => t.name === "phone_wipe").annotations.destructiveHint === true, "tool annotations carry read-only / destructive hints");
x = await rpc("tools/call", { name: "phone_nonexistent", arguments: {} }); ok(x.body.error?.code === -32602, "unknown tool -> -32602");

// --- no device yet: honest state ---
let c = await call("phone_tap", { x: 1, y: 1 }); ok(c.isError && c.data.error.code === "invalid_arguments", "device tool without session_id -> invalid_arguments");
c = await call("phone_status");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAPS = ["device_info", "battery", "tap", "terminal_execute", "ui_tree", "shell_exec", "wipe", "app_uninstall", "bogus"];
let ws, inbox, seen; // seen = command frames the phone received
const behaviors = {
  battery: () => ({ ok: true, result: { level: 87 } }),
  ui_tree: () => ({ ok: true, result: { tree: "[n1] FrameLayout\n  [n2] Button 'OK' clickable" } }),
  tap: () => ({ ok: false, error: { code: "accessibility_disabled", message: "Enable the accessibility service" } }),
  shell_exec: () => ({ ok: true, result: { stdout: "hello", exit: 0 } }),
  wipe: () => ({ ok: true, result: { wiping: true } }),
  // terminal_execute: unanswered unless a test says otherwise
};
async function connect(token = DT, hello = { v: 1, caps: CAPS, app_version: "sim", battery: { level: 88, charging: false } }) {
  inbox = []; seen = [];
  const w = new WebSocket(`${BASE.replace("http", "ws")}/device/ws`, { headers: { Authorization: `Bearer ${token}` } });
  ws = w;
  w.on("message", (m) => {
    const raw = m.toString();
    let j; try { j = JSON.parse(raw); } catch { inbox.push({ type: "raw", raw }); return; }
    inbox.push(j);
    if (j.type === "command") {
      seen.push(j);
      const b = behaviors[j.method];
      if (b) w.send(JSON.stringify({ type: "response", id: j.id, ...b(j) }));
    }
  });
  await new Promise((res, rej) => { w.on("open", res); w.on("error", rej); });
  if (hello) { w.send(JSON.stringify({ type: "hello", ...hello })); await sleep(300); }
  return w;
}
await connect();
ok(inbox.some((m) => m.type === "hello_ack" && m.v === 1 && m.ping_text === "ping" && !m.caps_accepted.includes("bogus")), "hello_ack (v1, ping contract), unknown caps dropped");
c = await call("phone_status"); ok(c.data.devices[0].online === true && c.data.devices[0].battery.level === 88, "phone_status shows online + battery");

c = await call("phone_battery", { session_id: "00000000-0000-0000-0000-000000000000" }); ok(c.isError && c.data.error.code === "unknown_session", "device tool with bad session rejected");

// session needs approval on the phone
const startP = call("phone_start_session", { reason: "smoke test", ttl_minutes: 5, wait_seconds: 5 });
await sleep(400);
const req = inbox.find((m) => m.type === "session_request");
ok(!!req && req.reason === "smoke test" && req.level === "operate", "phone receives session_request with the level being asked for");
c = await call("phone_battery", { session_id: req.session_id }); ok(c.isError && c.data.error.code === "session_not_approved", "commands blocked before approval");
ws.send(JSON.stringify({ type: "session_decision", session_id: req.session_id, approved: true }));
c = await startP; ok(c.data.status === "active", "approval on phone activates session (wait returned early)");
const SID = req.session_id;

// command relay
c = await call("phone_battery", { session_id: SID }); ok(c.data.ok && c.data.result.level === 87, "command relayed and answered by phone");
c = await call("phone_tap", { session_id: SID, x: 10, y: 20 }); ok(c.isError && c.data.error.code === "accessibility_disabled", "device error surfaces as structured tool error");
c = await call("phone_tap", { session_id: SID, x: -1, y: 20 }); ok(c.isError && c.data.error.code === "invalid_arguments", "device tool input validated");
c = await call("phone_terminal_execute", { session_id: SID, command: "rm -rf /" }); ok(c.isError && c.data.error.code === "command_not_allowed", "terminal allowlist blocks rm");
c = await call("phone_terminal_execute", { session_id: SID, command: "uname; id" }); ok(c.isError && c.data.error.code === "command_not_allowed", "terminal blocks shell metacharacters");
c = await call("phone_session_status", { session_id: SID }); ok(c.data.status === "active" && c.data.expires_in_s > 200, "session_status active with remaining time");

// --- protocol v1: observe/act levels, frames, liveness ---
c = await call("phone_ui_tree", { session_id: SID }); ok(c.data.ok && c.data.result.tree.includes("Button"), "read tool (ui_tree) relayed");
c = await call("phone_shell_exec", { session_id: SID, command: "id" }); ok(c.isError && c.data.error.code === "insufficient_level", "admin tool refused on an operate session");
c = await call("phone_tap", { session_id: SID, x: 1, y: 1, queue_ttl_s: 60 }); ok(c.isError && c.data.error.code === "invalid_arguments", "acting tools cannot be queued (schema has no queue_ttl_s)");
c = await call("phone_wipe", { session_id: SID, confirm: "yes" }); ok(c.isError && c.data.error.code === "invalid_arguments", "wipe requires the exact confirm word");

ws.send(Buffer.from([1, 2, 3]));
ws.send("{not json");
ws.send(JSON.stringify({ type: "response", id: "00000000-0000-0000-0000-000000000000", ok: true }));
ws.send("x".repeat(1_000_001));
ws.send("ping");
await sleep(500);
const errs = inbox.filter((m) => m.type === "error").map((m) => m.code);
ok(["binary_not_supported", "bad_json", "unknown_command", "frame_too_large"].every((k) => errs.includes(k)), "bad frames get error frames (no silent drops)", errs.join());
ok(inbox.some((m) => m.type === "raw" && m.raw === "pong"), "ping text answered with pong by the runtime");

// fast-fail: phone disappears while a (non-idempotent) command is in flight
let t0 = Date.now();
const inflight = call("phone_terminal_execute", { session_id: SID, command: "uname" });
await sleep(400);
ws.close();
c = await inflight;
ok(c.isError && c.data.error.code === "device_disconnected" && c.data.error.outcome === "unknown" && Date.now() - t0 < 4000, "in-flight call fails fast on disconnect (no 15s wait)", JSON.stringify(c.data));
const lostId = c.data.error.command_id;
c = await call("phone_command_status", { command_id: lostId }); ok(c.data.state === "unknown", "non-idempotent command is marked unknown, not retried");
await sleep(300);
c = await call("phone_status"); ok(c.data.devices[0].online === false, "status shows offline right after the socket closes");

// offline: queue only idempotent reads
c = await call("phone_battery", { session_id: SID }); ok(c.isError && c.data.error.code === "device_offline", "offline without queue -> device_offline");
c = await call("phone_tap", { session_id: SID, x: 1, y: 1 }); ok(c.isError && c.data.error.code === "device_offline", "offline tap -> device_offline (never queued)");
c = await call("phone_battery", { session_id: SID, queue_ttl_s: 120 }); ok(c.data.ok && c.data.queued && c.data.command_id, "idempotent read is queued while offline");
const qid = c.data.command_id;
await connect(); // reconnect: hello triggers resend
await sleep(500);
c = await call("phone_command_status", { command_id: qid });
ok(c.data.state === "done" && c.data.result.level === 87 && c.data.attempts === 1, "queued command re-sent on reconnect and answered", JSON.stringify(c.data));
ok(seen.some((f) => f.id === qid && f.idempotent === true && f.risk === "read" && f.confirm === "none"), "command frame carries id, risk, idempotent, confirm");

// idempotent in flight: kept for retry after reconnect
behaviors.ui_tree_saved = behaviors.ui_tree; delete behaviors.ui_tree;
t0 = Date.now();
const inflight2 = call("phone_ui_tree", { session_id: SID });
await sleep(400);
ws.close();
c = await inflight2;
ok(c.isError && c.data.error.code === "device_disconnected" && c.data.error.outcome === "queued_for_retry_on_reconnect", "idempotent in-flight command is re-queued", JSON.stringify(c.data));
const rid2 = c.data.error.command_id;
behaviors.ui_tree = behaviors.ui_tree_saved;
await connect(); await sleep(500);
c = await call("phone_command_status", { command_id: rid2 }); ok(c.data.state === "done" && c.data.result.tree, "re-queued command completes after reconnect", JSON.stringify(c.data));

// big output is capped, not dropped
behaviors.battery = () => ({ ok: true, result: { stdout: "A".repeat(150000) } });
c = await call("phone_battery", { session_id: SID });
ok(c.data.ok && c.data.result.truncated === true && c.data.result.original_chars > 150000 && c.data.result.preview.length === 60000, "oversized result is truncated and flagged");
behaviors.battery = () => ({ ok: true, result: { level: 87 } });

// timeout path: late answer is stored, not lost
t0 = Date.now();
c = await call("phone_terminal_execute", { session_id: SID, command: "uptime" });
ok(c.isError && c.data.error.code === "timeout" && Date.now() - t0 >= 14000 && Date.now() - t0 < 20000, "unanswered command times out after ~15s with command_id", `${Date.now() - t0}ms ${JSON.stringify(c.data)}`);
const tid = c.data.error.command_id;
ws.send(JSON.stringify({ type: "response", id: tid, ok: true, result: { stdout: "up 3 days" } }));
await sleep(300);
c = await call("phone_command_status", { command_id: tid }); ok(c.data.state === "done" && c.data.result.stdout === "up 3 days", "late response after timeout is stored and retrievable");

// emergency stop from phone
ws.send(JSON.stringify({ type: "emergency_stop" }));
await sleep(300);
c = await call("phone_session_status", { session_id: SID }); ok(c.data.status === "ended" && c.data.ended_reason === "emergency_stop_by_device", "emergency stop ends session");
c = await call("phone_battery", { session_id: SID }); ok(c.isError && c.data.error.code === "session_not_active", "commands fail after session ends");

// denial path + assistant end
const p2 = call("phone_start_session", { reason: "deny me", wait_seconds: 5 });
await sleep(400);
const req2 = inbox.filter((m) => m.type === "session_request").pop();
ws.send(JSON.stringify({ type: "session_decision", session_id: req2.session_id, approved: false }));
c = await p2; ok(c.data.status === "denied", "owner can deny a session");

c = await call("phone_start_session", { reason: "end me" });
const sid3 = c.data.session_id;
c = await call("phone_end_session", { session_id: sid3 }); ok(c.data.status === "ended", "assistant can end a session");
ok(inbox.some((m) => m.type === "session_ended" && m.session_id === sid3), "phone notified of session end");

// --- admin session: destructive actions carry a per-action confirm flag ---
c = await call("phone_start_session", { reason: "admin test", level: "admin", ttl_minutes: 480, wait_seconds: 5 });
await sleep(400);
const reqA = inbox.filter((m) => m.type === "session_request").pop();
ok(reqA.level === "admin" && reqA.ttl_seconds === 3600, "admin level asked of the owner and ttl clamped to 60 min", JSON.stringify(reqA));
ws.send(JSON.stringify({ type: "session_decision", session_id: reqA.session_id, approved: true }));
await sleep(300);
const ASID = reqA.session_id;
c = await call("phone_shell_exec", { session_id: ASID, command: "id" }); ok(c.data.ok && c.data.result.stdout === "hello", "admin session may run shell_exec");
c = await call("phone_wipe", { session_id: ASID, confirm: "WIPE" });
ok(c.data.ok && seen.some((f) => f.method === "wipe" && f.risk === "destructive" && f.confirm === "device"), "destructive command is sent with confirm=device for the phone to enforce");

// ending a session cancels its queued commands
ws.close(); await sleep(300);
c = await call("phone_battery", { session_id: ASID, queue_ttl_s: 300 }); const cq = c.data.command_id;
c = await call("phone_end_session", { session_id: ASID });
c = await call("phone_command_status", { command_id: cq }); ok(c.data.state === "cancelled", "ending the session cancels queued commands");
await connect();

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
c = await call("phone_battery", { session_id: SID }); ok(c.isError, "device tools fail (not vanish) once the device is gone");

ws.terminate();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
