# 🏗️ 技术方案

> **文档用途**：给 coding agent 的完整执行指南。包含架构、代码落点、具体实现、测试策略、风险对策。
>
> **前置条件**：已 fork `CharlexH/CodeBuddy`；已安装 PlatformIO 6.x、Node.js ≥ 22（dsh 要求 `^22.19.0 || >=24.0.0`）、pnpm ≥ 9、dsh CLI（`@deepseek-ai/dsh`）、StickS3 ≥ 1 台。
>
> **版本锚点**：`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-tools@0.1.0-rc.7`、`@deepseek-ai/dsh-user-approval@0.1.0-rc.7`、`@deepseek-ai/schemastery@3.18.1`、`@deepseek-ai/cosmokit@1.8.2`（后三者及 cordis 在 dsh 仓库中均为 vendored workspace 包）
>
> **文档版本**：v1.3（v1.2 吸收外部审查意见：token 生命周期语义、连接状态事件、正则配置校验、版本自检、平台范围与 Backlog；修订记录见 §9）

---

## 1. 架构总览

```text
┌─────────────────────────────────────────────────────────────────┐
│  deepseek-harness (Cordis 插件树, host = Node.js)                  │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  dsh-hardware-buddy 插件（自包含 npm 包，仅 host 侧）       │   │
│   │  • inject: ctx.inject(['tools', 'approval'])            │   │
│   │    （服务名为 tools/approval/agents/sessions，注意复数）    │   │
│   │  • tools/pre-execute：名单匹配 → 缓存 exec.arguments      │   │
│   │    by callId → 返回 {kind:'ask'}；否则 next()            │   │
│   │  • approval/request (prepend)：排除名单或设备离线 → next()│   │
│   │    设备在线 → 推 prompt、race(按钮/超时/req.signal)       │   │
│   │  • session/event → 攒状态；agent/status → running        │   │
│   │  • 定时(默认 3s)全量快照 → 900B 裁剪 → 心跳 JSON          │   │
│   │  • 通过 node-serialport 写入 /dev/cu.usbmodem*           │   │
│   │  • 读取设备回发的 permission 指令 → 回灌 approval/request│   │
│   │  • ctx.effect() 管理串口生命周期                          │   │
│   └───────────────────────┬─────────────────────────────────┘   │
└───────────────────────────┼─────────────────────────────────────┘
                            │ USB CDC (\n 分隔 JSON, ≤900B/行)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  M5Stack StickS3 固件（基于 CodeBuddy fork）                        │
│  • ARDUINO_USB_CDC_ON_BOOT=1, ARDUINO_USB_MODE=1（platformio.ini │
│    :18-19，已存在，无需追加）                                        │
│  • Serial = HWCDC → USB-Serial/JTAG 外设 → GPIO19/20 → USB-C      │
│  • dataPoll(): 保留 _usbLine.feed，删 BLE drain 分支, 5ms 预算    │
│  • connected = 30s 心跳窗口（dataConnected(), data.h:75-77）       │
│  • PersonaState: sleep/idle/busy/attention/celebrate/dizzy/heart    │
│  • A键→permission{decision:once}, B键→permission{decision:deny}    │
│  • 18 ASCII 宠物（firmware/src/buddies/）+ 1 GIF 角色（bufo/）      │
│  • #if CODE_BUDDY_BLE_ENABLED 包 BLE 调用（默认 0），               │
│    并解耦 OTA 对 BLE 的硬依赖（见 §2.3-2.5）                        │
└─────────────────────────────────────────────────────────────────┘
```

### 1.1 加载机制（dsh 真实 patch-stack）

dsh 不通过单文件 patch 加载插件；`cordis.yml` 是每次启动被重写的**空根**（`apps/cli/src/profile-boot.ts:60-64, 98-103`），真实叠加顺序（`allPatches` L122-129 + `composeProfile` L142-171）：

```text
bundle 层（dsh.profile.bundles 指定的 bundle patch，最底层主体）
        ↓
$DSH_HOME/profiles/<name>/cordis.patch.yml   ← profile 自定义（HMR 监听对象）
        ↓
$DSH_HOME/cordis.patch.yml                   ← home 全局 patch（HMR 监听对象）
        ↓
--patch file.yaml [file2.yaml ...]           ← CLI 覆盖
```

- 每层是 `PatchOptions` 数组（`- insert: [...]` / `- id: xxx` 定向覆写，config 整块替换不合并），经 vendored `@deepseek-ai/cordis-plugin-include` 的 `applyEntryPatches()` 合并（`vendor/include/src/index.ts:145-156`，调用点 `packages/boot/app-boot/src/profile.ts:413-420`）
- 插件 entry 字段：`id / name / config? / group? / disabled? / inject?`（`vendor/loader/src/config/entry.ts:9-22`）。**不存在 `plugins:` 键**，cordis.yml/patch 文件都是顶层数组
- 配置热更新（HMR）由 vendored `@deepseek-ai/cordis-plugin-hmr` 提供，dsh 默认开启，监听对象是 `cordis.patch.yml`
- 第三方插件发布路径：包内声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` manifest（`packages/boot/app-boot/src/profile.ts:42-45, 391-393`），用户侧 `dsh plugin add <pkg>` 安装（`docs/user/develop/basic/publish.md`）
- `ctx.loader.create({ name })` 是运行时加载调用（profile-boot 用它挂 timer/HMR 插件），不是 patch 栈的一层

### 1.2 真实事件矩阵（按本插件使用频度排序）

|事件|模式|用途|文件:行|
|---|---|---|---|
|`tools/pre-execute`|waterfall|名单工具返回 `ask` + 缓存参数|`core/tools/src/index.ts:152`（调用点 `:1475`）|
|`approval/request`|waterfall|设备 A/B 决策回灌；离线/排除名单 `next()`|`user-approval/src/index.ts:30`|
|`agent/status`|emit|running 字段（payload `{ agent, status: 'idle'\|'running' }`）|`core/agent/src/runtime-types.ts:178`|
|`session/created` / `session/disposed`|emit|total 字段|`core/session/src/index.ts:54, 64`|
|`session/event`|emit|entries / tokens / activity20 / token20v1|`session/src/index.ts:76`|
|`session/flush`|parallel|可选：flush 后再发心跳|`session/src/index.ts:85`|
|`agent/error`|emit|切回 idle、显示 msg|`runtime-types.ts:290`|

> **注意**：
> - Cordis 服务名为 `tools` / `approval` / `agents` / `sessions`（**后两个是复数**，声明于 `core/agent/src/index.ts:267`、`core/session/src/index.ts:797`）。本插件只需 `ctx.inject(['tools', 'approval'])`；事件监听 `ctx.on(...)` 不需要注入服务，但 inject 一个不存在的服务名会让插件**永久挂起**
> - waterfall 语义（`vendor/cordis/src/events.ts:224-243`）：监听器签名 `(...args, next)`，**不调用 `next()` 即 veto 整条链（含内建默认）**；返回值拦截（isBailed）只适用于 serial/bail 模式，waterfall 下返回 undefined 但不调 next 同样短路
> - `prepend: true` 只保证插到**当时已注册**监听器之前（`vendor/cordis/src/events.ts:254-260`），不是永久第一；策略上遵循"归我管才接管，否则 next()"
> - step start/end 等是 `SessionEventMap` 键（`session/src/types.ts:236-333`），仅通过 `session/event` 过滤 `event.type` 观测

---

## 2. 固件侧改造

### 2.1 platformio.ini

**不需要追加 USB 相关 build_flags**——`-DARDUINO_USB_CDC_ON_BOOT=1` 和 `-DARDUINO_USB_MODE=1` 已存在（真实位置 `firmware/platformio.ini:18-19`）。**也没有 NimBLE 依赖可删**——BLE 用的是 Arduino core 自带 Bluedroid 栈（`ble_bridge.cpp` include `<BLEDevice.h>` 等），`lib_deps` 实际为：

```ini
lib_deps =
  m5stack/M5Unified @ 0.2.18
  m5stack/M5PM1 @ 1.0.7
  bitbank2/AnimatedGIF @ 2.2.3
  bblanchon/ArduinoJson @ 7.4.3
```

需要做的唯一新增 flag：

```ini
[env:m5stack-sticks3]
build_flags =
  ; ... 既有内容保持不变 ...
  -DCODE_BUDDY_BLE_ENABLED=0       ← 新增（默认禁用 BLE）
```

`CODE_BUDDY_BLE_ENABLED=0` 让全部 BLE 符号引用在编译期被屏蔽（见 §2.3）。

### 2.2 dataPoll() 净化（最小改动，不要重写）

当前实现（`firmware/src/data.h:386-431`）：`dataPoll()` 依次做 demo 分支（389-397）、`_usbLine.feed(Serial, out, true)`（399，USB 行读取，保留）、BLE ring drain（401-414，**删除**）、`out->connected = dataConnected()`（416，保留）、otaOfferLifecyclePoll（417-424，保留）、断连清零 + `"No Codex connected"` 文案（425-430，**保留结构、改文案**）。

改造方式：

1. 删除 401-414 行 BLE drain 分支
2. `dataConnected()`（`data.h:75-77`，30s 心跳窗口）**原样保留**——host 侧按 `heartbeatIntervalMs`（默认 3s）保活即可满足；拔线后最多 30s 转睡眠（若想秒睡，可叠加 `_onUsb`（VBUS，`main.cpp:856`）作为提前睡眠条件，但代价是"host 崩了但 USB 插着"时永不睡——两种语义在 README 里写清楚即可，默认不叠加）
3. 425-430 行断连文案 `"No Codex connected"` 改为 `"No DSH host"` 之类

> ⚠️ 不要按 v1.1 版本 tech 文档里的重写代码替换整个 `dataPoll()`——那段代码丢掉了断连清零分支、改变了 connected 语义（`(bool)Serial`），比现状更简陋。

### 2.3 BLE 通道编译期禁用（比 v1.1 估计的范围大）

`#if CODE_BUDDY_BLE_ENABLED` 需要包住的**全部** BLE 符号引用点（逐处核实过）：

|文件:行|引用|处理|
|---|---|---|
|`main.cpp` setup()|`bleInit()` / `bleClearBonds()`|包 `#if`|
|`main.cpp:2219-2220`|`bleReady()` / `bleStartupFailed()`|包 `#if`（无 BLE 构建下视为"未失败"）|
|`main.cpp:207-212` sendCmd|`bleWrite(cmd)` / `bleWrite("\n")`|删掉，只留 `Serial.println(cmd)`|
|`data.h:168, 218, 351`|`bleConnected()`|包 `#if`，无 BLE 分支返回 false|
|`data.h:401-414`|BLE ring drain|删除|
|`ota_status.cpp:6, 35`|include ble_bridge.h + `bleWrite`|包 `#if`|
|`ota_update.cpp:765, 820`|`bleConnected()`|包 `#if`，无 BLE 分支返回 false|

`firmware/src/ble_bridge.{cpp,h}` **不删除**，保留为可选源；但注意：`ble_bridge.cpp` 不能再无条件参与编译（`platformio.ini` 的 `src_filter` 排除之，或在其内部整体包 `#if`），否则 Bluedroid 链接符号仍会进二进制。

### 2.4 OTA/BLE 解耦（P1 的隐藏大头，不做必翻车）

OTA 固件字节走 WiFi HTTPS（`ota_update.cpp:5-6` esp_tls），但**开机健康确认**硬依赖 BLE：

- `ota_boot_health_logic.h:20` 定义 `OTA_BOOT_READY_BLE = 1U << 3`，且它是 `OTA_BOOT_READY_ALL`（`:24-27`）的**必需位**
- 后果：`CODE_BUDDY_BLE_ENABLED=0` 时若不处理该位，新镜像**永远不会被确认，30 秒后自动回滚**（监督任务 `ota_boot_health.cpp:189-210`）

处理方案（P1 实现）：

```cpp
// ota_boot_health_logic.h
#if CODE_BUDDY_BLE_ENABLED
  #define OTA_BOOT_READY_BLE_REQ (OTA_BOOT_READY_BLE)
#else
  // 无 BLE 构建：以"USB 数据通道曾收到有效心跳"作为等效就绪位
  #define OTA_BOOT_READY_BLE_REQ (otaBootReadyUsbDataSeen())
#endif
// OTA_BOOT_READY_ALL 中对应位替换为 OTA_BOOT_READY_BLE_REQ
```

（具体等价条件可简化为"本次开机收到过任一有效 JSON 行"，即 `_lastLiveMs != 0`。）

同时 `xfer.h` 的命令冲突表（`xferCommandConflictsWithOta`，79-84 行）保留不动——`unpair` 命令处理在 108-112 行，无 BLE 构建下 `bleClearBonds()` 包 `#if` 即可。

### 2.5 发送方向

`main.cpp:207-212` 现有 `sendCmd()`：`Serial.println(json)` + `bleWrite`。净化后：

```cpp
void sendCmd(const char* json) {
  Serial.println(json);  // USB CDC 唯一通道
}
```

### 2.6 烧录与验证

```bash
cd firmware
pio run -e m5stack-sticks3
# 首次烧录：按住 StickS3 复位键 2 秒至绿灯闪，进入下载模式
pio run -e m5stack-sticks3 -t upload --upload-port /dev/cu.usbmodem*
# 后续烧录：设备自动进下载模式（USB-Serial/JTAG 复位序列）

# 枚举与 VID/PID 实测（结果回填 P0 报告与插件 discoverPort 默认值）：
pio device list
ls /dev/cu.usbmodem*

# 手动 CDC 测试（两个终端）：
#   终端 1: pio device monitor -p /dev/cu.usbmodemXXXX
#   终端 2: 循环发心跳，观察设备屏切 busy / 30s 停发转 sleep
python3 -c "
import json,serial,time
s=serial.Serial('/dev/cu.usbmodemXXXX',115200)
while True:
    s.write((json.dumps({'total':1,'running':1,'msg':'hello'})+'\n').encode()); time.sleep(3)
"
```

### 2.7 固件侧交付物清单

|文件|改动|
|---|---|
|`firmware/platformio.ini`|加 `-DCODE_BUDDY_BLE_ENABLED=0`；`src_filter` 排除 `ble_bridge.cpp`（或其内部包 `#if`）|
|`firmware/src/data.h`|删 BLE drain（401-414）；`bleConnected()` 调用点（168/218/351）包 `#if`；断连文案改 DSH|
|`firmware/src/main.cpp`|setup() BLE 段、`2219-2220`、sendCmd 的 `bleWrite` 包 `#if`/删除|
|`firmware/src/ota_status.cpp` / `ota_update.cpp`|BLE 引用包 `#if`|
|`firmware/src/ota_boot_health_logic.h`|`OTA_BOOT_READY_BLE` 位无 BLE 替换（§2.4）|
|`firmware/src/xfer.h`|`bleClearBonds()` 包 `#if`（108-112）|
|`firmware/src/ble_bridge.{cpp,h}`|**不删**，保留为可选源|
|`firmware/scripts/inject-ota-trust.py` / `verify-ota-rollback-symbol.py`|**不改**|

---

## 3. dsh 插件（自包含 npm 包）

### 3.1 仓库与包结构

仓库 root 新建 `dsh-hardware-buddy/`，与 `firmware/` 平级。**自包含**：CodeBuddy 仓库是纯 Python 仓库（无 package.json / tsconfig.base.json / pnpm-workspace.yaml），本包**不 extends 外部 tsconfig、不依赖 workspace**，CI 直接进目录安装测试。

```text
dsh-hardware-buddy/
├── package.json
├── tsconfig.json            # 自包含，不 extends
├── cordis.patch.yml         # dsh.bundle manifest 引用的 patch
├── README.md
├── src/
│   ├── index.ts           # apply(ctx, config) 主入口
│   ├── cdc.ts             # CdcBridge 串口封装（VID/PID 发现）
│   ├── protocol.ts        # Heartbeat / DeviceCommand 类型 + 序列化 + 900B 裁剪
│   ├── bridge.ts          # dsh 事件 → 状态机 → 定时全量快照
│   ├── approval.ts        # pre-execute 参数缓存 + approval 接管/回退
│   └── config.ts          # schemastery 配置 schema
└── tests/
    ├── protocol.spec.ts   # 序列化 + 裁剪单测
    ├── bridge.spec.ts     # 状态机单测
    ├── approval.spec.ts   # ask / next() 回退 / 超时 / signal race 单测
    └── e2e/
        ├── fake-port.ts
        └── flow.spec.ts
```

### 3.2 package.json

```json
{
  "name": "@<scope>/dsh-hardware-buddy",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist", "cordis.patch.yml"],
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "oxlint src/"
  },
  "dependencies": {
    "@deepseek-ai/cosmokit": "1.8.2",
    "@deepseek-ai/schemastery": "3.18.1",
    "serialport": "^12.0.0",
    "@serialport/parser-readline": "^12.0.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/dsh-tools": "0.1.0-rc.7",
    "@deepseek-ai/dsh-user-approval": "0.1.0-rc.7",
    "@deepseek-ai/dsh-agent": "0.1.0-rc.7",
    "@deepseek-ai/dsh-session": "0.1.0-rc.7"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

> 说明：`dsh.bundle.patch` 是 dsh 真实 manifest 约定（`packages/boot/app-boot/src/profile.ts:42-45`，文档 `docs/user/develop/basic/publish.md`）；`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` 均为真实包名（rc.7）。插件只跑 host(Node) 侧，**不声明 `dsh.client`**（浏览器侧插件要求 browser-pure，禁原生模块）。

### 3.3 tsconfig.json（自包含）

```json
{
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

### 3.4 src/config.ts

```typescript
import Schema from '@deepseek-ai/schemastery';

export interface Config {
  port: string | null;
  vendorId: string;
  productId: string | null;
  baudRate: number;
  approvalTimeout: number;
  heartbeatIntervalMs: number;
  dangerousTools: string[];
  excludedTools: string[];
  celebrateThreshold: number;
  entriesLimit: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}

export const Config: Schema<Config> = Schema.object({
  port: Schema.string().default(null).description('null = auto-discover'),
  vendorId: Schema.string().default('0x303A').description('Espressif VID (P0 实测校准)'),
  productId: Schema.string().default(null).description('optional PID filter'),
  baudRate: Schema.number().default(115200).description('no-op for USB CDC'),
  approvalTimeout: Schema.number().default(30000).description('ms before auto-cancel'),
  heartbeatIntervalMs: Schema.number().default(3000)
    .description('全量快照间隔，必须远小于设备 30s 心跳窗口'),
  dangerousTools: Schema.array(Schema.string()).default([])
    .description('走硬件审批的正则（默认值由 P0 dump 的真实工具名定稿）'),
  excludedTools: Schema.array(Schema.string()).default(['^MCP__danger_.*'])
    .description('走 dsh Web UI 审批的正则'),
  celebrateThreshold: Schema.number().default(50000),
  entriesLimit: Schema.number().default(5),
  logLevel: Schema.string().default('info'),
});
```

### 3.5 src/protocol.ts

```typescript
// 沿用 CodeBuddy wire 协议字面量；字段定义见 firmware/src/data.h:109-366 (_applyJson)

export const HEARTBEAT_MAX_BYTES = 900;

export interface HeartbeatUsage {
  five_hour_remaining: number;   // 0-1
  seven_day_remaining: number;   // 0-1
}

export interface HeartbeatPrompt {
  id: string;
  tool: string;
  hint: string;                   // ≤ 120 chars
}

export interface Heartbeat {
  total?: number;
  running?: number;
  waiting?: number;
  msg?: string;
  entries?: string[];
  tokens?: number;
  tokens_today?: number;
  activity20?: number;            // uint32, low-20-bits（固件校验 data.h:290-298）
  token20v1?: string;             // base64url 86 chars（token_heartbeat_logic.h:7-10）
  usage?: HeartbeatUsage;
  completion_seq?: number;
  unread?: number;
  prompt?: HeartbeatPrompt;
}

export type DeviceDecision = 'once' | 'deny';

export interface DeviceCommand {
  cmd: 'permission' | 'unpair';
  id?: string;
  decision?: DeviceDecision;
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export function decisionToOutcome(d: DeviceDecision): ApprovalOutcome {
  return d === 'once' ? 'allowed-once' : 'rejected';
}

export function serializeHeartbeat(hb: Heartbeat): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(hb)) {
    if (v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}

/**
 * 900 字节裁剪——移植自 CodeBuddy reducer.py:77-103 的策略。
 * ⚠️ reducer.py 属于被替换的 Python host，不在新链路中；
 * 本函数是全链路唯一的截断点（NFR5）。
 * 顺序：entries 逐条删 → prompt.hint 96/72/48/32 → 删 prompt → msg 36/28/20/12
 */
export function trimHeartbeat(input: Heartbeat): Heartbeat {
  const h: Heartbeat = { ...input };
  const size = () => serializeHeartbeat(h).length;
  while (size() > HEARTBEAT_MAX_BYTES && h.entries?.length) {
    h.entries = h.entries.slice(0, -1);
  }
  for (const n of [96, 72, 48, 32]) {
    if (size() <= HEARTBEAT_MAX_BYTES || !h.prompt) break;
    h.prompt = { ...h.prompt, hint: h.prompt.hint.slice(0, n) };
  }
  if (size() > HEARTBEAT_MAX_BYTES && h.prompt) delete h.prompt;
  for (const n of [36, 28, 20, 12]) {
    if (size() <= HEARTBEAT_MAX_BYTES || !h.msg) break;
    h.msg = h.msg.slice(0, n);
  }
  return h;
}

export function summarizeArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args.slice(0, 120);
  if (typeof args === 'object' && args !== null && 'command' in args) {
    return String((args as { command: unknown }).command).slice(0, 120);
  }
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}
```

### 3.6 src/cdc.ts

```typescript
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import type { Config } from './config.js';
import type { DeviceCommand } from './protocol.js';

export class CdcBridge {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldRun = false;

  constructor(
    private config: Config,
    private onCommand: (cmd: DeviceCommand) => void,
    private onConnectionChange: (connected: boolean) => void,
    private logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  ) {}

  async start(): Promise<void> { this.shouldRun = true; await this.tryConnect(); }

  async stop(): Promise<void> {
    this.shouldRun = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.port?.isOpen) await new Promise<void>((r) => this.port!.close(() => r()));
    this.port = null; this.parser = null;
  }

  private async tryConnect(): Promise<void> {
    if (!this.shouldRun) return;
    const path = this.config.port ?? (await this.discoverPort());
    if (!path) {
      this.logger.warn('No StickS3 CDC port found, retry in 5s');
      this.scheduleReconnect();
      return;
    }
    try {
      this.port = new SerialPort({ path, baudRate: this.config.baudRate, autoOpen: false });
      this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n', encoding: 'utf8' }));
      this.port.on('open', () => {
        this.connected = true;
        this.onConnectionChange(true);
        this.logger.info(`CDC connected on ${path}`);
      });
      this.port.on('close', () => {
        if (this.connected) this.onConnectionChange(false);
        this.connected = false;
        this.logger.warn(`CDC disconnected from ${path}`);
        if (this.shouldRun) this.scheduleReconnect();
      });
      this.port.on('error', (err) => this.logger.error(`CDC error: ${err.message}`));
      this.parser.on('data', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try { this.onCommand(JSON.parse(trimmed) as DeviceCommand); }
        catch { this.logger.warn(`Failed to parse device line: ${trimmed.slice(0, 80)}`); }
      });
      await new Promise<void>((resolve, reject) =>
        this.port!.open((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      this.logger.error(`Failed to open ${path}: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldRun) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null; this.tryConnect();
    }, 5000);
  }

  /** 按 VID（可选 PID）识别设备；VID 缺失时退回 usbmodem/ttyACM 名称启发 */
  private async discoverPort(): Promise<string | undefined> {
    const { list } = await import('serialport');
    const ports = await list();
    const want = this.config.vendorId.toLowerCase();
    const pid = this.config.productId?.toLowerCase();
    const byVid = ports.find((p) => {
      if (!p.vendorId || p.vendorId.toLowerCase() !== want) return false;
      return !pid || (p.productId?.toLowerCase() === pid);
    });
    if (byVid) return byVid.path;
    return ports.find((p) => /usbmodem|ttyacm/i.test(p.path))?.path;
  }

  send(hb: object): boolean {
    if (!this.connected || !this.port?.isOpen) return false;
    return this.port.write(JSON.stringify(hb) + '\n') !== false;
  }

  get isConnected(): boolean { return this.connected; }
}
```

### 3.7 src/approval.ts

核心原则（对照 Cordis waterfall 语义 `vendor/cordis/src/events.ts:224-243`，"not calling `next()` vetoes"）：

- **设备离线 / 排除名单 / agent 缺失 → 一律 `next()` 放行**，由 Web UI（apiproxy 也是 `approval/request` 的 waterfall 消费者）或默认策略接管
- 插件只在"设备在线且工具归硬件管"时接管；自己产生的结果只有三种：`'allowed-once'` / `'rejected'`（设备按钮）、`'cancelled'`（自持超时或 `req.signal` abort）
- **参数摘要必须在 pre-execute 阶段缓存**：`ApprovalRequest`（`user-approval/src/index.ts:153-174`）只有 `agent / toolName / callId? / reason? / signal?`，**不带 args、不带 id**

```typescript
import type { Config } from './config.js';
import type { ApprovalOutcome, DeviceDecision } from './protocol.js';
import { decisionToOutcome, summarizeArgs } from './protocol.js';

// tools/pre-execute 的 exec（ToolExecution, tools/src/index.ts:314-338）：
//   exec.name（工具名，就在 name 字段）、exec.arguments（已解析 unknown）、
//   exec.callId、exec.agent?、exec.signal
interface PreExec {
  name?: string;
  arguments?: unknown;
  callId?: string;
  agent?: unknown;
}

// approval/request 的 req（ApprovalRequest, user-approval/src/index.ts:153-174）：
//   agent（必填）、toolName、callId?、reason?、signal?
interface ApprovalReq {
  agent: unknown;
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

interface PendingApproval {
  tool: string;
  settle: (outcome: ApprovalOutcome) => void;
}

export class ApprovalBridge {
  private pending = new Map<string, PendingApproval>();
  /** callId → 参数快照；ApprovalRequest 不带 args，必须在 pre-execute 缓存 */
  private argCache = new Map<string, { tool: string; hint: string }>();
  private excluded: RegExp[];
  private dangerous: RegExp[];

  constructor(
    private config: Config,
    private cdcOnline: () => boolean,
    private sendPrompt: (id: string, tool: string, hint: string) => boolean,
    private sendWaiting: (count: number) => void,
    private logger: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    // FR7：正则编译失败 warn + 跳过该条，不让插件整体崩溃；
    // "配置静默失效"必须通过 dry-run 统计在日志可见
    this.excluded = this.compilePatterns(config.excludedTools, 'excludedTools');
    this.dangerous = this.compilePatterns(config.dangerousTools, 'dangerousTools');
  }

  private compilePatterns(patterns: string[], label: string): RegExp[] {
    const out: RegExp[] = [];
    for (const p of patterns) {
      try { out.push(new RegExp(p)); }
      catch (e) { this.logger.warn(`invalid regex in ${label}, skipped: ${p} (${(e as Error).message})`); }
    }
    return out;
  }

  /** 启动时 dry-run：用已知工具名统计匹配情况，让配置生效性可见（清单来自 P0 或 tools 服务枚举） */
  dryRunMatch(knownToolNames: string[]): void {
    const groups = [['dangerousTools', this.dangerous], ['excludedTools', this.excluded]] as const;
    for (const [label, list] of groups) {
      const hit = knownToolNames.filter((n) => list.some((re) => re.test(n)));
      this.logger.info(`${label} matched ${hit.length}/${knownToolNames.length}${hit.length ? ': ' + hit.join(',') : ' (none!)'}`);
    }
  }

  /** tools/pre-execute waterfall：名单工具 → ask（同时缓存参数）；否则 next() */
  preExecuteHook = (exec: PreExec, next: () => unknown) => {
    const toolName = exec?.name || 'unknown';
    const matched =
      this.dangerous.some((re) => re.test(toolName)) ||
      this.excluded.some((re) => re.test(toolName));
    if (!matched) return next();
    // exec.agent 缺失时 ask 会被 runtime 降级为 deny（tools/src/index.ts:1702）
    if (!exec.agent || !exec.callId) return next();
    this.argCache.set(exec.callId, {
      tool: toolName,
      hint: summarizeArgs(exec.arguments),
    });
    // ask.reason 可选；deny.reason 必填（PreToolDecision, tools/src/index.ts:588-591）
    return { kind: 'ask' as const, reason: 'hardware buddy approval' };
  };

  /**
   * approval/request waterfall（prepend: true 注册）。
   * 接管条件：非排除名单 且 设备在线；其余情况必须 next() 放行。
   */
  approvalRequestHook = (req: ApprovalReq, next: () => Promise<ApprovalOutcome>) => {
    if (this.excluded.some((re) => re.test(req.toolName))) {
      this.logger.info(`Excluded tool goes to Web UI: ${req.toolName}`);
      return next();
    }
    if (!this.cdcOnline()) {
      this.logger.info(`CDC offline, falling through to Web UI: ${req.toolName}`);
      return next();
    }

    const id = req.callId ?? `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cached = req.callId ? this.argCache.get(req.callId) : undefined;
    const tool = cached?.tool ?? req.toolName;
    const hint = cached?.hint ?? req.reason ?? '';
    if (req.callId) this.argCache.delete(req.callId);

    return new Promise<ApprovalOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: ApprovalOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.sendWaiting(this.pending.size);
        resolve(outcome);
      };

      // 自持超时
      const timer = setTimeout(() => {
        this.logger.info(`Approval timeout: ${id} ${tool}`);
        settle('cancelled');
      }, this.config.approvalTimeout);

      // runtime 侧取消（req.signal 由 runtime 传入，来源 exec.signal）
      req.signal?.addEventListener('abort', () => settle('cancelled'), { once: true });

      this.pending.set(id, { tool, settle });
      this.sendWaiting(this.pending.size);
      this.sendPrompt(id, tool, hint);
    });
  };

  /** 设备发回 permission 决策 */
  onDeviceCommand(decision: DeviceDecision, id?: string): void {
    if (!id) { this.logger.warn('permission command missing id'); return; }
    const pending = this.pending.get(id);
    if (!pending) { this.logger.warn(`No pending approval for id=${id}`); return; }
    pending.settle(decisionToOutcome(decision));
  }

  /** 设备发回 unpair → 全量 cancel（xfer.h:108-112） */
  onDeviceUnpair(): void {
    for (const p of this.pending.values()) p.settle('cancelled');
  }
}
```

### 3.8 src/bridge.ts（状态机 + 定时全量快照）

```typescript
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import type { Heartbeat } from './protocol.js';
import { trimHeartbeat } from './protocol.js';

interface BridgeState {
  total: number;          // 只按 session 口径计数，避免 agent+session 双计数
  running: number;
  entries: string[];
  tokens: number;         // 进程生命周期累计：重启/HMR 清零（语义见 PRD FR2；持久化在 Backlog）
  tokensToday: number;    // "进程存活期累计"，非自然日（PRD FR2 显式定义）
  celebrateFired: boolean; // 随进程复位，重启后会再次触发 celebrate（有意取舍）
  msg?: string;
}

/**
 * dsh 事件 → 状态机；发送由定时器全量快照驱动（不做逐事件发送，
 * assistant/chunk 是流式高频事件），间隔 heartbeatIntervalMs（默认 3s，
 * 远小于设备 30s 心跳窗口），满足保活 + 状态镜像。
 */
export class EventBridge {
  private state: BridgeState;
  private disposers: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: Context,
    private config: Config,
    private send: (hb: Heartbeat) => void,
  ) {
    this.state = { total: 0, running: 0, entries: [], tokens: 0, tokensToday: 0, celebrateFired: false };
  }

  attach(): () => void {
    this.disposers.push(this.ctx.on('session/created', () => this.bumpTotal(+1)));
    this.disposers.push(this.ctx.on('session/disposed', () => this.bumpTotal(-1)));

    // payload 是 { agent, status: 'idle' | 'running' }，双向流转都要处理
    this.disposers.push(this.ctx.on('agent/status', (payload: { status?: string }) => {
      this.state.running = payload?.status === 'running' ? 1 : 0;
    }));

    this.disposers.push(this.ctx.on('session/event', (session: unknown, ev: { type?: string } & Record<string, unknown>) => {
      // entries：从 event.message 提取摘要（事件上没有 summary 字段）
      if (ev.type === 'tool/result' || ev.type === 'assistant/message') {
        const summary = this.summarizeEvent(ev).slice(0, 80);
        if (summary) {
          this.state.entries.unshift(summary);
          if (this.state.entries.length > this.config.entriesLimit) {
            this.state.entries.length = this.config.entriesLimit;
          }
        }
      }
      // tokens：assistant/message 自带 usage?: TokenUsage（camelCase inputTokens/outputTokens）
      if (ev.type === 'assistant/message' && ev.usage) {
        const u = ev.usage as { inputTokens?: number; outputTokens?: number };
        const delta = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
        this.state.tokens += delta;
        this.state.tokensToday += delta;
        if (!this.state.celebrateFired && this.state.tokens >= this.config.celebrateThreshold) {
          this.state.celebrateFired = true;
          this.state.msg = 'milestone!';
        }
      }
    }));

    // 定时全量快照（保活 + 镜像）
    this.timer = setInterval(() => this.flush(), this.config.heartbeatIntervalMs);
    this.disposers.push(() => { if (this.timer) clearInterval(this.timer); });

    return () => this.disposers.forEach((d) => d());
  }

  flush(): void {
    const hb: Heartbeat = {
      total: this.state.total,
      running: this.state.running,
      entries: [...this.state.entries],
      tokens: this.state.tokens,
      tokens_today: this.state.tokensToday,
      msg: this.state.msg,
    };
    this.send(trimHeartbeat(hb));
  }

  // msg 字段挂 state 上（上面引用），完整定义补 msg?: string 到 BridgeState
  private summarizeEvent(ev: Record<string, unknown>): string {
    const message = ev.message as Record<string, unknown> | undefined;
    if (!message) return String(ev.type ?? '');
    const s = JSON.stringify(message);
    return s.length > 80 ? s.slice(0, 77) + '...' : s;
  }

  private bumpTotal(delta: number): void {
    this.state.total = Math.max(0, this.state.total + delta);
  }
}
```

> `activity20` / `token20v1` / `usage` 为可选增强：前者在 `flush()` 里按 20s 窗口聚合生成；`usage` 数据源未定（stretch），接入前心跳中不带该字段。

### 3.9 src/index.ts

```typescript
import type { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { CdcBridge } from './cdc.js';
import { ApprovalBridge } from './approval.js';
import { EventBridge } from './bridge.js';
import { Config } from './config.js';
import type { DeviceCommand } from './protocol.js';

const require = createRequire(import.meta.url);

export const name = 'hardware-buddy';

export const inject = ['tools', 'approval'];  // 服务名：tools/approval/agents/sessions（复数注意）

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('hardware-buddy');

  // FR8：版本自检——peerDeps 锚定 rc.7，运行环境版本漂移只 warn 不 throw
  try {
    const { version } = JSON.parse(
      readFileSync(require.resolve('@deepseek-ai/dsh-tools/package.json'), 'utf8'));
    if (version !== '0.1.0-rc.7') {
      logger.warn(`dsh-tools ${version} != tested 0.1.0-rc.7, event payloads may differ`);
    }
  } catch { /* resolve 不到就跳过自检 */ }

  const flushNow = () => bridge.flush();  // 重连后立即全量快照

  const approval = new ApprovalBridge(
    config,
    () => cdcRef.isConnected,
    (id, tool, hint) => cdcRef.send({ waiting: 1, prompt: { id, tool, hint } }),
    (count) => cdcRef.send({ waiting: count }),
    logger,
  );

  const cdc = cdcRef.target = new CdcBridge(
    config,
    (cmd: DeviceCommand) => {
      if (cmd.cmd === 'permission') approval.onDeviceCommand(cmd.decision!, cmd.id);
      else if (cmd.cmd === 'unpair') approval.onDeviceUnpair();
    },
    (connected) => {
      logger.info(connected ? 'cdc connected' : 'cdc disconnected');
      ctx.emit('hardware-buddy/connection-changed', { connected });  // FR8：为 Web UI 状态徽标留 hook
      if (connected) flushNow();
    },
    logger,
  );
  // 延迟绑定打破 approval ↔ cdc 构造环
  const cdcRef = { target: null as CdcBridge | null, get isConnected() { return !!this.target?.isConnected; }, get send() { return this.target!.send.bind(this.target); } };

  const bridge = new EventBridge(ctx, config, (hb) => cdc.send(hb));
  bridge.attach();

  // waterfall 注册：pre-execute 常规；approval/request prepend（只保证先于已注册监听器）
  ctx.on('tools/pre-execute', approval.preExecuteHook);
  ctx.on('approval/request', approval.approvalRequestHook, { prepend: true });

  // FR7：配置生效性 dry-run（工具名清单由 P0 定稿内置，或运行时从 tools 服务枚举）
  // approval.dryRunMatch(P0_TOOL_NAMES);

  cdc.start();

  // 卸载清理
  ctx.effect(() => async () => {
    await cdc.stop();
  });
}
```

> 注 1：`cdcRef` getter 里 `this` 指向对象字面量，实现时用一个小 class 或先 null 后赋值的局部变量即可，语义是"approval 构造时不依赖 cdc 已存在"。
> 注 2：`inject` 声明与事件监听的组合以 dsh 实际加载器行为为准（P0 验证）；如 `inject` 导出不生效，用 `ctx.inject(['tools', 'approval'], (inner) => { ... })` 包裹注册逻辑。

### 3.10 cordis.patch.yml（随包分发）

patch 是 `PatchOptions` 顶层数组（无 `plugins:` 键）：

```yaml
- insert:
  - id: hardware-buddy
    name: '@<scope>/dsh-hardware-buddy'
    config:
      port: null
      vendorId: '0x303A'
      approvalTimeout: 30000
      heartbeatIntervalMs: 3000
      dangerousTools: []   # P0 定稿后填入
      excludedTools:
        - '^MCP__danger_.*'
      celebrateThreshold: 50000
      entriesLimit: 5
      logLevel: info
```

用户侧安装与配置修改：

```bash
dsh plugin add @<scope>/dsh-hardware-buddy     # 或 dsh plugin add github:<user>/dsh-hardware-buddy
# 配置调整写在 $DSH_HOME/profiles/<name>/cordis.patch.yml（HMR 监听对象）：
#   - id: hardware-buddy
#     config:
#       approvalTimeout: 5000
```

---

## 4. 协议层

完整字段定义见 CodeBuddy `firmware/src/data.h:109-366` 的 `_applyJson()`。

### 4.1 宿主 → 设备心跳（单行 JSON + `\n`，最大 900 字节，由插件 `protocol.ts` 的 `trimHeartbeat` 强制）

|字段|类型|必填|说明|
|---|---|---|---|
|`total`|int|否|活跃会话数（session 口径）|
|`running`|0\|1|否|是否有 agent 在 running|
|`waiting`|int|否|等待审批的工具调用数|
|`msg`|string|否|状态屏大标题（裁剪后 ≤ 36 字符）|
|`entries`|string[]|否|最近 N 条事件摘要（N = `entriesLimit`）|
|`tokens`|int|否|累计 token|
|`tokens_today`|int|否|今日 token|
|`activity20`|uint32|否|20-bin 滚动强度（低 20 位有效，固件校验 `data.h:290-298`）|
|`token20v1`|base64url string|否|64-bin × 20s 窗口强度（86 字符，`token_heartbeat_logic.h:7-10`）|
|`usage.five_hour_remaining`|0-1|否|5 小时配额剩余比例（stretch，数据源待定）|
|`usage.seven_day_remaining`|0-1|否|7 天配额剩余比例（stretch）|
|`completion_seq`|int|否|累计响应序号|
|`unread`|int|否|未读消息数|
|`prompt`|`{id, tool, hint}`|否|审批屏；出现时 `waiting ≥ 1`；参数来自 pre-execute 缓存|

### 4.2 设备 → 宿主（单行 JSON + `\n`）

```json
{"cmd":"permission","id":"<promptId>","decision":"once"}
{"cmd":"permission","id":"<promptId>","decision":"deny"}
{"cmd":"unpair"}
```

> A 按钮触发 `decision: "once"`（`main.cpp:2461`），B 按钮触发 `decision: "deny"`（`main.cpp:2508`）。`unpair` 处理在 `xfer.h:108-112`。

### 4.3 dsh 侧 ApprovalOutcome 映射（`tools/src/index.ts:1713-1728`，源码核实）

|设备 decision|dsh ApprovalOutcome|dsh runtime 后续动作|
|---|---|---|
|`"once"`|`'allowed-once'`|`{ kind: 'allow' }` 继续执行|
|`"deny"`|`'rejected'`|`{ kind: 'deny', reason: 'the user rejected tool "x"' }`|
|插件超时 / runtime abort|`'cancelled'`|`{ kind: 'deny', reason: 'approval for tool "x" was cancelled' }`，`approvalCancelled: true`|
|（插件不主动产生）|`'unavailable'`|deny "requires approval, but no approval channel is available"| 仅当整条 waterfall 无人接管时由服务层产生 |

---

## 5. 关键风险与对策

|风险|影响|概率|对策|
|---|---|---|---|
|**waterfall veto 误用**（不调 next() 短路整条链）|高|已规避|铁律：设备离线 / 排除名单 / agent 缺失一律 `next()`；范式参照 ACP 桥 `packages/acp/acp/src/index.ts:271-285`|
|**OTA/BLE 耦合**：`OTA_BOOT_READY_BLE` 必需位 + 5 处编译点|高|确定存在|§2.3-2.4 工作项；AC12 验证"刷入不回滚"|
|CodeBuddy 公共仓已归档|中|高|Fork 长期维护；OTA trust 脚本自包含|
|dsh Cordis API 在 rc 阶段不稳定|高|中|`peerDependencies` 硬锁定 rc.7；P0 探测|
|`dangerousTools` 默认正则不匹配 dsh 真实工具名|高|中|P0 dump 工具名清单后定稿默认值；不预填 Claude/Codex 工具名|
|多 CDC 设备误连（其他开发板）|中|中|`discoverPort` 按 VID 0x303A（+可选 PID）过滤，P0 实测校准|
|900 字节超限心跳被固件静默截断成坏 JSON|低|低|截断只在 `protocol.ts` 一处，裁剪顺序保证 ≤900；单测覆盖|
|审批超时与用户实际思考时长不匹配|中|中|`approvalTimeout` 可配；超时语义是 cancelled 非 rejected|
|多个 agent 同时触发审批，prompt 冲突|中|中|`prompt.id` 优先用 `callId`；设备端 `inPrompt` 单实例保护|
|用户卸载插件时未清理串口|低|低|`ctx.effect()` → `CdcBridge.stop()`|
|StickS3 USB CDC 冷启动未枚举|低|中|`discoverPort()` 5s 轮询兜底；首次插入系统授权提示|
|`session/event` payload 与假设不符|低|中|P0 runtime probe 留档真实样例；bridge 摘要做了防御式提取|
|用户正则配置语法错误 / 静默不匹配|中|中|编译失败 warn+跳过；启动 dry-run 匹配统计（§3.7）|
|dsh 版本漂移（rc.8+ 破坏性变更）|中|中|peerDeps 锁 rc.7 + 启动版本自检 warn（§3.9，FR8）|
|Linux 串口权限（dialout 组）|低|中（Linux）|README 排障：`sudo usermod -aG dialout $USER` 或 udev rule|
|多 dsh 实例抢占同一串口|低|低（单实例假设）|MVP 不处理；EBUSY 时日志提示可能存在另一实例；Backlog：文件锁|
|协议无身份校验（USB CDC 免配对）|低|**有意为之**|信任边界 = 拥有本机串口设备节点访问权限；勿将串口转发到远程/多用户主机|
|serialport 原生模块 prebuild 缺失|低|MVP 接受（本地环境可用即可）|正式分发前补 README 编译依赖说明（PRD Backlog）|

---

## 6. P0：探测插件（必须先做）

静态部分直接以 dsh `docs/event-producer-consumer.md`（自动生成的权威事件矩阵）为基线核对，runtime probe 只验证 payload 与运行时行为：

```typescript
// dsh-hardware-buddy/probe.ts
import type { Context } from '@deepseek-ai/cordis';

export const name = 'probe';

const PROBE_EVENTS = [
  // 基线来自 docs/event-producer-consumer.md，按需增删
  'tools/pre-execute', 'tools/execute', 'tools/post-execute', 'tools/change',
  'agent/created', 'agent/disposed', 'agent/status', 'agent/error',
  'session/created', 'session/disposed', 'session/event', 'session/flush',
  'approval/request', 'approval/asked', 'approval/decided', 'approval/policy',
  'llm/stream',
];

export function apply(ctx: Context) {
  const logger = ctx.logger('probe');

  // 1) dump 已注册工具名清单（dangerousTools 默认值的数据来源）
  setTimeout(() => {
    const tools = (ctx as any).tools;
    if (tools) {
      try {
        const names = typeof tools.list === 'function'
          ? tools.list().map((t: any) => t?.name ?? String(t))
          : Object.keys(tools);
        logger.info('tools: ' + names.sort().join(','));
      } catch (e) { logger.warn('tools dump failed: ' + e); }
    } else {
      logger.warn('tools service not available (check inject)');
    }
  }, 3000);

  // 2) 事件 payload 样例留档
  for (const name of PROBE_EVENTS) {
    ctx.on(name, (...args: unknown[]) => {
      logger.info(`event ${name} ${args.map((a) =>
        typeof a === 'object' ? JSON.stringify(a).slice(0, 300) : String(a)).join(' | ')}`);
    });
  }
}
```

P0 输出 `probe-report.md`，包含：

1. 各事件 runtime payload 样例（重点：`session/event` 的 tool/result / assistant/message、`agent/status`）
2. **真实工具名清单** + 据此定稿 `dangerousTools` 默认正则
3. **`pio device list` 实测 VID/PID**，回填 `config.ts` 默认值与 `discoverPort`
4. 服务名核对（tools / approval / agents / sessions）

---

## 7. 测试策略

### 7.1 单元测试（Vitest）

|文件|覆盖|
|---|---|
|`tests/protocol.spec.ts`|`serializeHeartbeat` 字段过滤、`trimHeartbeat` 900B 裁剪顺序（entries→prompt.hint→prompt→msg）、`summarizeArgs` 截断、`decisionToOutcome`|
|`tests/bridge.spec.ts`|`session/created → total+1`、`agent/status` 双向、entries 上限、celebrate 阈值、快照节流|
|`tests/approval.spec.ts`|**ask 路径**、**设备离线 → next() 不 deny**、**排除名单 → next()**、`exec.agent` 缺失 → next()、超时 cancelled、`req.signal` abort cancelled、A/B 按钮映射、unpair 全量 cancel、参数缓存按 callId 命中/清理、**非法正则 warn+跳过**、dry-run 统计输出|

### 7.2 Mock CDC 集成测试

`tests/e2e/fake-port.ts` 实现与 `serialport` 同接口的 `FakeSerialPort`：心跳序列化与 900B 约束、permission 命令映射、断连重连后自动补发全量快照。

### 7.3 设备端测试

固件手动矩阵（AC1-AC5、AC12 前半）+ 可选 PlatformIO native 测试喂 `_applyJson` 各字段组合。

### 7.4 端到端（人工）

按 `prd.md §5` 跑全部用例（重点新增 AC13 设备离线不干扰），记录到 `tests/e2e/manual-report.md`。AC2-AC7、AC12 为**人工验收**，无 HIL 自动化兜底（PRD §6 已显式声明该缺口）。

### 7.5 CI

```yaml
name: hardware-buddy
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: dsh-hardware-buddy } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm, cache-dependency-path: dsh-hardware-buddy/pnpm-lock.yaml }
      - run: pnpm install
      - run: pnpm test
      - run: pnpm lint
```

（自包含目录，不做 monorepo `--filter`。）固件 CI 沿用 CodeBuddy 既有 workflow。

---

## 8. 给 Coding Agent 的执行顺序

1. **P0 探测插件**（0.5 天）→ `probe-report.md`（payload 样例 + 工具名 + VID/PID + 默认正则定稿）
2. **P1 固件净化**（2 天）→ §2.3 全部 BLE 调用点 `#if` + §2.4 OTA 解耦 + 文案 → `pio run` 通过 → AC1/AC2 + 刷入不回滚
3. **P2 dsh 插件骨架**（1 天）→ 自包含包结构 + `CdcBridge` + 定时全量心跳（含裁剪）+ 配置 → AC3
4. **P3 双向审批**（2 天）→ `ApprovalBridge`（参数缓存 + next() 回退 + race）→ AC4-AC7、AC13
5. **P4 收尾**（1.5 天）→ 热插拔、Web UI 分流、HMR、单测、E2E、README → 全部非 stretch AC

### 8.1 必须的代码引用（已逐条对源码核实）

|改动|文件:行|
|---|---|
|`data.h` 删 BLE drain|`firmware/src/data.h:401-414`|
|`data.h` `_usbLine.feed`（保留）|`firmware/src/data.h:399`|
|`data.h` `_applyJson` 字段定义|`firmware/src/data.h:109-366`|
|`data.h` 心跳窗口 `dataConnected()`|`firmware/src/data.h:75-77`|
|`data.h` 断连清零/文案|`firmware/src/data.h:425-430`|
|`data.h` `bleConnected()` 调用点|`firmware/src/data.h:168, 218, 351`|
|`main.cpp` setup BLE 包 `#if`|`firmware/src/main.cpp` setup()|
|`main.cpp` sendCmd 净化|`firmware/src/main.cpp:207-212`|
|`main.cpp` loop `bleReady` 引用|`firmware/src/main.cpp:2219-2220`|
|`main.cpp` A/B 按钮审批|`firmware/src/main.cpp:2459-2468, 2502-2513`|
|`main.cpp` 30s 屏熄|`firmware/src/main.cpp:2837-2843`|
|OTA BLE 编译点|`firmware/src/ota_status.cpp:6,35`、`ota_update.cpp:765,820`|
|OTA BLE 运行时必需位|`firmware/src/ota_boot_health_logic.h:20-27`|
|unpair 命令处理|`firmware/src/xfer.h:108-112`|
|7 态 enum / 断连 sleep|`firmware/src/persona_logic.h:5, 16`|
|dsh `tools/pre-execute` 声明 / 调用|`packages/core/tools/src/index.ts:152, 1475`|
|dsh `PreToolDecision`|`packages/core/tools/src/index.ts:588-591`|
|dsh `serviceAsk` outcome 映射|`packages/core/tools/src/index.ts:1690-1728`|
|dsh `ApprovalRequest` / waterfall 声明|`packages/interaction/user-approval/src/index.ts:30, 153-174`|
|dsh `ApprovalOutcome`|`packages/interaction/user-approval/src/types.ts:29`|
|waterfall 接管范式（next() 回退）|`packages/acp/acp/src/index.ts:271-285`|
|Cordis waterfall 语义（next=继续，不调=veto）|`vendor/cordis/src/events.ts:77-88, 224-243`|
|Cordis `prepend` 语义|`vendor/cordis/src/events.ts:111-117, 254-260`|
|dsh `SessionEventMap`（event.type 键）|`packages/core/session/src/types.ts:236-333`|
|dsh `TokenUsage`（camelCase）|`packages/llm/llm/src/types.ts:135-141`|
|dsh `agent/status` payload `{agent,status}`|`packages/core/agent/src/runtime-types.ts:159, 168, 178, 290`|
|dsh 权威事件矩阵|`docs/event-producer-consumer.md`（自动生成）|
|dsh 插件发布（dsh.bundle / dsh plugin add）|`docs/user/develop/basic/publish.md`、`packages/boot/app-boot/src/profile.ts:42-45, 391-393`|
|dsh patch 栈 / HMR|`apps/cli/src/profile-boot.ts:60-64, 98-103, 122-129, 142-171, 285-294`|
|dsh boot 主流程|`packages/boot/app-boot/src/index.ts:757-802`|

### 8.2 不要做的事

- 不要删除 `ble_bridge.cpp/h`（保留供 `#if CODE_BUDDY_BLE_ENABLED=1` 时使用）
- 不要修改 dsh `packages/`、`vendor/` 任何文件
- 不要绕过 dsh `approval/request` waterfall（如直接 `ctx.approval.setPolicy`）
- **不要在 waterfall 监听器里因设备原因产生 deny / unavailable**——设备离线、排除名单、`exec.agent` 缺失一律 `next()`；不调 `next()` 即 veto 整条链（含 Web UI）
- **不要依赖 CodeBuddy Python host（reducer.py / proxy.py）**——它不在新链路中；900 字节裁剪只在插件 `protocol.ts` 实现一处
- 不要使用 `'session'` / `'agent'` 服务名（真实为 `sessions` / `agents`，复数）
- 不要在 `ApprovalRequest` 上找 `args` / `id` / `tool` 字段（不存在；参数在 pre-execute 阶段缓存）
- 不要自造 AbortController 回写 signal——`req.signal` 是 runtime 传入的，只监听
- 不要按 v1.1 tech 文档的整体重写版 `dataPoll()`（丢断连分支、改 connected 语义）
- 不要预填 `Bash` / `Edit` / `Write` 等 Claude/Codex 工具名进默认正则——等 P0 dump
- 不要引入新的 OTA server 或修改 OTA 信任脚本

---

## 9. 修订记录

### v1.3（相对 v1.2，吸收外部审查意见）

1. **FR2 token 生命周期语义显式化**：进程内存态、重启/HMR 清零、`tokens_today` 非自然日、celebrate 可重复触发（有意取舍）；持久化列入 PRD Backlog
2. **新增 FR8**：`hardware-buddy/connection-changed` 自定义事件（Web UI hook）+ 启动版本自检（dsh-tools 版本漂移 warn 不 throw，§3.9）
3. **正则配置健壮性**（§3.7）：编译失败 warn+跳过、启动 dry-run 匹配统计（`compilePatterns` / `dryRunMatch`）
4. **平台范围显式化**（NFR10）：macOS 主环境、Linux 附带（dialout 排障说明）、Windows 不支持（Backlog）
5. **人工验收缺口显式化**：AC2-AC7、AC12 无 HIL 自动化兜底（单人项目）
6. **风险表新增**：正则配置失效、版本漂移、Linux dialout、多实例抢占（单实例假设）、协议信任边界（有意为之）、serialport prebuild（MVP 接受）
7. **PRD 新增 Backlog 表**：usage 数据源（字段命名保留，国内接口常见 5 小时窗口）、tokens 持久化、chime 提示音、serialport 安装兜底、多实例串口锁、serialNumber 消歧、Windows、HIL

### v1.2（相对 v1.1）

1. **waterfall 语义修正**：v1.1 的 `approvalRequestHook` 不调 `next()` 且设备离线时 resolve `'unavailable'`，实际效果是短路 Web UI 并 deny 一切白名单工具；改为"设备在线才接管，否则 `next()`"（范式：ACP 桥）
2. **excluded 工具矛盾修正**：v1.1 对排除名单返回 `{kind:'deny'}` 与 S4"Web UI 二次确认"矛盾（deny 是终局拒绝，Web UI 不会弹）；改为同样返回 `ask` 但审批层 `next()` 放行
3. **`ApprovalRequest` 字段修正**：无 `args`/`id`/`tool`；真实字段 `agent/toolName/callId?/reason?/signal?`（153-174 行）；参数改为 pre-execute 阶段按 `callId` 缓存；`signal` 是 runtime 传入、插件只监听
4. **服务名修正**：`sessions`/`agents`（复数）；v1.1 架构图的 `inject([... 'session'])` 会让插件永久挂起
5. **OTA/BLE 解耦新增**：`OTA_BOOT_READY_BLE` 必需位 + `ota_status.cpp`/`ota_update.cpp`/`data.h`/`main.cpp` 编译点；P1 由 1 天改 2 天
6. **900 字节截断归属修正**：从"reducer.py 强制"改为插件 `protocol.ts` 强制（reducer.py 属被替换的 Python host）
7. **仓库基建修正**：CodeBuddy 仓库为纯 Python 仓库，插件 tsconfig 自包含、CI 不用 monorepo `--filter`
8. **事实修正**：无 NimBLE 依赖（BLE 为 Bluedroid）、`platformio.ini` USB 宏在 18-19 行、`proxy.py` 实际映射为 accept/decline（引用删除）、schemastery 3.18.1 / cosmokit 1.8.2、CLI 包名 `@deepseek-ai/dsh`、patch 栈含 bundle 层且 `cordis.yml` 为空根、无 `plugins:` 键、HMR 对象为 `cordis.patch.yml`、`safetyLevel`/`@ToolMeta` 不存在（FR7 改纯正则）、固件无通用 watchdog、activity20 校验位置、xfer.h unpair 行号 108-112
9. **心跳模型明确**：定时全量快照（默认 3s）替代逐事件发送；设备 connected 为 30s 心跳窗口
10. **范围调整**：usage/配额（AC10）降为 stretch；OTA 推送（原 AC12）改为"信任链回归 + 刷入不回滚"；新增 AC13（设备离线不干扰）；工期 6 → 7 天 + 1 天 buffer
