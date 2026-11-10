# PhoneBridge (Akio)

Cloudflare Worker + Durable Object that lets Claude control your own Android phone through MCP, with on-phone approval for every session.

```
src/      Worker, Durable Object, MCP server, Xirsys ICE
test/     smoke test (simulated phone)
docs/     DEPLOY.md, SECURITY.md, TEST-REPORT.md
plugin/   Claude plugin (MCP config + skill)
```

Deploy: see `docs/DEPLOY.md`. Status: backend done and tested locally; Android app not built yet.
