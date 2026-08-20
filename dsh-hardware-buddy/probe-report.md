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

## 3. 待完成 P0 项（需真实 dsh 环境）

- [ ] runtime probe（`probe.ts`）：事件 payload 样例留档
- [ ] 真实工具名清单 dump → 定稿 `dangerousTools` 默认正则
- [ ] `npm test` 在真实 dsh profile 中的插件加载验证（HMR / inject 行为）
