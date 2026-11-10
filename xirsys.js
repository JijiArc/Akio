// Xirsys ICE/TURN retrieval. Reads whatever secret names actually exist on the Worker.
// Nothing here ever returns or logs secret VALUES.

const ALIASES = {
  ident: ["XIRSYS_IDENT", "XIRSYS_USERNAME", "XIRSYS_USER", "XIRSYS_IDENTITY"],
  secret: ["XIRSYS_SECRET", "XIRSYS_KEY", "XIRSYS_PASSWORD", "XIRSYS_API_KEY", "XIRSYS_API_SECRET"],
  channel: ["XIRSYS_CHANNEL", "XIRSYS_CHANNEL_NAME"],
  gateway: ["XIRSYS_GATEWAY", "XIRSYS_HOST", "XIRSYS_DOMAIN", "XIRSYS_PATH"],
};

function resolve(env) {
  let map = {};
  try { map = JSON.parse(env.XIRSYS_BINDINGS || "{}"); } catch { /* ignore */ }
  const out = {};
  const used = {};
  for (const k of Object.keys(ALIASES)) {
    const names = [...(map[k] ? [map[k]] : []), ...ALIASES[k]];
    for (const n of names) {
      if (typeof env[n] === "string" && env[n]) { out[k] = env[n]; used[k] = n; break; }
    }
  }
  if ((!out.ident || !out.secret) && typeof env.XIRSYS_AUTH === "string" && env.XIRSYS_AUTH.includes(":")) {
    const i = env.XIRSYS_AUTH.indexOf(":");
    out.ident = env.XIRSYS_AUTH.slice(0, i);
    out.secret = env.XIRSYS_AUTH.slice(i + 1);
    used.ident = used.secret = "XIRSYS_AUTH";
  }
  if (typeof env.XIRSYS_URL === "string" && env.XIRSYS_URL) {
    try {
      const u = new URL(env.XIRSYS_URL);
      if (u.username && !out.ident) { out.ident = decodeURIComponent(u.username); used.ident = "XIRSYS_URL"; }
      if (u.password && !out.secret) { out.secret = decodeURIComponent(u.password); used.secret = "XIRSYS_URL"; }
      if (!out.gateway) { out.gateway = u.hostname; used.gateway = "XIRSYS_URL"; }
      const m = u.pathname.match(/\/_turn\/([^/]+)/);
      if (m && !out.channel) { out.channel = decodeURIComponent(m[1]); used.channel = "XIRSYS_URL"; }
    } catch { /* ignore */ }
  }
  out.gateway = (out.gateway || "global.xirsys.net").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return { out, used };
}

/** Safe to show: which logical fields were found and under which secret NAME. */
export function xirsysStatus(env) {
  const { out, used } = resolve(env);
  const missing = ["ident", "secret", "channel"].filter((k) => !out[k]);
  return { configured: missing.length === 0, missing, found_bindings: used };
}

export async function getIceServers(env) {
  const { out } = resolve(env);
  const missing = ["ident", "secret", "channel"].filter((k) => !out[k]);
  if (missing.length) {
    return {
      ok: false,
      error: {
        code: "xirsys_not_configured",
        message: `Xirsys settings not found on the Worker for: ${missing.join(", ")}. Add them as secrets (see docs/DEPLOY.md, "Xirsys secret names") or map your existing names with the XIRSYS_BINDINGS variable.`,
      },
    };
  }
  try {
    const res = await fetch(`https://${out.gateway}/_turn/${encodeURIComponent(out.channel)}`, {
      method: "PUT",
      headers: {
        Authorization: "Basic " + btoa(`${out.ident}:${out.secret}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ format: "urls" }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.s === "error") {
      return { ok: false, error: { code: "xirsys_rejected", message: `Xirsys returned HTTP ${res.status}${data?.s ? ` (${data.s})` : ""}. Check ident/secret/channel.` } };
    }
    const raw = data?.v?.iceServers;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((s) => ({
      urls: s.urls ?? s.url,
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    }));
    if (!list.length) return { ok: false, error: { code: "xirsys_empty", message: "Xirsys returned no ICE servers." } };
    return { ok: true, iceServers: list };
  } catch (e) {
    return { ok: false, error: { code: "xirsys_unreachable", message: `Could not reach Xirsys: ${e?.name === "TimeoutError" ? "timeout" : "network error"}.` } };
  }
}
