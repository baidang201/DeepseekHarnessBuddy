# dsh-hardware-buddy

A self-contained [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) **host (Node.js)** plugin that mirrors agent state onto a CodeBuddy / StickS3 hardware pet over USB CDC, and routes the device's physical **A/B approval buttons** back into the dsh `approval/request` waterfall.

- 📟 **State mirror** — `agent/status`, `session/*`, `session/event` are aggregated into a compact JSON heartbeat (with a hard **900-byte** cap) pushed to the device on a fixed interval (default 3s), not per-event.
- ✅ **Physical approval** — dangerous tools prompt on the device; **A** = allow-once, **B** = reject. Excluded tools (e.g. `MCP__danger_*`) fall through to the dsh Web UI instead.
- 🔌 **Plug & play** — auto-discovers the StickS3 by USB VID `0x303A` (optionally PID), with a `cu.usbmodem*` / `ttyACM*` name fallback. Tolerates unplug/replug (5s reconnect poll) and never crashes the plugin if the device is absent.

> This plugin only runs on the **host (Node.js)** side. It deliberately does **not** declare `dsh.client` and must not be bundled into the browser client (it depends on the native `serialport` module).

## Install

```bash
dsh plugin add @dsh-hardware-buddy/dsh-hardware-buddy
```

The plugin ships a `dsh.bundle` manifest (`cordis.patch.yml`) that dsh applies automatically. If you prefer to manage it by hand, add this entry to your profile patch (e.g. `$DSH_HOME/profiles/<name>/cordis.patch.yml` — this is also the file dsh's HMR watches):

```yaml
- insert:
  - id: hardware-buddy
    name: '@dsh-hardware-buddy/dsh-hardware-buddy'
    config:
      port: null                 # null = auto-discover
      vendorId: '0x303A'
      productId: null
      approvalTimeout: 30000     # ms before an unanswered prompt auto-cancels
      heartbeatIntervalMs: 3000  # full-snapshot interval (<< device 30s window)
      dangerousTools: []         # regex list routed to the hardware screen
      excludedTools:
        - '^MCP__danger_.*'      # regex list routed to the Web UI approval
      celebrateThreshold: 50000
      entriesLimit: 5
      logLevel: info
```

Config changes in `cordis.patch.yml` hot-reload via dsh's HMR — no restart needed.

## Safety model (important)

The plugin follows the Cordis **waterfall** rule strictly: *not calling `next()` vetoes the entire chain, including the Web UI*. Therefore the plugin **only takes over** an approval when **(a)** the tool is not on the `excludedTools` list **and (b)** the device is currently online. In every other case — device offline, excluded tool, a missing `agent`/`callId` on the exec, or any internal error — it calls `next()`, delegating to the Web UI / default policy.

The plugin **never** produces an `unavailable` outcome and **never** denies a tool for its own reasons. A timeout or a runtime abort resolves to `cancelled` (which dsh maps to a deny with a "cancelled" reason) — that is dsh's policy, not the plugin refusing.

## Permissions (Linux)

On Linux the serial device node is normally owned by the `dialout` group. If you see permission errors:

```bash
sudo usermod -aG dialout $USER
# then log out / back in (or reboot) for the group to take effect
```

macOS enumerates the device as `/dev/cu.usbmodem*` with no extra setup.

## Development

```bash
npm install
npm test      # vitest unit tests (protocol / bridge / approval)
npm run lint  # oxlint
npx tsc -p tsconfig.json --noEmit   # type check
npm run build # emit dist/
```

The package is fully self-contained: `tsconfig.json` does not extend any external config and `npm install` works without a workspace/pnpm setup. Unit tests do not require a real dsh runtime or a connected device.

## Probe plugin

`probe.ts` is a standalone companion entry (run inside a real dsh profile) that dumps the live event payloads, the real tool-name list (so `dangerousTools` defaults can be finalized), and the measured VID/PID. It is excluded from the build and from `oxlint src/`.
