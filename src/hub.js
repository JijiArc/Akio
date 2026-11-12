import { DurableObject } from "cloudflare:workers";
import { sha256Hex, randomToken, randomCode, normalizeCode, clip } from "./util.js";
import { KNOWN_CAPS, LEVELS, RISK_LEVEL } from "./tools.js";

const PAIR_TTL_MS = 10 * 60 * 1000;
const APPROVAL_WINDOW_MS = 120 * 1000;
const ONLINE_WINDOW_MS = 90 * 1000;
const MAX_MSG = 1_000_000;
const MAX_RESULT = 60_000; // characters of a stored/returned command result
const PROTOCOL_VERSION = 1;
const PING_INTERVAL_S = 25; // the phone sends the literal text "ping"; the runtime answers "pong" without waking the Hub
const COMMAND_KEEP_MS = 24 * 3600 * 1000;

const err = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });

/**
 * One Hub instance ("main") holds all state: pairing codes, devices, sessions,
 * audit log. It also terminates the phone's WebSocket (hibernation API) and
 * relays commands from MCP tool calls to the phone and back.
 */
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map(); // command id -> {device_id, session_id, resolve, timer}
    this.waiters = new Map(); // session id -> resolve (phone_start_session wait)
    // Ping/pong is answered by the runtime, so keep-alives do not wake the Hub or write to storage.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql = this.ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, session_id TEXT NOT NULL, method TEXT NOT NULL,
      params TEXT NOT NULL, risk TEXT NOT NULL, idempotent INTEGER NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      sent_at INTEGER, acked_at INTEGER, done_at INTEGER, result TEXT, error TEXT)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS commands_dev_state ON commands (device_id, state)");
  }

  // ---------------- command table ----------------
  #cmd(id) {
    return this.sql.exec("SELECT * FROM commands WHERE id = ?", id).toArray()[0] || null;
  }

  #cmdSet(id, fields) {
    const keys = Object.keys(fields);
    this.sql.exec(`UPDATE commands SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
  }

  #cmdView(r) {
    const out = { command_id: r.id, method: r.method, state: r.state, risk: r.risk, attempts: r.attempts, created_age_s: Math.round((Date.now() - r.created) / 1000) };
    if (r.state === "done" && r.result) out.result = JSON.parse(r.result);
    if (r.state === "failed" && r.error) out.error = JSON.parse(r.error);
    if (r.state === "unknown") out.note = "The phone may or may not have executed this. Observe the phone's state before retrying anything that is not idempotent.";
    return out;
  }

  /** Cap a result so one runaway command cannot flood storage or the assistant's context. */
  #capResult(v) {
    const text = JSON.stringify(v ?? null);
    if (text.length <= MAX_RESULT) return v ?? null;
    return { truncated: true, original_chars: text.length, preview: text.slice(0, MAX_RESULT) };
  }

  // ---------------- helpers ----------------
  async #audit(e, extra = {}) {
    const log = (await this.ctx.storage.get("audit")) || [];
    log.push({ t: new Date().toISOString(), e, ...extra });
    while (log.length > 200) log.shift();
    await this.ctx.storage.put("audit", log);
  }

  /** Socket present AND heard from recently. Pings answered by the runtime count (auto-response timestamp). */
  async #online(id, dev) {
    const sockets = this.ctx.getWebSockets("dev:" + id);
    if (sockets.length === 0) return false;
    const d = dev || (await this.ctx.storage.get("dev:" + id));
    let seen = d?.last_seen || 0;
    for (const ws of sockets) {
      const t = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (t) seen = Math.max(seen, t.getTime());
    }
    return Date.now() - seen < ONLINE_WINDOW_MS;
  }

  #frameError(ws, code, message, extra = {}) {
    try { ws.send(JSON.stringify({ type: "error", code, message, ...extra })); } catch { /* closed */ }
  }

  async #devices() {
    const m = await this.ctx.storage.list({ prefix: "dev:" });
    return [...m.values()];
  }

  async #pickDevice(device_id) {
    if (device_id) {
      const d = await this.ctx.storage.get("dev:" + device_id);
      return d ? { ok: true, device: d } : err("unknown_device", "No such paired device.");
    }
    const all = await this.#devices();
    if (all.length === 0) return err("no_device_paired", "No Android device is paired yet. Use phone_create_pairing_code and enter the code in the PhoneBridge app.");
    if (all.length > 1) return err("device_ambiguous", "Several devices are paired; pass device_id.", { device_ids: all.map((d) => d.id) });
    return { ok: true, device: all[0] };
  }

  async #patchDevice(id, patch) {
    const d = await this.ctx.storage.get("dev:" + id);
    if (!d) return null;
    const n = { ...d, ...patch };
    await this.ctx.storage.put("dev:" + id, n);
    return n;
  }

  #send(id, obj) {
    let sent = false;
    for (const ws of this.ctx.getWebSockets("dev:" + id)) {
      try { ws.send(JSON.stringify(obj)); sent = true; } catch { /* closed */ }
    }
    return sent;
  }

  async #liveSessions(device_id) {
    const now = Date.now();
    const m = await this.ctx.storage.list({ prefix: "sess:" });
    return [...m.values()].filter(
      (s) => (!device_id || s.device_id === device_id) && (s.status === "pending" || s.status === "active") && now < s.expires_at,
    );
  }

  async #sweep() {
    const now = Date.now();
    const m = await this.ctx.storage.list({ prefix: "sess:" });
    for (const s of m.values()) {
      if ((s.status === "pending" || s.status === "active") && now >= s.expires_at) {
        await this.#finish(s, "expired", s.status === "pending" ? "approval_timeout" : "session_expired");
      } else if (s.status !== "pending" && s.status !== "active" && now - s.expires_at > 24 * 3600 * 1000) {
        await this.ctx.storage.delete("sess:" + s.id);
      }
    }
    const now2 = Date.now();
    this.sql.exec("UPDATE commands SET state = 'expired', done_at = ? WHERE state = 'queued' AND expires_at < ?", now2, now2);
    this.sql.exec("DELETE FROM commands WHERE created < ?", now2 - COMMAND_KEEP_MS);
    await this.#schedule();
  }

  async #schedule() {
    const live = await this.#liveSessions();
    if (live.length) {
      const next = Math.min(...live.map((s) => s.expires_at));
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    }
  }

  async alarm() {
    await this.#sweep();
  }

  async #finish(s, status, reason) {
    s.status = status;
    s.ended_reason = reason;
    s.ended_at = Date.now();
    await this.ctx.storage.put("sess:" + s.id, s);
    this.#send(s.device_id, { type: "session_ended", session_id: s.id, reason });
    this.sql.exec("UPDATE commands SET state = 'cancelled', done_at = ? WHERE session_id = ? AND state = 'queued'", Date.now(), s.id);
    for (const [cid, p] of this.pending) {
      if (p.session_id === s.id) {
        clearTimeout(p.timer);
        this.pending.delete(cid);
        p.resolve(err("session_ended", `Session ended (${reason}).`));
      }
    }
    const w = this.waiters.get(s.id);
    if (w) { this.waiters.delete(s.id); w(); }
    await this.#audit("session_" + status, { device_id: s.device_id, session_id: s.id, reason });
  }

  #view(s) {
    return {
      session_id: s.id,
      device_id: s.device_id,
      status: s.status,
      level: s.level || "operate",
      reason: s.reason,
      expires_in_s: s.status === "pending" || s.status === "active" ? Math.max(0, Math.round((s.expires_at - Date.now()) / 1000)) : 0,
      ended_reason: s.ended_reason,
    };
  }

  // ---------------- pairing & device auth ----------------
  async createPairing() {
    for (const k of (await this.ctx.storage.list({ prefix: "pair:" })).keys()) await this.ctx.storage.delete(k);
    const code = randomCode(8);
    const exp = Date.now() + PAIR_TTL_MS;
    await this.ctx.storage.put("pair:" + (await sha256Hex(code)), { exp });
    await this.#audit("pairing_code_created");
    return { ok: true, code: code.slice(0, 4) + "-" + code.slice(4), expires_in_s: PAIR_TTL_MS / 1000 };
  }

  async pair(codeIn, info = {}) {
    const now = Date.now();
    let fails = ((await this.ctx.storage.get("pairfails")) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (fails.length >= 8) return err("locked", "Too many wrong pairing codes. Try again in 10 minutes.");
    const key = "pair:" + (await sha256Hex(normalizeCode(codeIn)));
    const rec = await this.ctx.storage.get(key);
    if (!rec || now > rec.exp) {
      fails.push(now);
      await this.ctx.storage.put("pairfails", fails);
      await this.#audit("pairing_failed");
      return err("invalid_or_expired_code", "Pairing code is invalid or expired.");
    }
    await this.ctx.storage.delete(key);
    const id = crypto.randomUUID();
    const token = randomToken(32);
    const th = await sha256Hex(token);
    await this.ctx.storage.put("dev:" + id, {
      id,
      name: clip(info.name, 60) || "Android phone",
      model: clip(info.model, 60),
      android_version: clip(info.android_version, 20),
      app_version: clip(info.app_version, 20),
      token_hash: th,
      caps: [],
      battery: null,
      network: null,
      created: now,
      last_seen: 0,
    });
    await this.ctx.storage.put("tok:" + th, id);
    await this.#audit("device_paired", { device_id: id });
    return { ok: true, device_id: id, device_token: token };
  }

  async authDevice(token) {
    if (!token) return null;
    const id = await this.ctx.storage.get("tok:" + (await sha256Hex(token)));
    if (!id) return null;
    const d = await this.ctx.storage.get("dev:" + id);
    return d ? id : null;
  }

  async rotateDeviceToken(id) {
    const d = await this.ctx.storage.get("dev:" + id);
    if (!d) return err("unknown_device", "Unknown device.");
    const token = randomToken(32);
    const th = await sha256Hex(token);
    await this.ctx.storage.delete("tok:" + d.token_hash);
    await this.ctx.storage.put("tok:" + th, id);
    await this.#patchDevice(id, { token_hash: th });
    await this.#audit("token_rotated", { device_id: id });
    return { ok: true, device_token: token };
  }

  // ---------------- device websocket ----------------
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const id = request.headers.get("X-Device-Id");
    if (!id || !(await this.ctx.storage.get("dev:" + id))) return new Response("Unknown device", { status: 403 });
    const replaced = this.ctx.getWebSockets("dev:" + id);
    for (const old of replaced) {
      try { old.close(4000, "replaced by newer connection"); } catch { /* ignore */ }
    }
    if (replaced.length) await this.#onDisconnect(id, "replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["dev:" + id]);
    await this.#patchDevice(id, { last_seen: Date.now() });
    await this.#audit("device_connected", { device_id: id });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    const tag = this.ctx.getTags(ws).find((t) => t.startsWith("dev:"));
    if (!tag) return;
    const id = tag.slice(4);
    if (typeof message !== "string") return this.#frameError(ws, "binary_not_supported", "Binary frames are not supported; send JSON text frames.");
    if (message.length > MAX_MSG) return this.#frameError(ws, "frame_too_large", `Frame exceeds ${MAX_MSG} characters and was dropped. Truncate results on the phone.`, { max: MAX_MSG });
    let m;
    try { m = JSON.parse(message); } catch { return this.#frameError(ws, "bad_json", "Frame is not valid JSON."); }
    if (!m || typeof m.type !== "string") return this.#frameError(ws, "bad_frame", "Frame needs a string \"type\".");
    const now = Date.now();

    switch (m.type) {
      case "hello": {
        if (m.v !== undefined && m.v !== PROTOCOL_VERSION) {
          this.#frameError(ws, "unsupported_version", `Server speaks protocol v${PROTOCOL_VERSION}.`, { supported: [PROTOCOL_VERSION] });
          try { ws.close(4002, "unsupported protocol version"); } catch { /* ignore */ }
          return;
        }
        const caps = Array.isArray(m.caps) ? [...new Set(m.caps.filter((c) => KNOWN_CAPS.includes(c)))] : [];
        await this.#patchDevice(id, {
          caps,
          app_version: clip(m.app_version, 20),
          battery: m.battery ?? null,
          network: m.network ?? null,
          last_seen: now,
        });
        ws.send(JSON.stringify({ type: "hello_ack", v: PROTOCOL_VERSION, server_time: now, ping_text: "ping", ping_interval_s: PING_INTERVAL_S, max_frame_chars: MAX_MSG, max_result_chars: MAX_RESULT, caps_accepted: caps }));
        await this.#audit("device_hello", { device_id: id, caps: caps.length });
        await this.#resend(id);
        break;
      }
      case "heartbeat": // optional rich status; liveness itself is the literal "ping" text frame
        await this.#patchDevice(id, { last_seen: now, battery: m.battery ?? null, network: m.network ?? null });
        ws.send(JSON.stringify({ type: "pong", server_time: now }));
        break;
      case "ack": {
        const r = typeof m.id === "string" ? this.#cmd(m.id) : null;
        if (r && r.device_id === id && r.state === "sent") this.#cmdSet(r.id, { acked_at: now });
        break;
      }
      case "response": {
        const r = typeof m.id === "string" ? this.#cmd(m.id) : null;
        if (!r || r.device_id !== id) return this.#frameError(ws, "unknown_command", "No such command for this device.", { id: m.id });
        if (r.state === "done" || r.state === "failed") break; // duplicate answer
        // Stored even when nobody is waiting any more (timeout, or the Hub was evicted): late results are never lost.
        if (m.ok) this.#cmdSet(r.id, { state: "done", done_at: now, result: JSON.stringify(this.#capResult(m.result)) });
        else this.#cmdSet(r.id, { state: "failed", done_at: now, error: JSON.stringify({ code: clip(m.error?.code, 40) || "device_error", message: clip(m.error?.message, 300) || "Device reported an error." }) });
        const p = this.pending.get(r.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(r.id);
          p.resolve(this.#answer(this.#cmd(r.id)));
        }
        break;
      }
      case "session_decision": {
        const s = await this.ctx.storage.get("sess:" + m.session_id);
        if (!s || s.device_id !== id || s.status !== "pending" || now >= s.approval_deadline) return;
        if (m.approved === true) {
          s.status = "active";
          s.approved_at = now;
          s.expires_at = now + s.ttl_ms;
          await this.ctx.storage.put("sess:" + s.id, s);
          await this.#audit("session_approved", { device_id: id, session_id: s.id });
          const w = this.waiters.get(s.id);
          if (w) { this.waiters.delete(s.id); w(); }
          await this.#schedule();
        } else {
          await this.#finish(s, "denied", "denied_by_owner");
        }
        break;
      }
      case "emergency_stop": {
        for (const s of await this.#liveSessions(id)) await this.#finish(s, "ended", "emergency_stop_by_device");
        await this.#audit("emergency_stop", { device_id: id });
        break;
      }
    }
  }

  async webSocketClose(ws) {
    const tag = this.ctx.getTags(ws).find((t) => t.startsWith("dev:"));
    if (tag) {
      const id = tag.slice(4);
      await this.#audit("device_disconnected", { device_id: id });
      // A newer connection may already have replaced this one; only fail work when none is left.
      if (this.ctx.getWebSockets("dev:" + id).filter((w) => w !== ws).length === 0) await this.#onDisconnect(id, "socket_closed");
    }
    try { ws.close(1000, "bye"); } catch { /* ignore */ }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /** The phone is gone: wake every waiting tool call at once instead of letting it run into its timeout. */
  async #onDisconnect(id, reason) {
    for (const [cid, p] of [...this.pending]) {
      if (p.device_id !== id) continue;
      clearTimeout(p.timer);
      this.pending.delete(cid);
      const r = this.#cmd(cid);
      if (r && r.state === "sent") {
        // Idempotent commands are re-sent after reconnect; others cannot be known to have run or not.
        this.#cmdSet(cid, { state: r.idempotent ? "queued" : "unknown" });
      }
      p.resolve(err("device_disconnected", `The phone disconnected (${reason}) before answering.`, {
        command_id: cid,
        outcome: r && r.idempotent ? "queued_for_retry_on_reconnect" : "unknown",
      }));
    }
    // Sent-but-unanswered commands that no waiter holds (Hub was evicted) get the same treatment.
    this.sql.exec("UPDATE commands SET state = CASE WHEN idempotent = 1 THEN 'queued' ELSE 'unknown' END WHERE device_id = ? AND state = 'sent'", id);
  }

  /** After a reconnect: re-send queued commands (idempotent ones, or ones queued while offline). */
  async #resend(id) {
    const now = Date.now();
    const rows = this.sql.exec("SELECT * FROM commands WHERE device_id = ? AND state = 'queued' AND expires_at > ? ORDER BY created", id, now).toArray();
    for (const r of rows) {
      const s = await this.ctx.storage.get("sess:" + r.session_id);
      if (!s || s.status !== "active") { this.#cmdSet(r.id, { state: "cancelled", done_at: now }); continue; }
      if (this.#push(r)) this.#cmdSet(r.id, { state: "sent", sent_at: now, attempts: r.attempts + 1 });
    }
  }

  #push(r) {
    return this.#send(r.device_id, {
      type: "command", v: PROTOCOL_VERSION, id: r.id, session_id: r.session_id, method: r.method, params: JSON.parse(r.params),
      risk: r.risk, idempotent: !!r.idempotent, confirm: r.risk === "destructive" ? "device" : "none",
      attempt: r.attempts + 1, deadline_ms: Math.max(1000, r.expires_at - Date.now()),
    });
  }

  #answer(r) {
    if (r.state === "done") return { ok: true, command_id: r.id, result: JSON.parse(r.result) };
    if (r.state === "failed") { const e = JSON.parse(r.error); return err(e.code, e.message, { command_id: r.id }); }
    return err("not_finished", `Command is ${r.state}.`, { command_id: r.id, state: r.state });
  }

  // ---------------- queries ----------------
  async status() {
    await this.#sweep();
    const now = Date.now();
    const out = [];
    for (const d of await this.#devices()) {
      const live = await this.#liveSessions(d.id);
      out.push({
        device_id: d.id,
        name: d.name,
        model: d.model,
        android_version: d.android_version,
        app_version: d.app_version,
        online: await this.#online(d.id, d),
        websocket_present: this.ctx.getWebSockets("dev:" + d.id).length > 0,
        last_seen_age_s: d.last_seen ? Math.round((now - d.last_seen) / 1000) : null,
        queued_commands: this.sql.exec("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND state IN ('queued','sent')", d.id).one().n,
        capabilities: d.caps,
        battery: d.battery,
        network: d.network,
        session: live[0] ? this.#view(live[0]) : null,
      });
    }
    const pairing = [...(await this.ctx.storage.list({ prefix: "pair:" })).values()].some((p) => p.exp > now);
    return { ok: true, devices: out, paired_count: out.length, pairing_code_active: pairing };
  }

  async capabilities() {
    return [...new Set((await this.#devices()).flatMap((d) => d.caps || []))];
  }

  async auditLog(limit = 25) {
    const log = (await this.ctx.storage.get("audit")) || [];
    return { ok: true, events: log.slice(-limit).reverse() };
  }

  // ---------------- sessions ----------------
  async startSession({ device_id, reason, level = "operate", ttl_minutes = 15, wait_seconds = 0 }) {
    await this.#sweep();
    const p = await this.#pickDevice(device_id);
    if (!p.ok) return p;
    const d = p.device;
    if (!(await this.#online(d.id, d))) return err("device_offline", `"${d.name}" is not connected right now (no socket, or no ping for ${ONLINE_WINDOW_MS / 1000}s). Open the PhoneBridge app on the phone and check its connection.`);
    const live = await this.#liveSessions(d.id);
    if (live.length) return err("session_exists", "A session is already pending or active for this device.", { session: this.#view(live[0]) });
    const now = Date.now();
    const s = {
      id: crypto.randomUUID(),
      device_id: d.id,
      status: "pending",
      level: LEVELS.includes(level) ? level : "operate",
      reason: clip(reason, 200),
      ttl_ms: Math.min(level === "admin" ? 60 : 480, Math.max(1, ttl_minutes)) * 60000,
      created: now,
      approval_deadline: now + APPROVAL_WINDOW_MS,
      expires_at: now + APPROVAL_WINDOW_MS,
    };
    await this.ctx.storage.put("sess:" + s.id, s);
    this.#send(d.id, {
      type: "session_request",
      session_id: s.id,
      reason: s.reason,
      level: s.level,
      ttl_seconds: s.ttl_ms / 1000,
      approval_window_s: APPROVAL_WINDOW_MS / 1000,
    });
    await this.#audit("session_requested", { device_id: d.id, session_id: s.id });
    await this.#schedule();
    if (wait_seconds > 0) {
      await Promise.race([
        new Promise((r) => this.waiters.set(s.id, r)),
        new Promise((r) => setTimeout(r, wait_seconds * 1000)),
      ]);
      this.waiters.delete(s.id);
    }
    return { ok: true, ...this.#view(await this.ctx.storage.get("sess:" + s.id)), note: "The owner must approve this on the phone." };
  }

  async sessionStatus(id) {
    await this.#sweep();
    const s = await this.ctx.storage.get("sess:" + id);
    return s ? { ok: true, ...this.#view(s) } : err("unknown_session", "No such session.");
  }

  async endSession(id, reason = "ended_by_assistant") {
    const s = await this.ctx.storage.get("sess:" + id);
    if (!s) return err("unknown_session", "No such session.");
    if (s.status !== "pending" && s.status !== "active") return { ok: true, ...this.#view(s) };
    await this.#finish(s, "ended", reason);
    return { ok: true, ...this.#view(await this.ctx.storage.get("sess:" + id)) };
  }

  async disconnectDevice({ device_id, revoke = false }) {
    const p = await this.#pickDevice(device_id);
    if (!p.ok) return p;
    const d = p.device;
    for (const s of await this.#liveSessions(d.id)) await this.#finish(s, "ended", "disconnect");
    for (const ws of this.ctx.getWebSockets("dev:" + d.id)) {
      try { ws.close(1000, revoke ? "revoked" : "disconnect"); } catch { /* ignore */ }
    }
    if (revoke) {
      await this.ctx.storage.delete("tok:" + d.token_hash);
      await this.ctx.storage.delete("dev:" + d.id);
    }
    await this.#audit(revoke ? "device_revoked" : "device_disconnected_by_assistant", { device_id: d.id });
    return { ok: true, device_id: d.id, revoked: !!revoke };
  }

  // ---------------- command relay ----------------
  async commandStatus(command_id) {
    const r = this.#cmd(command_id);
    return r ? { ok: true, ...this.#cmdView(r) } : err("unknown_command", "No such command (commands are kept for 24 hours).");
  }

  async command({ session_id, cap, params, risk = "act", idempotent = false, timeout_ms = 15000, queue_ttl_s = 0 }) {
    await this.#sweep();
    const s = await this.ctx.storage.get("sess:" + session_id);
    if (!s) return err("unknown_session", "No such session.");
    if (s.status === "pending") return err("session_not_approved", "The phone owner has not approved this session yet.");
    if (s.status !== "active") return err("session_not_active", `Session is ${s.status}${s.ended_reason ? ` (${s.ended_reason})` : ""}.`);
    const have = s.level || "operate";
    const need = RISK_LEVEL[risk] || "admin";
    if (LEVELS.indexOf(have) < LEVELS.indexOf(need)) {
      return err("insufficient_level", `This tool is "${risk}" and needs session level ${need}; this session was approved for ${have}. Start a new session with level=${need} and have the owner approve it.`);
    }
    const d = await this.ctx.storage.get("dev:" + s.device_id);
    if (!d) return err("unknown_device", "Device was unpaired.");
    if (!(d.caps || []).includes(cap)) return err("capability_unavailable", `The phone has not reported the "${cap}" capability (missing permission or not supported by this app version).`);
    if (queue_ttl_s > 0 && !idempotent) return err("not_queueable", "Only read-only/idempotent tools can be queued; acting commands could fire on a different screen later.");

    const now = Date.now();
    const online = await this.#online(d.id, d);
    if (!online && !(queue_ttl_s > 0)) return err("device_offline", "The phone is not connected (no socket, or no ping within the liveness window).");

    const id = crypto.randomUUID();
    const row = { id, device_id: d.id, session_id, method: cap, params: JSON.stringify(params ?? {}), risk, idempotent: idempotent ? 1 : 0 };
    this.sql.exec(
      "INSERT INTO commands (id, device_id, session_id, method, params, risk, idempotent, state, attempts, created, expires_at) VALUES (?,?,?,?,?,?,?,'queued',0,?,?)",
      row.id, row.device_id, row.session_id, row.method, row.params, row.risk, row.idempotent, now, now + Math.max(timeout_ms, queue_ttl_s * 1000),
    );
    await this.#audit("command", { device_id: d.id, session_id, method: cap, risk, command_id: id });

    if (!online) return { ok: true, queued: true, command_id: id, note: `Phone offline; queued for ${queue_ttl_s}s and sent on reconnect. Fetch the answer with phone_command_status.` };

    const result = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(err("timeout", `The phone did not answer within ${Math.round(timeout_ms / 1000)}s. It may still run the command; check phone_command_status before retrying anything that is not idempotent.`, { command_id: id, outcome: "unknown" }));
      }, timeout_ms);
      this.pending.set(id, { device_id: d.id, session_id, resolve, timer });
    });
    if (!this.#push({ ...row, attempts: 0, expires_at: now + timeout_ms })) {
      const p = this.pending.get(id);
      if (p) { clearTimeout(p.timer); this.pending.delete(id); }
      this.#cmdSet(id, { state: "failed", done_at: Date.now(), error: JSON.stringify({ code: "device_offline", message: "send failed" }) });
      return err("device_offline", "The phone is not connected.");
    }
    this.#cmdSet(id, { state: "sent", sent_at: now, attempts: 1 });
    const r = await result;
    if (!r.ok && r.error?.code === "timeout") await this.#audit("command_timeout", { device_id: d.id, command_id: id, method: cap });
    return r;
  }
}
