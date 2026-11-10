import { DurableObject } from "cloudflare:workers";
import { sha256Hex, randomToken, randomCode, normalizeCode, clip } from "./util.js";
import { KNOWN_CAPS } from "./tools.js";

const PAIR_TTL_MS = 10 * 60 * 1000;
const APPROVAL_WINDOW_MS = 120 * 1000;
const ONLINE_WINDOW_MS = 90 * 1000;
const MAX_MSG = 1_000_000;

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
  }

  // ---------------- helpers ----------------
  async #audit(e, extra = {}) {
    const log = (await this.ctx.storage.get("audit")) || [];
    log.push({ t: new Date().toISOString(), e, ...extra });
    while (log.length > 200) log.shift();
    await this.ctx.storage.put("audit", log);
  }

  #online(id) {
    return this.ctx.getWebSockets("dev:" + id).length > 0;
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
    for (const old of this.ctx.getWebSockets("dev:" + id)) {
      try { old.close(4000, "replaced by newer connection"); } catch { /* ignore */ }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["dev:" + id]);
    await this.#patchDevice(id, { last_seen: Date.now() });
    await this.#audit("device_connected", { device_id: id });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    const tag = this.ctx.getTags(ws).find((t) => t.startsWith("dev:"));
    if (!tag) return;
    const id = tag.slice(4);
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (!m || typeof m.type !== "string") return;
    const now = Date.now();

    switch (m.type) {
      case "hello": {
        const caps = Array.isArray(m.caps) ? [...new Set(m.caps.filter((c) => KNOWN_CAPS.includes(c)))] : [];
        await this.#patchDevice(id, {
          caps,
          app_version: clip(m.app_version, 20),
          battery: m.battery ?? null,
          network: m.network ?? null,
          last_seen: now,
        });
        ws.send(JSON.stringify({ type: "hello_ack", server_time: now, heartbeat_interval_s: 30, caps_accepted: caps }));
        await this.#audit("device_hello", { device_id: id, caps: caps.length });
        break;
      }
      case "heartbeat":
        await this.#patchDevice(id, { last_seen: now, battery: m.battery ?? null, network: m.network ?? null });
        ws.send(JSON.stringify({ type: "pong", server_time: now }));
        break;
      case "response": {
        const p = this.pending.get(m.id);
        if (!p || p.device_id !== id) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        p.resolve(m.ok ? { ok: true, result: m.result ?? null } : err(clip(m.error?.code, 40) || "device_error", clip(m.error?.message, 300) || "Device reported an error."));
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
    if (tag) await this.#audit("device_disconnected", { device_id: tag.slice(4) });
    try { ws.close(1000, "bye"); } catch { /* ignore */ }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
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
        online: this.#online(d.id) && now - d.last_seen < ONLINE_WINDOW_MS,
        last_seen_age_s: d.last_seen ? Math.round((now - d.last_seen) / 1000) : null,
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
  async startSession({ device_id, reason, ttl_minutes = 15, wait_seconds = 0 }) {
    await this.#sweep();
    const p = await this.#pickDevice(device_id);
    if (!p.ok) return p;
    const d = p.device;
    if (!this.#online(d.id)) return err("device_offline", `"${d.name}" is not connected right now. Open the PhoneBridge app on the phone and check its connection.`);
    const live = await this.#liveSessions(d.id);
    if (live.length) return err("session_exists", "A session is already pending or active for this device.", { session: this.#view(live[0]) });
    const now = Date.now();
    const s = {
      id: crypto.randomUUID(),
      device_id: d.id,
      status: "pending",
      reason: clip(reason, 200),
      ttl_ms: Math.min(60, Math.max(1, ttl_minutes)) * 60000,
      created: now,
      approval_deadline: now + APPROVAL_WINDOW_MS,
      expires_at: now + APPROVAL_WINDOW_MS,
    };
    await this.ctx.storage.put("sess:" + s.id, s);
    this.#send(d.id, {
      type: "session_request",
      session_id: s.id,
      reason: s.reason,
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
  async command({ session_id, cap, params, timeout_ms = 15000 }) {
    await this.#sweep();
    const s = await this.ctx.storage.get("sess:" + session_id);
    if (!s) return err("unknown_session", "No such session.");
    if (s.status === "pending") return err("session_not_approved", "The phone owner has not approved this session yet.");
    if (s.status !== "active") return err("session_not_active", `Session is ${s.status}${s.ended_reason ? ` (${s.ended_reason})` : ""}.`);
    const d = await this.ctx.storage.get("dev:" + s.device_id);
    if (!d) return err("unknown_device", "Device was unpaired.");
    if (!this.#online(d.id)) return err("device_offline", "The phone is not connected.");
    if (!(d.caps || []).includes(cap)) return err("capability_unavailable", `The phone has not reported the "${cap}" capability (missing permission or not supported by this app version).`);

    const id = crypto.randomUUID();
    const result = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(err("timeout", `The phone did not answer within ${Math.round(timeout_ms / 1000)}s.`));
      }, timeout_ms);
      this.pending.set(id, { device_id: d.id, session_id, resolve, timer });
    });
    if (!this.#send(d.id, { type: "command", id, session_id, method: cap, params })) {
      const p = this.pending.get(id);
      if (p) { clearTimeout(p.timer); this.pending.delete(id); }
      return err("device_offline", "The phone is not connected.");
    }
    const r = await result;
    await this.#audit("command", { device_id: d.id, session_id, method: cap, ok: r.ok });
    return r;
  }
}
