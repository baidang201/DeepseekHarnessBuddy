# 🏗️ 第二期技术方案｜StickS3 × deepseek-harness 硬件宠物

> **文档版本**：v2.0-draft（2026-08-20），配套 `prd-p2.md`
> **前置条件**：一期环境（固件已刷、插件已装 web+headless 双 profile、`USAGE.zh-CN.md` 流程可用）
> **原则**：架构不变（插件 + 固件，dsh 源码零修改）；所有行号锚点已对当前 main 核实

---

## 1. 架构增量

```text
dsh 插件（dsh-hardware-buddy/）
  src/
  ├── index.ts        # 不变（接线）
  ├── bridge.ts       # + completion_seq（turn/end 驱动）
  ├── cdc.ts          # 不变（写合并器已就绪）
  ├── approval.ts     # 不变
  ├── usage.ts        # 新增：配额 provider 接口 + DeepSeek 实现 + 轮询
  ├── persist.ts      # 新增：token/日期状态落盘（$DSH_HOME）
  ├── lock.ts         # 新增：串口实例锁（PID 文件）
  └── config.ts       # + 新配置项

firmware/src/
  ├── main.cpp        # FR8 品牌清理（btName 等）
  ├── clock_orient_logic.h  # FR9 冷启动竖屏回退（宏开关）
  └── （FR1/2/3/5/6/7 零固件改动）
```

**关键便宜**：FR2 提示音与 FR5 时间同步的设备侧能力**已存在**（一期核实）：

- 完成音效：固件 `completionChimeObserve(&state, tama.hasCompletionSeq, tama.completionSeq)`（main.cpp:2251-2257）——host 只需发**递增的 `completion_seq`**，固件自带去重
- 时间：`{"time":[epoch_sec, tz_offset_sec]}`（data.h:193 起解析，带 `epochInRange` 合法性校验）

---

## 2. 各功能实现落点

### FR2 完成提示音（最便宜，先做）

`bridge.ts` 状态加 `completionSeq: number`；监听 `session/event`：

```ts
if (type === 'turn/end') {
  const now = Date.now();
  if (now - this.state.lastChimeMs >= this.config.chimeMinIntervalMs) {
    this.state.completionSeq += 1;      // 心跳携带，固件 completionChimeObserve 去重
    this.state.lastChimeMs = now;
  }
}
```

flush() 输出 `completion_seq`。配置：`chimeEnabled`（默认 true）、`chimeMinIntervalMs`（默认 8000，合并并发 turn）。
注意信封归一化（`ev.data ?? ev`，一期教训）。

### FR3 token 持久化

`persist.ts`：

```ts
interface PersistedState {
  tokensTotal: number;
  dateKey: string;          // 'YYYY-MM-DD' 本地时区
  tokensToday: number;
  celebrateFiredDate: string;
}
```

- 路径：`join(dshHome(), 'hardware-buddy-state.json')`（`dshHome` 用 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`，或退回 `~/.dsh`）
- 读取：插件启动时；`dateKey` ≠ 今天 → `tokensToday=0`、celebrate 重置（自然日翻转）
- 写入：flush 定时器内 debounce（30s 且 tokens 有增量才写）；`writeFileSync` 到临时文件 + rename（原子）
- 损坏容错：JSON.parse 失败 → 重置为空状态 + warn（NFR-P2-3）
- 与 HMR：模块级单例 Map 按文件路径去重，避免热重载双写

### FR5 时间同步

`bridge.ts` flush 里低频附带（每 60s 或每 20 次心跳一次）：

```ts
if (now - this.state.lastTimeSentMs > 60_000) {
  hb.time = [Math.floor(Date.now() / 1000), -new Date().getTimezoneOffset() * 60];
  this.state.lastTimeSentMs = now;
}
```

设备端已有校验（data.h:193 `epochInRange`）与时钟面消费，零固件改动。USB 掉线期间时间不更新可接受（重连后 60s 内追上）。

### FR1 配额接入（依赖 P2-0 调研结论）

`usage.ts` provider 接口：

```ts
interface UsageProvider {
  poll(): Promise<HeartbeatUsage | null>;   // null = 本次失败，静默跳过
}
```

- DeepSeek 实现：P2-0 确定 endpoint 与鉴权（沿用 `DEEPSEEK_API_KEY`）；超时 5s
- 字段映射决策树：
  - 有滚动窗口限额 → `five_hour_remaining / seven_day_remaining`（现协议原样）
  - 仅余额 → `five_hour_remaining` 承载 `balance / initialBudget` 比例（`initialBudget` 配置项），文档标注 approximate
- 轮询：`setInterval(config.usageRefreshMs = 900_000)`，结果写入 bridge 状态，随心跳下发；失败保留上次值，连续 3 次失败后清空并 warn 一次
- 配置：`usageEnabled`（默认 false，调研通过后翻 true）、`usageRefreshMs`、`usageInitialBudget`

### FR6 多实例串口锁

`lock.ts`：

- 锁文件 `~/.dsh/hardware-buddy.lock`：内容 `{pid, port, ts}`
- `acquire(port)`：文件存在且 `pid` 存活（`process.kill(pid, 0)`）且 ts 在 10 分钟内 → 返回 false
- 拿不到锁：**一次性 warn**（"device held by pid X; hardware approval disabled, falling back to Web UI"）+ 不启动 CdcBridge 重连轮询（避免日志刷屏），每 60s 静默探测一次锁释放
- 进程退出 / ctx.effect 清理时释放；stale 锁（pid 不存活）直接接管

### FR7 serialNumber 消歧

`config.ts` + `cdc.ts discoverPort`：可选 `serialNumber` 精确匹配（serialport `PortInfo.serialNumber`，一期实测设备为 `14:C1:9F:D5:C9:40`）。

### FR8 品牌清理（固件 + 仓库）

| 落点 | 内容 |
|---|---|
| `main.cpp` btName（约 36-39 行）| `"Codex"` / `"Codex-%02X%02X"` → `"DSH-%02X%02X"`（BLE 名，默认禁用但一并清理）|
| 固件 UI/注释 | grep `Codex` 逐处清理（断连文案一期已改 "No DSH host"）|
| `README.md` / `firmware/REFERENCE.md` | 措辞更新，加一段"本项目由 CodeBuddy fork 演进而来"的溯源说明|
| Python host | **删除** `src/codex_buddy/`、`tests/`、`pyproject.toml` 的相关 entry；删除前 grep 仓库与 CI 确认无引用；README 记录演进 |

### FR9 冷启动竖屏回退（固件）

`clock_orient_logic.h`：

```cpp
// 新增：冷启动方向回退。上游设计在姿态模糊时不画"猜测帧"；长期平放
// （桌面场景）会让屏幕一直定格。超时后回退默认竖屏并记住，消除该体验问题。
#ifndef CODE_BUDDY_ORIENTATION_FALLBACK_MS
#define CODE_BUDDY_ORIENTATION_FALLBACK_MS 8000
#endif
```

在 `runtimeUpdateOrient()`/初次解析路径加：进入 auto-surface 时记录 `beginMs`；`millis() - beginMs > FALLBACK` 且未 resolved 且无 stableOrientation → `clockOrientRemember(state, 0)`（竖屏）。宏设为 0 可恢复上游严格行为。**注意**：与 IMU 解析的现有互斥逻辑集成时保持"一旦有真实姿态优先"。

### FR10 补验收 + HIL

- AC5：跑 web 任务 → 拔 USB（观察 `cdc disconnected` 日志 + 设备 30s 睡）→ 插回（5s 内 `OPEN ok` + 心跳恢复 + 全量快照）
- AC8：改 `~/.dsh/profiles/web/cordis.patch.yml` 的 `approvalTimeout`，dsh web 常驻下一条审批按新超时生效（HMR watch 对象即该文件）
- HIL 冒烟（`tools/hil_smoke.py`，复用一期 /tmp 测试脚本沉淀）：
  1. 模拟 host：心跳序列（idle→busy→prompt）→ 断言设备回显 `[prompt] show`
  2. 读设备串口等待人工/模拟按键 A → 断言 `{"decision":"once"}` 
  3. 输出 markdown 报告（通过/失败/耗时）
  - 人工触发为主，CI 自托管 runner 三期再接

---

## 3. 测试策略（增量）

|文件|新增用例|
|---|---|
|`tests/bridge.spec.ts`|turn/end → completion_seq 递增且间隔内合并；time 字段 60s 节流|
|`tests/persist.spec.ts`（新）|自然日翻转归零、损坏文件重置、debounce 写入|
|`tests/usage.spec.ts`（新）|provider 失败降级、字段映射决策、轮询不阻塞|
|`tests/lock.spec.ts`（新）|存活锁拒绝、stale 锁接管、释放|
|固件|BLE=0/BLE=1 双构建回归 + 方向回退宏两种配置编译|

## 4. 执行顺序与分包建议

```text
P2-0 调研（本地，0.5d）
  ├─ DeepSeek 余额/用量 API 试探（用现有 key，读官方文档 + curl）
  └─ web-app 浏览器侧扩展点（packages/web/web-app 插件机制、browser-purity 约束）

P2-1 体验包（可指派远程 codebuddy，插件纯 TS + 单测）
  FR2 chime → FR3 persist → FR5 time（互不依赖，可并行三人/三会话）

P2-2 健壮性包
  插件侧：FR6 lock + FR7 serialNumber（远程）
  固件侧：FR9 方向回退（远程，双构建验收本地）

P2-3 品牌包（远程，机械改动 + grep 自查清单）

P2-4 配额 + 补验收（本地，依赖调研结论 + 真机）
```

验收基线：每包合并前本地跑 `npm test`（全绿）+ 固件双构建 SUCCESS + 真机冒烟（web 起任务→审批 A/B）。

## 5. 关键锚点速查（已核实）

|内容|位置|
|---|---|
|固件完成音效观察器|`firmware/src/main.cpp:2251-2257`（`completionChimeObserve`）|
|心跳 `completion_seq` 解析|`firmware/src/data.h:285` 区域|
|`time:[epoch,tz]` 解析与校验|`firmware/src/data.h:193-249`|
|usage 字段解析|`firmware/src/usage_meter_json.h:11-12`|
|蓝牙名 Codex 残留|`firmware/src/main.cpp:36-39`（`btName`）|
|方向解析/防误画|`firmware/src/clock_orient_logic.h`（`clockOrientResolveInitialForStickS3`）|
|事件信封归一化（一期教训）|`dsh-hardware-buddy/src/bridge.ts`（`ev.data ?? ev`）|
|写合并器|`dsh-hardware-buddy/src/cdc.ts`（`WRITE_COALESCE_MS`）|
|设备序列号（serialNumber 用）|`14:C1:9F:D5:C9:40`（probe-report §1）|

## 6. 不要做的事

- 不修改 deepseek-harness / web-app 任何文件（FR4 冲突即降级）
- 不绕过写合并器直接 `port.write`（一期教训：背靠背写合并成乱码行）
- 不在 usage 轮询里做同步 IO（超时 + 异步，防心跳卡顿）
- 不删除 `ble_bridge.{cpp,h}`（保留 `#if` 可选路径）
- 固件改动必须双构建（BLE=0/1）回归
