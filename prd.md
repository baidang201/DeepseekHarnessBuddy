# 📄 产品需求文档（PRD）

> **文档用途**：定义项目目标、用户、功能范围、验收标准与里程碑。供产品经理、项目负责人，以及作为 coding agent 的任务输入上下文。
>
> **基线仓库**：`https://github.com/CharlexH/CodeBuddy`（fork 后维护，公共仓已归档）
>
> **宿主框架**：`deepseek-ai/deepseek-harness`，锚定 `@deepseek-ai/dsh-tools@0.1.0-rc.7` / `@deepseek-ai/dsh-user-approval@0.1.0-rc.7` / `@deepseek-ai/cordis@4.0.1`
>
> **目标硬件**：M5Stack StickS3（ESP32-S3-PICO-1-N8R8，8MB Flash + 8MB PSRAM，USB-C 走 GPIO19/20 USB-Serial/JTAG 外设）
>
> **文档版本**：v1.3（v1.2 基础上吸收外部审查意见：token 生命周期语义、连接状态事件、正则配置校验、版本自检、平台范围与 Backlog 显式化，见 §6 Backlog 与 tech §9 修订记录）

---

## 1. 项目背景与目标

### 1.1 背景

**CharlexH/CodeBuddy** 是一个把 Anthropic Claude Desktop Buddy 移植到 OpenAI Codex StickS3 硬件宠物的项目。它的固件功能完整：

- 18 个 ASCII 宠物 × 7 态动画（`firmware/src/buddies/*.cpp` × `PersonaState` enum at `firmware/src/persona_logic.h:5`）
- 状态屏 / 审批屏 / 设置屏 / 离线屏
- 配额表（5 小时 / 7 天剩余百分比）、横向仪表盘
- 安全 OTA 信任链（`inject-ota-trust.py` + `verify-ota-rollback-symbol.py` + `firmware/src/ota*.cpp`；固件字节走 WiFi HTTPS，offer/授权协调走 BLE NUS）
- 充电时钟、周五庆祝、摇一摇 dizzy 态（`main.cpp:2253`）
- BLE NUS 协议（`firmware/src/ble_bridge.cpp`，基于 Arduino core 自带 Bluedroid 栈，**无 NimBLE 依赖**）与 JSON 双向心跳（`firmware/src/data.h:_applyJson` at `:109-366`）

固件代码事实上同时从 USB CDC 串口读取并复用同一 `_applyJson`（`data.h:399`），但 host 侧从未实现过 USB 传输，`firmware/REFERENCE.md` 公开的协议也仅覆盖 BLE NUS。本方案把 USB CDC **升级为唯一传输通道**，并配套实现 host 侧。

**deepseek-harness**（简称 dsh）是 DeepSeek 开源的 Agent 运行时框架：

- 基于 Cordis 插件总线（vendored `@deepseek-ai/cordis@4.0.1` + vendored `cordis-plugin-loader` / `cordis-plugin-include` / `cordis-plugin-hmr`）
- dsh 工具核心在 `0.1.0-rc.7`（`packages/core/tools/package.json`），用户审批在 `packages/interaction/user-approval/`
- 官方明确后续会有兼容性破坏性变更
- dsh 是 host(Node.js) + 浏览器 client 双侧模型：浏览器侧插件必须 browser-pure（禁原生模块）；本插件**只在 host(Node) 侧运行，不声明 `dsh.client`**

### 1.2 目标

复用 CodeBuddy 固件的 **全部 UI/状态机/动画资产**，将 CodeBuddy host 侧的角色从 OpenAI Codex 改为 deepseek-harness：

1. **固件**：把 BLE 通道从默认传输层降级为**编译期可选**（`#if CODE_BUDDY_BLE_ENABLED`），USB CDC 成为唯一默认路径。host 侧原有的 BLE 配对 / launchd agent / CoreBluetooth helper（整个 Python host）不再使用。⚠️ BLE 与 OTA 存在编译期与运行时双重耦合，解耦是必做工作项（见 1.3 与 tech §2.3）。
2. **dsh 插件**（`dsh-hardware-buddy/`，自包含 npm 包）：以 npm 包形式发布，通过 `dsh plugin add` 安装、`dsh.bundle` manifest 声明（dsh 真实约定，见 `docs/user/develop/basic/publish.md`）。监听 dsh Cordis 事件总线，把状态序列化为 CodeBuddy 协议心跳（含 900 字节裁剪，逻辑移植自 CodeBuddy `reducer.py`）通过 USB CDC 推送到 StickS3；同时接收设备的 A/B 按钮审批决策，回灌到 dsh `approval/request` waterfall。
3. **配置化**：串口路径、VID/PID 过滤、审批超时、工具正则名单、token celebrate 阈值、心跳间隔全部通过 Cordis `@deepseek-ai/schemastery` 配置 schema 暴露。

### 1.3 关键决策摘要

|决策|取舍|原因|
|---|---|---|
|BLE 保留但编译期禁用|不删 `ble_bridge.cpp`，所有 BLE 调用点包 `#if`|保留无线排错路径；**必须同步解耦 OTA 对 BLE 的硬依赖**，否则新固件 30s 内自动回滚|
|USB CDC 单通道上线|移除 BLE 分支作为默认传输|macOS 即插即用；ESP32-S3 原生 USB 免驱（VID/PID 以 P0 实测为准）|
|独立自包含 npm 包分发|仓库 root 创建 `dsh-hardware-buddy/`，**不 extends 仓库外 tsconfig、不依赖 pnpm workspace**|CodeBuddy 仓库是纯 Python 仓库（无 package.json / tsconfig.base.json / pnpm-workspace.yaml），插件必须自包含|
|A/B 按钮语义沿用 CodeBuddy|设备端协议字面量不变|兼容现有 18 个 ASCII 角色与 UI 渲染|
|dsh `approval/request` 接入|不绕过 dsh 审批 seam|不破坏 dsh 的策略 / 审计日志；遵循 Cordis waterfall 语义：**设备在线才接管（prepend），否则必须 `next()` 放行给 Web UI，插件永不因自身原因 deny**|

### 1.4 非目标

- 不做 BLE 远程使用（项目放弃 wireless buddy 路径）
- 不做 WebSocket 并行通道（未来工作；本次保持 USB-CDC 单一传输）
- 不改 dsh Cordis 核心、approval 策略语义
- 不引入新的宠物角色或动画系统
- **不做 OTA coordination 的 host 侧移植**（CodeBuddy 的 OTA offer/授权协调属于被替换的 Python host，BLE NUS 通道也已移除；本版本只保证 OTA 信任链编译回归与手动刷写不回滚，OTA 推送流程列为后续工作）
- 配额（usage）数据源接入列为 stretch goal（dsh 无现成配额查询服务，需调研 DeepSeek 开放平台能力）
- 不做 chime 提示音（原 CodeBuddy 的 turn 完成提示音与多 agent 去重逻辑不移植；若未来恢复，触发点候选 `agent/status: running→idle`——记入 Backlog，防止无意识缺失）
- 不支持 Windows（`discoverPort` 的路径匹配仅覆盖 macOS/Linux；Windows 的 `COM*` 枚举记入 Backlog）
- 不处理多 dsh 实例抢占同一串口（**单实例假设**；EBUSY 场景记入 Backlog）
- 不做多设备 `serialNumber` 消歧（**单设备假设**；记入 Backlog）

---

## 2. 用户画像与场景

### 2.1 角色

|角色|诉求|非目标|
|---|---|---|
|**主用户（dsh 开发者 / 重度用户）**|物理设备显示 Agent 状态、快捷审批危险工具；**设备不在手边时 dsh 一切照旧**|无线远程审批；多设备同时连接|
|**小白用户**|不配置 BLE 配对、不装 launchd agent，插 USB-C 即用|自定义固件；自研协议|
|**维护者**|插件硬绑定 dsh 0.1.0-rc.x；协议层与 dsh API 解耦|追 dsh 任意最新版本不锁版本|

### 2.2 典型场景

|场景|触发|期望|
|---|---|---|
|**S1：状态镜像**|dsh 在跑长任务|屏幕显示 busy + token 累计；shake 出 dizzy；任务结束出 celebrate（若超过阈值）|
|**S2：物理审批**|任务触发危险工具调用|屏幕进入 attention 审批屏，显示工具名 + 参数摘要；A 放行 / B 拒绝|
|**S3：拔线容忍**|用户拔 USB-C|屏幕转 sleep；dsh 插件不崩溃；插回自动恢复心跳|
|**S4：危险工具走 Web UI**|任务触发 `MCP__danger_*`|屏幕**不**显示审批屏；插件在 `approval/request` waterfall 中 `next()` 放行，由 dsh Web UI 审批|
|**S5：配额预警（stretch）**|`usage.five_hour_remaining < 0.2`|状态屏额外显示进度条或图标（协议字段见 tech §4；数据源待定，见 FR2）|
|**S6：设备离线不干扰**|dsh 运行但设备未插|插件退位，危险工具审批回落到 dsh Web UI / 默认策略，**绝不自动 deny**|

---

## 3. 功能需求

### FR1：固件 USB CDC 单通道

- 默认编译：`ARDUINO_USB_CDC_ON_BOOT=1` + `ARDUINO_USB_MODE=1` 已生效（`firmware/platformio.ini:18-19`），`Serial = HWCDC` 写 USB CDC
- macOS 枚举为 `/dev/cu.usbmodem*`，Linux 为 `/dev/ttyACM*`，免驱。**VID/PID 由 P0 用 `pio device list` 实测后写入文档与发现逻辑**（不预设 0x303A/0x4001 等具体值）
- `dataPoll()` 仅保留 USB 分支：保留现有 `_usbLine.feed(Serial, ...)` 行读取（`data.h:399`），**删除** BLE ring 分支（`data.h:401-414`）。连接判定沿用"30s 心跳窗口"（`dataConnected()`，`data.h:75-77`），host 侧按 FR5 节奏保活；断连清零与提示文案（`data.h:425-430`，原文案 "No Codex connected"）一并更新为 DSH 文案
- 保留 7 态状态机（`PersonaState` enum）、A/B 按钮回调、IMU shake、ASCII 角色（`firmware/src/buddies/`）、30s 屏熄（`SCREEN_OFF_MS = 30000` at `main.cpp:111`）
- 设备 → 宿主 心跳：JSON 单行 + `\n` 结束，最大 900 字节（**由 dsh 插件 `protocol.ts` 强制**，裁剪策略移植自 CodeBuddy `reducer.py:77-103`；原 `_BLE_PAYLOAD_MAX_BYTES` 只存在于被替换的 Python host，不在新链路中）

### FR2：dsh 插件状态上行

监听 dsh Cordis 事件总线，以"状态机 + 定时全量快照"模型（沿用 CodeBuddy reducer 思路）推送心跳，**不做逐事件即时发送**（`assistant/chunk` 为流式高频事件）：

|来源|事件|字段|备注|
|---|---|---|---|
|活跃会话|`session/created` / `session/disposed`（`packages/core/session/src/index.ts:54,64`）|`total`|**只计 session 一种口径**，不同时累计 agent 事件（避免双计数）|
|agent 运行状态|`agent/status`（`runtime-types.ts:178`）|`running`|payload 为 `{ agent, status }`，`status: 'idle' \| 'running'` 双向流转，两个方向都要处理|
|等待审批的工具调用|`approval/request` waterfall（`user-approval/src/index.ts:30`）|`waiting`|见 FR3|
|会话事件摘要|`session/event`（`session/src/index.ts:76`，签名 `(session, event)`）过滤 `event.type === 'tool/result'` / `assistant/message`|`entries[]`（≤5 条）|摘要**从 `event.message`（`ToolResultMessage` / `AssistantMessage`）提取**；事件上不存在 `summary` 字段|
|token 累计|`session/event` 过滤 `event.type === 'assistant/chunk'` 且 `chunk.type === 'usage'`（**live 唯一来源**；落盘的 `assistant/message.usage` 是持久化补写，live emit 不带）；⚠️ live 载荷带信封 `{type,seq,time,data}`，业务字段在 `ev.data`|`tokens`、`tokens_today`|`TokenUsage` 字段为 camelCase `inputTokens`/`outputTokens`（+ 可选 cache/reasoning 字段），见 `packages/llm/llm/src/types.ts:135-141`；计数为全量消耗（input+output+cacheRead+cacheWrite+reasoning）|
|token 强度可视化|本地按 20s 窗口聚合|`activity20`（uint32, low-20-bit rolling，固件校验在 `data.h:290-298`）、`token20v1`（base64url 86 字节，64 bin × 20s，`token_heartbeat_logic.h:7-10`）||
|配额（stretch）|待定（dsh 无现成配额服务）|`usage = { five_hour_remaining, seven_day_remaining }`|数值 0-1；数据源待调研，S5/AC10 为 stretch 验收；**字段命名保留原样**（国内接口普遍存在 5 小时滚动窗口限额，语义兼容）|
|celebrate 触发|本地累计 tokens ≥ `celebrateThreshold`|`msg`|默认 50 000（可配）|

> **token 生命周期语义（显式定义，避免验收歧义）**：`tokens` / `tokens_today` 为**进程内存态**——dsh 进程重启或插件 HMR 热重载即清零；`tokens_today` 的语义是"进程存活期累计"，不是自然日累计；`celebrateFired` 随之复位，重启后再次达到阈值会再次触发 celebrate。这是 v1 的有意取舍（避免状态落盘复杂度），跨进程/跨日持久化列入 Backlog（§6）。AC9 验收以此口径为准。

### FR3：设备审批下行（含安全回退原则）

**总原则：硬件插件只增强审批体验，永不因自身原因拒绝工具调用。**

- 监听 `tools/pre-execute` waterfall（`packages/core/tools/src/index.ts:152`，调用点 `:1475`，监听器签名 `(exec: ToolExecution, next)`）：
  - 工具名匹配 `dangerousTools` **或** `excludedTools` 正则 → **先缓存参数**（`exec.callId` → `{ name: exec.name, args: exec.arguments }`，因为 `ApprovalRequest` 上**不携带参数**），然后返回 `{ kind: 'ask', reason?: string }`（ask 的 reason 可选，deny 的 reason 必填）
  - ⚠️ `exec.agent` 缺失时返回 ask 会被 runtime 降级为 deny（`tools/src/index.ts:1702`），因此 `exec.agent` 或 `exec.callId` 缺失时直接 `next()` 放行
  - 不在任何名单 → `next()`（内建默认为 `allow`）
- `tools/pre-execute` 返回 `{ kind: 'ask' }` 后，dsh runtime 调 `ctx.approval.request({ agent, toolName, callId, signal })`（`tools/src/index.ts:1706`），触发 `approval/request` waterfall。监听器以 `{ prepend: true }` 注册，逻辑：
  - `req.toolName` 匹配 `excludedTools` → `next()` 放行给后续消费者（dsh Web UI / apiproxy 处理），**设备不弹审批屏**
  - 设备（CDC）不在线 → `next()` 放行给 Web UI，**绝不 resolve `'unavailable'`**（Cordis waterfall 中不调 `next()` 即 veto 整条链，包括 Web UI）
  - 设备在线 → 接管：从参数缓存取摘要，把 `{ waiting: 1, prompt: { id, tool, hint } }`（`id` 优先用 `req.callId`，否则插件铸造）作为心跳字段推给设备，等待：
    - 设备 A 按钮 → `{"cmd":"permission","id":"...","decision":"once"}` → 监听器返回 `'allowed-once'`
    - 设备 B 按钮 → `{"cmd":"permission","id":"...","decision":"deny"}` → 监听器返回 `'rejected'`
    - 超时（FR4）→ 返回 `'cancelled'`
    - `req.signal` 被 runtime abort → 返回 `'cancelled'`
  - 正确的 waterfall 接管范式参照 dsh ACP 桥（`packages/acp/acp/src/index.ts:271-285`：不归我管就 `next()`）
- 设备侧协议字面量沿用 CodeBuddy（`main.cpp:2461, 2508`）；**dsh 侧返回值映射**：`once` → `'allowed-once'`、`deny` → `'rejected'`（dsh `ApprovalOutcome` 定义见 `user-approval/src/types.ts:29`；runtime 映射见 `tools/src/index.ts:1713-1728`）
- 设备发送 `{"cmd":"unpair"}` → 视为全量 cancel 当前 pending（沿用 `xfer.h:108-112` 命令）

### FR4：审批超时

- 插件自持超时定时器：默认 `approvalTimeout = 30 000ms`，可配置；超时 resolve `'cancelled'`
- **`req.signal` 是 runtime 传入的 AbortSignal**（`ApprovalRequest.signal?`，`user-approval/src/index.ts:173`；来源 `exec.signal`），插件应当**监听**它（用户在别处取消时返回 `'cancelled'`），与设备按钮、超时定时器三方 race。不自行构造 AbortController 回写
- dsh runtime 把 `'cancelled'` 映射为 deny 并附 reason `"approval for tool \"x\" was cancelled"`（`tools/src/index.ts:1720`）

### FR5：热插拔、重连与心跳保活

- **心跳节奏**：设备端 `connected` 判定是"30s 内收到有效 JSON 行"（`data.h:75-77`）。插件必须以固定间隔（`heartbeatIntervalMs`，默认 3000ms）发送全量快照心跳保活，即使无状态变化；重连成功后立即补发一次全量
- USB 拔出：`Serial` 不可写；`cdcBridge.send()` 检测到未连接静默丢弃
- dsh 插件不崩溃：`CdcBridge` 用 `ctx.effect()` 管理串口生命周期
- 重新插入：5s 轮询重连，自动恢复心跳；`recentEntries[]` 保留
- 设备端：心跳窗口超时后 `derivePersonaState()` 返回 `P_SLEEP`（`persona_logic.h:16`），并触发断连清零文案（`data.h:425-430`）

### FR6：配置 schema

通过 `@deepseek-ai/schemastery` 暴露：

|字段|类型|默认|说明|
|---|---|---|---|
|`port`|string \|null|`null`|null 时自动 `discoverPort()`|
|`vendorId`|string|`'0x303A'`|按 USB VID 过滤（Espressif；以 P0 实测为准）|
|`productId`|string \|null|`null`|可选按 PID 进一步过滤|
|`baudRate`|number|`115200`|USB CDC 下为 no-op，保留仅为兼容 serialport API|
|`approvalTimeout`|number|`30000`|单位 ms|
|`heartbeatIntervalMs`|number|`3000`|全量快照间隔，必须 ≪ 设备 30s 心跳窗口|
|`dangerousTools`|string[]|`[]`（待 P0 dump 真实工具名后填默认值）|走硬件审批的正则名单|
|`excludedTools`|string[]|`['^MCP__danger_.*']`|走 Web UI 审批的正则名单|
|`celebrateThreshold`|number|`50000`|token 累计超过此值触发 celebrate 态|
|`entriesLimit`|number|`5`|心跳 entries 数组最大长度|
|`logLevel`|string|`'info'`||

> ⚠️ 默认 `dangerousTools` 不预填 `Bash`/`Edit`/`Write` 等 Claude/Codex 世界的工具名——dsh 的内置工具名以 P0 探测结果为准（dsh 生态有 `fs.*`、`run_code` 等），正则不命中 = 硬件审批永不触发。

### FR7：工具名单分级（纯正则实现）

- dsh 工具定义**不存在** `safetyLevel` / `@ToolMeta` 元数据（全仓零命中，`ToolDefinition` 见 `tools/src/index.ts:222-262`），分级**只能**靠 `dangerousTools` / `excludedTools` 正则名单
- `dangerousTools` → 硬件审批屏（FR3）
- `excludedTools` → 同样返回 `ask`，但在 `approval/request` 中 `next()` 放行，由 dsh Web UI 审批
- 工具名单与真实工具名的对齐由 P0 探测产出
- **正则配置健壮性**：启动时对 `dangerousTools` / `excludedTools` 逐条编译，编译失败的规则 **warn 并跳过**（不让插件崩溃）；并用已知工具名清单做一次 dry-run 匹配统计输出到日志（如 `dangerousTools matched 3/47: [...]`），让"配置静默失效"可见

### FR8：连接状态事件与运行时自检

- CDC 连接/断开时 `ctx.emit('hardware-buddy/connection-changed', { connected })`，为后续 Web UI 状态徽标留 hook（本期无 UI 消费者，纯事件出口）
- 启动时读取运行环境中 `@deepseek-ai/dsh-tools` 的实际版本，与锚定版本（rc.7）不一致时 log **warn**（不 throw）——dsh 处于 rc 阶段、明确会有破坏性变更，版本漂移必须第一时间在日志可见，而不是表现为静默的行为异常

---

## 4. 非功能需求

|ID|需求|说明|
|---|---|---|
|NFR1|硬件兼容性|固件兼容 M5Stack StickS3（ESP32-S3-PICO-1-N8R8，8MB Flash + 8MB PSRAM）|
|NFR2|传输性能|单次 CDC 写入心跳 ≤ 900 字节（插件 `protocol.ts` 强制，裁剪顺序：entries 逐条删 → prompt.hint 缩短/删 → msg 缩短）；设备侧行缓冲 1024 字节只有静默截断，无丢行保护，超限 JSON 会解析失败被忽略|
|NFR3|实时性|`dataPoll()` 单次串口读取 ≤ 5ms 预算（远低于一帧 ST7789 SPI 渲染预算 25-50ms）；主循环 16ms / 屏熄 100ms|
|NFR4|稳定性|dsh 插件崩溃隔离（`ctx.effect()` 清理）；固件侧**无通用 watchdog**（仅 OTA boot health 监督任务，`ota_boot_health.cpp:189-210`），不以此为兜底|
|NFR5|可维护性|固件侧"协议解析"（`data.h`）与"传输层"解耦；host 侧 900 字节裁剪只存在于 `protocol.ts` 一处|
|NFR6|版本锁定|`peerDependencies` 锁定：`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-tools@0.1.0-rc.7`、`@deepseek-ai/dsh-user-approval@0.1.0-rc.7`、`@deepseek-ai/dsh-agent@0.1.0-rc.7`、`@deepseek-ai/dsh-session@0.1.0-rc.7`、`@deepseek-ai/schemastery@3.18.1`、`@deepseek-ai/cosmokit@1.8.2`（注：schemastery/cosmokit/cordis 在 dsh 仓库均为 vendored workspace 包，以上为其实际版本）。**Cordis 服务名为 `tools` / `approval` / `agents` / `sessions`（后两个为复数）**，写错服务名会让 `ctx.inject` 永久挂起|
|NFR7|OTA 安全|沿用 CodeBuddy OTA 信任链脚本（`inject-ota-trust.py` / `verify-ota-rollback-symbol.py`）；**必须完成 BLE/OTA 解耦**（`OTA_BOOT_READY_BLE` 是镜像确认必需位，`ota_boot_health_logic.h:20-27`，不解耦则新固件 30s 回滚）；不引入新 OTA server，OTA coordination 移植为后续工作|
|NFR8|可观测性|dsh 插件使用 `ctx.logger('hardware-buddy')` 命名空间；设备端事件日志输出到 USB-Serial|
|NFR9|运行环境|插件只跑 host(Node.js) 侧（`serialport` 含原生模块；dsh host 侧已有 node-pty/koffi 原生模块先例），**不声明 `dsh.client`**，不进入浏览器 bundle|
|NFR10|平台范围|本期仅支持 **macOS**（开发主环境，MVP 验收环境）；Linux 附带支持（需 `dialout` 组权限，README 排障说明 `sudo usermod -aG dialout $USER`）；Windows 不支持（Backlog）|

---

## 5. 验收标准

|#|用例|通过条件|
|---|---|---|
|AC1|固件烧录与 CDC 枚举|StickS3 刷入改造后固件，macOS 上电后 `/dev/cu.usbmodem*` 自动出现；`pio device list` 能识别并记录 VID/PID|
|AC2|手动 CDC 心跳|`pio device monitor` / `screen` 连接串口发送单行 JSON 心跳（含 `running/waiting/total/msg`），设备屏幕状态正确切换（idle↔busy↔attention↔celebrate↔sleep）|
|AC3|真实状态镜像|dsh 跑任意长任务，设备屏幕实时反映 `agent/status` 的 running/idle 状态|
|AC4|物理审批闭环|dsh 触发白名单工具调用，设备显示审批屏（工具名 + 参数摘要 120 字内，参数来自 pre-execute 阶段缓存）；按 A → dsh 继续执行；按 B → dsh 收到 deny reason `the user rejected tool "x"`|
|AC5|拔插重连|拔 USB → 设备转 sleep 屏、dsh 插件日志输出 `cdc disconnected`、进程不退出；插回 → 5s 内自动恢复心跳（全量快照）|
|AC6|危险工具走 Web UI|dsh 触发 `excludedTools` 匹配的工具调用，**设备审批屏不出现**，dsh Web UI 弹出审批（由插件 `next()` 放行实现）|
|AC7|审批超时|在设备审批屏停留超过 `approvalTimeout`（默认 30s），自动转 `'cancelled'`，任务被 deny（reason 含 `was cancelled`）|
|AC8|配置生效|修改 profile 的 `cordis.patch.yml` 里 `approvalTimeout: 5000`，配置热更新（HMR 监听对象是 `cordis.patch.yml`，不是 `cordis.yml`）后下一次审批按 5s 超时|
|AC9|celebrate 触发|累计 tokens 超过 `celebrateThreshold`（默认 50K），设备出 celebrate 态 3000ms（token 为进程生命周期口径，见 FR2 语义说明）|
|AC10|配额显示（stretch）|`usage.five_hour_remaining < 0.2` 时状态屏显示进度条；**数据源未定，允许延期**|
|AC11|探测插件|`probe` 插件运行后输出真实事件 payload 样例 + 真实工具名清单 + 实测 VID/PID（见 tech §6）|
|AC12|OTA 回归|`inject-ota-trust.py` + `verify-ota-rollback-symbol.py` 通过、固件编译通过；刷入后设备**不发生 30s 回滚**（验证 BLE 位解耦正确）。OTA 推送流程不在本版验收|
|AC13|设备离线不干扰|设备未插时 dsh 跑白名单工具任务：插件退位（`next()`），Web UI / 默认策略正常审批，**无自动 deny**|

---

## 6. 里程碑

|Phase|交付物|工期|前置|
|---|---|---|---|
|**P0**|探测插件：以 dsh `docs/event-producer-consumer.md` 为基线核对事件 + runtime probe 验证 payload + **dump 真实工具名清单** + **实测 VID/PID**（tech §6）|0.5 天|—|
|**P1**|固件净化：`data.h` 删 BLE 分支、所有 BLE 调用点包 `#if`（含 `ota_status.cpp` / `ota_update.cpp` / `data.h:168,218,351` / `main.cpp:2219-2220`）、**OTA/BLE 解耦（`OTA_BOOT_READY_BLE` 位处理）**、断连文案更新、保留 OTA 信任链|2 天|—|
|**P2**|dsh 插件骨架 + CDC 连通：自包含 npm 包结构、`CdcBridge` 类（VID/PID 发现）、定时全量心跳（含 900 字节裁剪）、配置 schema|1 天|P0|
|**P3**|双向审批：`approval/request` 监听器（prepend + next() 回退）+ `tools/pre-execute` 参数缓存 + A/B 按钮映射 + 超时/信号 race|2 天|P2|
|**P4**|收尾：热插拔重连、Web UI 分流、HMR 配置、单元测试、E2E dsh 任务验证、README|1.5 天|P3|
|**合计**||**7 天**（+1 天 buffer）||

> ⚠️ 工期假设：单人 / 全职 / 单台 StickS3 / dsh 单 profile 跑通。
>
> ⚠️ 已知验收缺口（显式声明）：AC2-AC7、AC12 为**人工验收**，无自动化兜底——单人项目、无硬件在环（HIL）CI；"固件+插件"端到端链路仅靠 `tests/e2e/manual-report.md` 保障。

### Phase Exit Gate

- P0 → P1：probe 报告入档（事件 payload 样例 + 工具名清单 + VID/PID + `dangerousTools` 默认值定稿）
- P1 → P2：`screen` / `pio device monitor` 双向通信验证通过（AC1 + AC2），且刷入固件不回滚（AC12 前半）
- P2 → P3：dsh 跑空任务时设备状态屏可见且 30s 不睡（AC3）
- P3 → P4：审批闭环手动验证通过（AC4-AC7、AC13）
- P4 → Done：所有非 stretch AC 通过 + README 完成

### Backlog（显式延后项，防止无意识缺失）

|项|说明|触发条件|
|---|---|---|
|品牌清理：Codex → DeepSeek Harness|固件侧可见字符串替换：`btName = "Codex"` / `"Codex-%02X%02X"`（`main.cpp`，蓝牙名，BLE 默认禁用下优先级低但改动极小）、设置/信息屏与注释里的 Codex 文案；README/REFERENCE.md 文档措辞；**已改完的**：断连文案 `"No DSH host"`（P1）、`dsh-hardware-buddy/` 全套命名。另需决策：被替换的 Python host（`src/codex_buddy/` 整包，已不在新链路中）归档还是删除（`tests/` 32 个 pytest 随之处理）|下一轮迭代|
|usage 数据源接入|保留 `five_hour_remaining` / `seven_day_remaining` 字段命名（国内接口普遍存在 5 小时窗口限额，语义兼容）；需调研 DeepSeek 开放平台可查询的计费/限额接口|数据源确认后|
|tokens 持久化|跨进程/跨日累计，消除重启清零与 celebrate 重复触发（可落盘 `$DSH_HOME` 下小状态文件）|用户体验反馈|
|chime 提示音|turn 完成提示音 + 多 agent 并发去重（触发点候选 `agent/status: running→idle`）|用户需求|
|serialport 安装兜底 README|prebuild 缺失时的编译依赖说明（macOS `xcode-select --install` / Linux build-essential）；MVP 阶段本地环境可用即可|正式分发前|
|多实例串口锁|`$DSH_HOME` 下 PID 文件锁；EBUSY 识别与降频重连|多实例需求出现|
|多设备 serialNumber 消歧|config 增加可选 `serialNumber` 字段精确锁定设备|持有 ≥2 台设备|
|Windows 支持|`discoverPort` 增加 `COM\d+` 匹配分支 + VID/PID 校验|用户群需要|
|HIL 硬件在环|自托管 runner + 实体设备烟雾测试（覆盖 AC2 级别即可）|团队规模扩大|

---

## 7. 附录

### A. 设备侧协议字面量（沿用 CodeBuddy）

**宿主 → 设备**：单行 JSON + `\n`，最大 900 字节（**由 dsh 插件 `protocol.ts` 裁剪强制**，顺序：entries → prompt.hint → msg）

```json
{"total":1,"running":1,"waiting":0,"msg":"DSH running","entries":["10:42 git push"],"tokens":184502,"tokens_today":12034,"activity20":1048575,"token20v1":"...86B base64url...","usage":{"five_hour_remaining":0.42,"seven_day_remaining":0.78}}
```

**设备 → 宿主**：单行 JSON + `\n`

```json
{"cmd":"permission","id":"dsh-1723456789-abc123","decision":"once"}
```

```json
{"cmd":"permission","id":"dsh-1723456789-abc123","decision":"deny"}
```

```json
{"cmd":"unpair"}
```

完整字段定义见 CodeBuddy `firmware/src/data.h:109-366` 的 `_applyJson()`。裁剪逻辑原版参考 CodeBuddy `reducer.py:77-103`（注意：reducer.py 属于被替换的 Python host，**不在新链路中**，逻辑已移植至插件 `protocol.ts`）。

### B. dsh 真实事件矩阵（按使用频度排序）

|事件|模式|我们的用途|文件:行|
|---|---|---|---|
|`tools/pre-execute`|waterfall|拦截名单工具，缓存参数，返回 `ask`|`core/tools/src/index.ts:152`（调用点 `:1475`；`PreToolDecision` at `:588-591`）|
|`approval/request`|waterfall|设备侧 A/B 决策回灌；离线/排除名单 `next()` 放行|`user-approval/src/index.ts:30`（`ApprovalRequest` at `:153-174`）|
|`agent/status`|emit|running 字段（payload `{ agent, status }`）|`core/agent/src/runtime-types.ts:178`|
|`session/created` / `session/disposed`|emit|total 字段|`core/session/src/index.ts:54, 64`|
|`session/event`|emit|entries / tokens / activity20 / token20v1|`session/src/index.ts:76`（签名 `(session, event)`）|
|`session/flush`|parallel|可选：flush 后再发心跳|`session/src/index.ts:85`|
|`agent/error`|emit|切回 idle、显示 msg|`runtime-types.ts:290`|

权威全量事件清单：dsh `docs/event-producer-consumer.md`（自动生成）。Cordis waterfall 语义：不调用 `next()` 即 veto 整条链（`vendor/cordis/src/events.ts:224-243`）。
