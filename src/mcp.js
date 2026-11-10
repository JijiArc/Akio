import { TOOLS, validate } from "./tools.js";
import { xirsysStatus } from "./xirsys.js";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "PhoneBridge", version: "0.2.0" };

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolOut = (id, obj) => {
  const isError = obj && obj.ok === false;
  return rpcOk(id, { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError });
};

/** Returns a response object, an array of them (batch), or null (nothing to send back). */
export async function handleRpc(body, c) {
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcErr(null, -32600, "Invalid Request: empty batch");
    if (body.length > 20) return rpcErr(null, -32600, "Invalid Request: batch too large");
    const out = (await Promise.all(body.map((m) => one(m, c)))).filter(Boolean);
    return out.length ? out : null;
  }
  return one(body, c);
}

async function one(msg, c) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcErr(msg && typeof msg === "object" ? msg.id : null, -32600, "Invalid Request");
  }
  const { id, method } = msg;
  const isNotification = id === undefined;

  if (method.startsWith("notifications/")) return null;
  if (isNotification) return null; // unknown notification: ignore

  try {
    switch (method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return rpcOk(id, {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions:
            "PhoneBridge controls the owner's Android phone. Call phone_status first. To control the phone you must call phone_start_session and the owner must approve it on the phone; never claim an action happened unless a tool result says ok. Device tools only appear once the Android app reports that capability.",
        });
      }
      case "ping":
        return rpcOk(id, {});
      case "tools/list": {
        const caps = await c.hub.capabilities();
        const tools = TOOLS.filter((t) => !t.cap || caps.includes(t.cap)).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return rpcOk(id, { tools });
      }
      case "tools/call":
        return await callTool(id, msg.params, c);
      default:
        return rpcErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    console.error("rpc error", method, e?.message);
    return rpcErr(id, -32603, "Internal error");
  }
}

function terminalAllowed(env, command) {
  if (/[;&|`$<>(){}\\\n\r*?~!"'#]/.test(command)) return "Shell metacharacters are not allowed.";
  const allow = String(env.TERMINAL_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  const first = command.trim().split(/\s+/)[0];
  if (!allow.includes(first)) return `Command "${first}" is not on the allowlist (${allow.join(", ") || "empty"}).`;
  return null;
}

async function callTool(id, params, c) {
  const name = params?.name;
  const tool = TOOLS.find((t) => t.name === name);
  const caps = await c.hub.capabilities();
  if (!tool || (tool.cap && !caps.includes(tool.cap))) return rpcErr(id, -32602, `Unknown tool: ${name}`);

  const args = params.arguments ?? {};
  const v = validate(args, tool.inputSchema);
  if (!v.ok) return toolOut(id, { ok: false, error: { code: "invalid_arguments", message: v.error } });

  const hub = c.hub;
  switch (name) {
    case "phone_status":
      return toolOut(id, await hub.status());
    case "phone_connection_status": {
      const st = await hub.status();
      const dev = args.device_id ? st.devices.find((d) => d.device_id === args.device_id) : st.devices[0];
      if (!dev) return toolOut(id, { ok: false, error: { code: "no_device_paired", message: "No matching paired device." } });
      return toolOut(id, { ok: true, device: dev, xirsys: xirsysStatus(c.env), transport: "websocket-signaling-via-durable-object" });
    }
    case "phone_create_pairing_code":
      return toolOut(id, await hub.createPairing());
    case "phone_start_session":
      return toolOut(id, await hub.startSession(args));
    case "phone_session_status":
      return toolOut(id, await hub.sessionStatus(args.session_id));
    case "phone_end_session":
      return toolOut(id, await hub.endSession(args.session_id));
    case "phone_disconnect":
      return toolOut(id, await hub.disconnectDevice(args));
    case "phone_audit_log":
      return toolOut(id, await hub.auditLog(args.limit ?? 25));
  }

  // device tool -> relay
  if (name === "phone_terminal_execute") {
    const why = terminalAllowed(c.env, args.command);
    if (why) return toolOut(id, { ok: false, error: { code: "command_not_allowed", message: why } });
  }
  const { session_id, ...rest } = args;
  const timeout = name === "phone_audio_record" ? (rest.duration_s + 10) * 1000 : 15000;
  return toolOut(id, await hub.command({ session_id, cap: tool.cap, params: rest, timeout_ms: timeout }));
}
