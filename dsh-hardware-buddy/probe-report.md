# P0 探测报告（部分）— 真机实测数据

日期：2026-08-20 ｜ 环境：macOS（M 系列）、StickS3 × 1（USB-C 直连）

## 1. USB VID/PID（实测，`pio device list` + `system_profiler SPUSBDataType`）

|项|值|
|---|---|
|VID|`0x303A`（Espressif）|
|PID|`0x1001`（USB JTAG/serial debug unit，即 USB-Serial/JTAG 模式）|
|串口|`/dev/cu.usbmodem14401`（macOS）|
|序列号|`14:C1:9F:D5:C9:40`|

> 结论：`ARDUINO_USB_MODE=1`（USB-Serial/JTAG 外设）下 PID 为 **0x1001**。tech.md 早期版本（v1.1）声称的 0x4001 是 TinyUSB CDC 模式的 PID，不适用本配置。插件 `config.ts` 默认 `vendorId: '0x303A'` 有效；如需更精确可将 `productId` 默认值设为 `'0x1001'`。

## 2. 固件冒烟（P1 合并版 e516ce4，直接 esptool 刷写）

|检查|结果|
|---|---|
|CDC 枚举|✅ 刷写后立即枚举， VID/PID 同上|
|**无 BLE 构建 30s 回滚风险**|✅ 设备连续运行 >10 分钟无回滚（OTA/BLE 解耦生效）|
|心跳解析（host→device）|✅ `_applyJson` 全路径工作：`[data] snapshot total=.. running=.. waiting=.. prompt=.. msg=..` 逐字段回显|
|审批屏触发|✅ `prompt` 字段触发 `[prompt] show id=t-003 tool=Bash mode=0` + 蜂鸣 + 唤屏|
|token/usage 字段下发|✅ tokens/tokens_today 下发无解析错误|
|设备→host 串口日志通道|✅ 同口日志正常回传|
|idle→busy→attention→celebrate 状态切换|✅（屏幕侧，肉眼确认）|
|A 键 → `{"cmd":"permission",...,"decision":"once"}`|✅ 三次实证（t-004 / t-002 / t-005）；注意 A 键需**短按 <600ms**，长按是菜单键|
|B 键 → `{"cmd":"permission",...,"decision":"deny"}`|✅ 实证（t-005）；B 键在机身上边缘，非正面大键|
|shake → dizzy 日志|⏳ 未触发（窗口内无人摇动；代码路径与按键同源，风险低）|

## 3. dsh 真机集成（2026-08-20 补充）

环境：本机 deepseek-harness 源码仓（`node apps/cli/lib/bin.js`）、`headless` profile（`dsh plugin add` 本地 link 安装）、DEEPSEEK_API_KEY。

### 3.1 真实工具清单（25 个，来自 request/header 事件，全小写）

`bash` `create_goal` `edit` `exit_plan_mode` `get_goal` `glob` `grep` `interrupt_agent` `job_kill` `job_list` `job_output` `list_agents` `ralph` `read` `read_image` `send_message` `skill` `str_replace_editor` `subagent` `subagent_fork` `todo_write` `update_goal` `web_search` `workflow` `write`

**dangerousTools 默认值定稿**：`^bash$` `^write$` `^edit$` `^str_replace_editor$`（写入/执行类）。v1.1 文档预填的 `Bash/Edit/Write`（首字母大写）不会命中任何真实工具名。

### 3.2 集成中发现并修复的 bug

|bug|症状|修复|
|---|---|---|
|macOS `tty.`/`cu.` 陷阱|`SerialPort.list()` 返回 `/dev/tty.usbmodem*`；打开 tty.* 会永久等待 DCD，open 静默挂起|`withCuPath()`：darwin 上映射为 `/dev/cu.*`|
|open 竞态|`port.on('open')` 触发连接回调 → 立即 flush，但 `this.port` 在 `await open` 之后才赋值，首条心跳被 send() 静默丢弃|`this.port/parser` 赋值挪到 `port.open()` 之前|
|**token 计数恒为零**|live `session/event` 载荷带信封 `{type,seq,time,data}`，且 usage 只在 `assistant/chunk`（`chunk.type==='usage'`）上；原实现读 `assistant/message` 的 `ev.usage`（live 恒为空，落盘才有——单测用拆信封形状所以全绿）|归一化 `ev.data ?? ev`；usage 主通道改 chunk，message usage 留兜底；计数含 cache/reasoning 全量|
|**审批屏 3 秒即被冲掉（用户"只听到滴声看不到画面"的根因）**|固件把 `prompt` 字段缺失当"清除审批屏"（`data.h:346-352`）；插件只推一次 prompt，下一个 3s 全量心跳（无 prompt 字段）就把屏冲掉。协议是状态式的，pending prompt 必须每次心跳都带|prompt/waiting 进入心跳状态机（`setPendingPrompt`/`setPendingWaiting`），每次 flush 携带，settle 时清除|
|**设备 RX 大概率丢行（46 写仅 4 解析）**|ESP32 HWCDC 收发队列默认各 256B（`HWCDC.cpp:317`），心跳行 ~270B 超限即溢出丢失|固件 `Serial.setRxBufferSize(1024)` + `setTxBufferSize(1024)` 预置（须在 begin 前）；重烧后 1:1 解析|
|**背靠背写合并成乱码行（`json malformed len=367`）**|同 tick 内两次 flush（waiting + prompt）在设备 CDC RX 端被拼成一行、换行丢失|写合并器：60ms 窗口内只写"最新全量快照"（状态式协议保证安全性）|
|**dsh 进程事件循环冻结**|串口数据回调内的宿主 logger 调用可阻塞/抛出|logger 调用 try/catch 包裹（best-effort）|
|celebrate msg 永久驻留|`state.msg='milestone!'` 触发后从不清除，一直占设备状态栏|flush 发送一次后清空|
|插件日志不可见|dsh headless 抑制插件 logger 输出，info/warn 全部沉默|新增 `src/debug.ts`：`HB_DEBUG=1` 时 stderr 输出 CDC 生命周期追踪|

### 3.3 已验证（真实 dsh 进程内）

- 插件经 `dsh plugin add` 进入 profile 层栈，`--dump-config` 确认配置默认值生效（**dsh 源码零修改**）
- `apply()` 执行、VID/PID 发现（303a:1001）、串口打开
- **心跳双向闭环**：dsh 事件（`session/created` → total=1、`agent/status` → running=1）→ 插件心跳 → 设备解析 → 设备回显 `[data] snapshot total=1 running=1` → 插件接收
- 断连文案 `"No DSH host"` 在运行间隔超时后生效（回显中可见）
- `npm test` 35/35 保持全绿（修复后）

### 3.4 屏幕"定格"问题的结论（已定性，非缺陷）

现象：真机测试期间屏幕长期定格在睡眠宠物，蜂鸣正常、按键正常、内部状态正常。

定性：**上游 CodeBuddy 的防误画设计**（`clock_orient_logic.h` 注释原文："prevents a cold sideways surface from drawing a speculative portrait frame while its IMU settles"）。冷启动后若设备从未被拿起（IMU 姿态模糊且无 stable orientation），`autoSurfaceAwaitingOrientation` 为真 → 渲染挂起等待明确方向；一旦被竖持/横持一次，`hasStableOrientation` 记住方向（本次开机有效），之后即使平放也正常渲染。验证：竖持设备 + 心跳序列（idle→busy→celebrate→prompt）下屏幕随状态正常变化。

使用提示（写进 README 即可）：**开机后先把设备拿起来一下**，屏幕即激活。可选 Backlog：冷启动 N 秒后回退默认竖屏。

### 3.5 AC4 全链路验证通过（2026-08-20，deepseek-v4-flash）

任务："用 write 工具创建 /tmp/dsh_buddy_test.txt"。实际运行轨迹（串口留痕）：

```
[prompt] show id=call_00_KG9V2UPF... tool=write   ← 第 1 次审批（30s 无人按 → 超时 cancelled → dsh deny）
[prompt] show id=call_00_xGh1BDCP... tool=write   ← 模型重试，第 2 次审批（又超时）
[prompt] show id=call_00_mO9zzOnV... tool=write   ← 模型再重试
[prompt] approve id=call_00_mO9zzOnV...            ← 用户短按 A
{"cmd":"permission","id":"call_00_mO9z...","decision":"once"}   ← 设备回包
[data] snapshot ... waiting=0                     ← 审批解除
文件写入成功（hello from dsh），任务输出 done，exit 0
```

单轮覆盖：**AC3**（total/running/waiting 全程随真实事件流转）、**AC4**（物理审批闭环：pre-execute 命中 → 审批屏 → A 键 → once → allowed-once → 工具放行）、**AC7**（超时 → cancelled → dsh deny with reason → 模型自动重试，走了两遍）。

### 3.6 AC9 / AC13 / AC6 验证（2026-08-20 补充）

- **AC9 celebrate**：token 计数修复后，live 触发（usage chunk 全量计数 18K+ 过阈值）→ `msg=milestone!` 出现在设备回显心跳中，设备侧 token 升级庆祝动画由 `statsPollLevelUp()` 自触发
- **AC13 设备离线退位**：插件指向不存在端口模拟离线 → 0 次审批屏推送、无崩溃、优雅退位（next()），任务正常完成（模型收到拒绝后按指令汇报）
- **AC6 excluded 分流**：设备在线、`bash` 加入 excludedTools → **0 次** `[prompt] show`（硬件屏不出现），走 next() 放行给 Web UI/默认策略
- **B 键拒绝全链路**：各环节独立证实（设备 B→deny JSON t-005 实证；插件映射+runtime 行为有单测；同一 settle 管道在 cancelled 路径 live 跑过 4 次）；live 端到端组合因按键时机未捕获，留待日常使用自然完成（4 次尝试均为 30s/60s/180s 窗口超时）

### 3.7 遗留

- AC5 拔插重连、AC6 危险工具走 Web UI、AC8 HMR 配置热更：尚未做有针对性的人肉用例（机制已有单测覆盖）
- AC10 配额显示：stretch（数据源待定）
- 设备屏幕渲染（IMU 方向解析门控）问题独立跟踪中，不影响协议链路

## 4. 待完成 P0 项（需真实 dsh 环境）

- [ ] runtime probe（`probe.ts`）：事件 payload 样例留档
- [ ] 真实工具名清单 dump → 定稿 `dangerousTools` 默认正则
- [ ] `npm test` 在真实 dsh profile 中的插件加载验证（HMR / inject 行为）
