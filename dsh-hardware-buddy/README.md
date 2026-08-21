# dsh-hardware-buddy

A self-contained [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) **host (Node.js)** plugin that mirrors agent state onto a CodeBuddy / StickS3 hardware pet over USB CDC, and routes the device's physical **A/B approval buttons** back into the dsh `approval/request` waterfall.

- 📟 **State mirror** — `agent/status`, `session/*`, `session/event` are aggregated into a compact JSON heartbeat (hard **900-byte** cap) pushed to the device every 3s (not per-event).
- ✅ **Physical approval** — dangerous tools prompt on the device; **A** = allow-once, **B** = reject. Excluded tools (e.g. `MCP__danger_*`) fall through to the dsh Web UI instead.
- 🎙️ **Voice feedback** — device speaks the cheerleader clips (approve / deny / error / idle / boot) when approvals resolve.
- 🔌 **Plug & play** — auto-discovers the StickS3 by USB VID `0x303A` (optionally PID), with a `cu.usbmodem*` / `ttyACM*` name fallback. Tolerates unplug/replug (5s reconnect poll) and never crashes the plugin when the device is absent.

> This plugin only runs on the **host (Node.js)** side. It deliberately does **not** declare `dsh.client` and must not be bundled into the browser client (it depends on the native `serialport` module).

---

## Requirements

- **Host**: macOS or Linux, Node.js `^22.19.0 || >=24.0.0`, dsh CLI (`@deepseek-ai/dsh`). Windows is not supported.
- **Device**: an M5Stack StickS3 flashed with the **DSH firmware** (BLE compiled out + USB CDC single channel) from the [DeepseekHarnessBuddy](https://github.com/baidang201/DeepseekHarnessBuddy) repo (`firmware/`). Without the DSH firmware build the USB protocol does not match.

---

## Install (from GitHub Releases)

```bash
dsh plugin --profile <name> add \
  https://github.com/baidang201/DeepseekHarnessBuddy/releases/download/v0.1.0/dsh-hardware-buddy-dsh-hardware-buddy-0.1.0.tgz
```

The package ships a `dsh.bundle` manifest (`cordis.patch.yml`) that dsh applies automatically. Pin to a specific release version by changing `v0.1.0` in the URL (a new version bumps the tarball name too).

If you prefer to manage the entry by hand, add it to your profile patch (e.g. `$DSH_HOME/profiles/<name>/cordis.patch.yml` — this is also the file dsh's HMR watches):

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
      dangerousTools:            # regex list routed to the hardware screen
        - '^bash$'               # defaults finalized from the real 25-tool dump
        - '^write$'              # (all lowercase — see probe-report.md)
        - '^edit$'
        - '^str_replace_editor$'
      excludedTools:
        - '^MCP__danger_.*'      # regex list routed to the Web UI approval
      celebrateThreshold: 50000
      entriesLimit: 5
      logLevel: info
```

Config changes in `cordis.patch.yml` hot-reload via dsh's HMR — no restart needed.

---

## Usage

1. Plug the StickS3 into USB. On first boot after a cold start, **pick the device up once** (see "Screen stays frozen" below) so the display activates.
2. Run dsh (web or headless). The plugin auto-connects and the pet shows the agent state.
3. When a dangerous tool needs approval: the device **beeps**, shows the tool + args on the approval screen, and waits.
   - **A** = allow once · **B** = reject · 30s no response = auto-reject (safe default).
4. Approval results are relayed back into dsh's `approval/request` waterfall; the model continues or stops accordingly.

## Screen stays frozen after boot? (not a bug)

After a cold boot, if the device has never been picked up, the firmware waits for an unambiguous orientation before it starts rendering (an upstream CodeBuddy anti-speculation design): a device lying flat gives ambiguous IMU readings, so the screen keeps the boot frame while beeps and buttons keep working. **Pick the device up once** (hold it upright or sideways) — the orientation is then remembered for the rest of the boot, and the screen renders normally even when you put it back down flat.

## Safety model (important)

The plugin follows the Cordis **waterfall** rule strictly: *not calling `next()` vetoes the entire chain, including the Web UI*. Therefore the plugin **only takes over** an approval when **(a)** the tool is not on the `excludedTools` list **and (b)** the device is currently online. In every other case — device offline, excluded tool, a missing `agent`/`callId` on the exec, or any internal error — it calls `next()`, delegating to the Web UI / default policy.

The plugin **never** produces an `unavailable` outcome and **never** denies a tool for its own reasons. A timeout or a runtime abort resolves to `cancelled` (which dsh maps to a deny with a "cancelled" reason) — that is dsh's policy, not the plugin refusing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No StickS3 CDC port found` | Replug USB; on Linux run `sudo usermod -aG dialout $USER` and re-login; check `pio device list` |
| Device never wakes / no heartbeat | Confirm the DSH firmware (not the stock CodeBuddy BLE build) is flashed |
| Want to see what the plugin is doing | Start dsh with `HB_DEBUG=1` — prints serial discovery, heartbeats, approvals on stderr |
| Approval screen disappears in 3s | Update the plugin (old builds cleared the prompt on the next heartbeat) |

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
