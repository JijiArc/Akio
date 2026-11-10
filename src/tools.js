// Tool registry + a small JSON-schema validator.
// Core tools are implemented by the Worker itself.
// Device tools (cap != null) are relayed to the paired Android app and are only
// advertised in tools/list once a paired device has reported that capability.

const S = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const SID = { type: "string", minLength: 36, maxLength: 36, description: "Active session id from phone_start_session." };
const num = (min, max, description) => ({ type: "number", minimum: min, maximum: max, description });
const int = (min, max, description) => ({ type: "integer", minimum: min, maximum: max, description });
const dev = (name, description, props = {}, req = [], extra = {}) => ({
  name,
  cap: name.replace(/^phone_/, ""),
  description,
  inputSchema: S({ session_id: SID, ...props }, ["session_id", ...req]),
  ...extra,
});

export const EFFECTS = ["monster", "alien", "robot", "digital_monster", "ghost"];
export const KEYS = ["back", "home", "recents", "notifications", "enter", "delete"];

export const TOOLS = [
  // ---------------- core (implemented in the Worker) ----------------
  {
    name: "phone_status",
    cap: null,
    description: "Overview of paired devices: online state, last heartbeat, last reported battery/network, advertised capabilities and any live session. Never fabricates a connection.",
    inputSchema: S(),
  },
  {
    name: "phone_connection_status",
    cap: null,
    description: "Connection diagnostics for one device (or the only paired device): websocket presence, heartbeat age, live session, and whether Xirsys ICE is configured.",
    inputSchema: S({ device_id: { type: "string", maxLength: 64 } }),
  },
  {
    name: "phone_create_pairing_code",
    cap: null,
    description: "Create a one-time pairing code (valid 10 minutes) to enter in the PhoneBridge Android app. Replaces any previous unused code.",
    inputSchema: S(),
  },
  {
    name: "phone_start_session",
    cap: null,
    description: "Ask the phone's owner for permission to control the device. The session stays pending until the owner approves it ON THE PHONE; there is no way to approve it from here. Optionally wait up to 25s for the decision.",
    inputSchema: S({
      device_id: { type: "string", maxLength: 64 },
      reason: { type: "string", minLength: 3, maxLength: 200, description: "Shown to the phone owner on the approval prompt." },
      ttl_minutes: int(1, 60, "Session length after approval. Default 15."),
      wait_seconds: int(0, 25, "Wait for approval before returning. Default 0."),
    }, ["reason"]),
  },
  {
    name: "phone_session_status",
    cap: null,
    description: "Status of a session: pending, active, denied, expired or ended, with remaining time.",
    inputSchema: S({ session_id: SID }, ["session_id"]),
  },
  {
    name: "phone_end_session",
    cap: null,
    description: "End a session immediately and notify the phone.",
    inputSchema: S({ session_id: SID }, ["session_id"]),
  },
  {
    name: "phone_disconnect",
    cap: null,
    description: "End every live session for a device and close its connection. With revoke=true the device is also unpaired and its token destroyed (it must be paired again).",
    inputSchema: S({ device_id: { type: "string", maxLength: 64 }, revoke: { type: "boolean" } }),
  },
  {
    name: "phone_audit_log",
    cap: null,
    description: "Recent security audit events (pairing, sessions, commands by method name only, disconnects). Contains no typed text or file contents.",
    inputSchema: S({ limit: int(1, 100, "Default 25.") }),
  },

  // ---------------- device tools (relayed to the Android app) ----------------
  dev("phone_battery", "Battery level and charging state."),
  dev("phone_network_status", "Wi-Fi/cellular connectivity summary."),
  dev("phone_permissions", "Which Android permissions/services (accessibility, screen capture, notification access, microphone) are currently granted."),
  dev("phone_screen_capture", "Capture one screenshot (requires screen-capture permission on the phone). Returns a base64 JPEG."),
  dev("phone_screen_stream", "Start or stop screen streaming to the authorised session.", { action: { type: "string", enum: ["start", "stop"] } }, ["action"]),
  dev("phone_tap", "Tap at screen pixel coordinates (requires the accessibility service).", { x: num(0, 10000), y: num(0, 10000) }, ["x", "y"]),
  dev("phone_swipe", "Swipe between two points.", { x1: num(0, 10000), y1: num(0, 10000), x2: num(0, 10000), y2: num(0, 10000), duration_ms: int(50, 3000) }, ["x1", "y1", "x2", "y2"]),
  dev("phone_long_press", "Long press at a point.", { x: num(0, 10000), y: num(0, 10000), duration_ms: int(300, 3000) }, ["x", "y"]),
  dev("phone_scroll", "Scroll the focused view.", { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: int(1, 10) }, ["direction"]),
  dev("phone_type_text", "Type text into the focused input field.", { text: { type: "string", maxLength: 2000 } }, ["text"]),
  dev("phone_press_key", "Press a navigation/system key.", { key: { type: "string", enum: KEYS } }, ["key"]),
  dev("phone_open_app", "Launch an installed app by package name.", { package: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$", maxLength: 200 } }, ["package"]),
  dev("phone_list_apps", "List launchable installed apps."),
  dev("phone_current_app", "Foreground app package, where Android reports it."),
  dev("phone_notifications", "Recent notifications (requires notification access).", { limit: int(1, 50) }),
  dev("phone_send_file", "Send a small file (<= ~700 KB) to the phone's PhoneBridge folder.", {
    name: { type: "string", minLength: 1, maxLength: 120, pattern: "^[^/\\\\]+$" },
    mime: { type: "string", maxLength: 100 },
    data_base64: { type: "string", maxLength: 960000 },
  }, ["name", "data_base64"]),
  dev("phone_receive_file", "Fetch a file the phone owner has explicitly shared with PhoneBridge.", { file_id: { type: "string", maxLength: 64 } }, ["file_id"]),
  dev("phone_audio_record", "Record microphone audio (microphone permission required).", { duration_s: int(1, 60) }, ["duration_s"]),
  dev("phone_audio_playback", "Play a recording on the phone.", { recording_id: { type: "string", maxLength: 64 } }, ["recording_id"]),
  dev("phone_audio_effect", "Apply a voice effect to a recording.", {
    recording_id: { type: "string", maxLength: 64 },
    effect: { type: "string", enum: EFFECTS },
    intensity: num(0, 1, "0 to 1, default 0.5."),
  }, ["recording_id", "effect"]),
  dev("phone_audio_export", "Export a recording; messenger=true produces a Messenger-compatible voice note.", {
    recording_id: { type: "string", maxLength: 64 },
    messenger: { type: "boolean" },
  }, ["recording_id"]),
  dev("phone_terminal_execute", "Run an allow-listed command through Termux. The command allowlist and a no-shell-metacharacters rule are enforced both here and on the phone.", {
    command: { type: "string", minLength: 1, maxLength: 200 },
  }, ["command"]),
];

export const KNOWN_CAPS = TOOLS.filter((t) => t.cap).map((t) => t.cap);

/** Minimal JSON-schema validation: type, required, enum, min/max, length, pattern, additionalProperties. */
export function validate(value, schema, path = "arguments") {
  const t = schema.type;
  if (t === "object") {
    if (value === undefined) value = {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) return bad(path, "must be an object");
    for (const k of schema.required || []) if (!(k in value)) return bad(path, `missing required field "${k}"`);
    for (const k of Object.keys(value)) {
      if (!(k in (schema.properties || {}))) {
        if (schema.additionalProperties === false) return bad(path, `unexpected field "${k}"`);
        continue;
      }
      const r = validate(value[k], schema.properties[k], `${path}.${k}`);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (t === "string") {
    if (typeof value !== "string") return bad(path, "must be a string");
    if (schema.minLength != null && value.length < schema.minLength) return bad(path, `must be at least ${schema.minLength} characters`);
    if (schema.maxLength != null && value.length > schema.maxLength) return bad(path, `must be at most ${schema.maxLength} characters`);
    if (schema.enum && !schema.enum.includes(value)) return bad(path, `must be one of ${schema.enum.join(", ")}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return bad(path, "has an invalid format");
    return { ok: true };
  }
  if (t === "number" || t === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return bad(path, "must be a number");
    if (t === "integer" && !Number.isInteger(value)) return bad(path, "must be an integer");
    if (schema.minimum != null && value < schema.minimum) return bad(path, `must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) return bad(path, `must be <= ${schema.maximum}`);
    return { ok: true };
  }
  if (t === "boolean") return typeof value === "boolean" ? { ok: true } : bad(path, "must be a boolean");
  return { ok: true };
}
const bad = (path, msg) => ({ ok: false, error: `${path} ${msg}` });
