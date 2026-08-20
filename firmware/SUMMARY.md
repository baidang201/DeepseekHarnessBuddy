# Firmware P1 — BLE 编译期禁用 + OTA 解耦（交付物清单）

对照 `tech.md` §2.7 交付物清单逐项核对。分支 `feat/firmware-p1`，默认构建 `CODE_BUDDY_BLE_ENABLED=0`（无 BLE）。

> 行号说明：本仓库代码相对 tech.md §2.1-2.7 引用的行号有偏移，且本次改动本身也会改变后续行号；下表“行号”以**改动后当前文件**为准，并以改动点描述定位为主。

---

## §2.7 交付物清单核对

### ✅ `firmware/platformio.ini`
- 在既有 `build_flags` 中新增 `-DCODE_BUDDY_BLE_ENABLED=0`（位于 `-DCODE_BUDDY_OTA_ENABLED=1` 之后）。
- `lib_deps` 未改动（本仓库确无 NimBLE 依赖，BLE 走 Arduino core 自带 Bluedroid）。
- `ble_bridge.cpp` 的屏蔽采用 tech.md 允许的二选一方案之一：**在其内部整体包 `#if CODE_BUDDY_BLE_ENABLED ... #endif`**（见 `ble_bridge.cpp`），因此无 BLE 构建不产生任何 Bluedroid 符号，无需改 `src_filter`。

### ✅ `firmware/src/data.h`
- **删除 BLE ring drain 分支**：原 `while (bleAvailable()) { ... }` 整段（约 401-414 行）已删除。
- **保留** `_usbLine.feed(Serial, out, true)`（USB 行读取）与 `out->connected = dataConnected()`（30s 心跳窗口语义不变），以及断连清零分支。
- **断连文案** `"No Codex connected"` → `"No DSH host"`。
- **`bleConnected()` 调用点包 `#if`**（无 BLE 分支返回 false）：
  - `otaOfferAcceptBoundHint` 实参（约 168）— 保留为 `false`
  - `otaAuthorizationVerifyThenAccept` 实参（约 218）— 保留为 `false`
  - `_applyJson` 内 `otaOfferLifecyclePoll` 实参（约 351）— 保留为 `false`
  - `dataPoll` 内 `otaOfferLifecyclePoll` 实参 `out->connected && bleConnected()`（约 417）— **无 BLE 改为 `out->connected`**（USB 连接即视为就绪，避免把 USB-OTA 误判为未连接）。

### ✅ `firmware/src/main.cpp`
- **setup() BLE 段**：`startBt()` 内的 `bleInit(btName)` 包 `#if`（约 48）；boot-health 段的 `bleReady()/bleStartupFailed()` 包 `#if`（约 2135-2143），无 BLE 分支仅当 `otaBootReadyUsbDataSeen()` 为真时 `otaBootHealthReady(OTA_BOOT_READY_BLE)`，绝不触发 `otaBootHealthCriticalFailure(OTA_BOOT_REASON_BLE)`（即“未失败”处理），其余 OTA 启动判断逻辑不变。
- **loop 内 `bleReady()/bleStartupFailed()`**（约 2235-2240）：同上包 `#if`/`#else` 处理。
- **`sendCmd()`**（约 218）：删除两处 `bleWrite(...)`，仅保留 `Serial.println(json)`（USB CDC 唯一通道）。
- **factory reset 段 `bleClearBonds()`**（约 470）包 `#if`。
- 新增 `otaBootReadyUsbDataSeen()` 实现（`_lastLiveMs != 0` 即本开机收到过有效 JSON 行），供 OTA boot-health 在无 BLE 构建下作为就绪等效条件。
- 其余 BLE 引用（`blePasskey()`、`bleSecure()`、loop 内 `bleConnected()` 等）由 `ble_bridge.h` 桩在编译期接管（见下）。

### ✅ `firmware/src/ota_status.cpp` / `ota_update.cpp`
- `ota_status.cpp`：`bleWrite(...)` 调用（约 35）包 `#if`；`#include "ble_bridge.h"` 保留（桩头文件无 Bluedroid 依赖，安全）。
- `ota_update.cpp:765 / 820`：经核实为 **结构体字段** `inputs.bleConnected` / `pure.bleConnected` 的访问，**并非 `bleConnected()` 函数调用**，无需 `#if`；其取值来自 `main.cpp:2305` `otaInputs.bleConnected = bleConnected();`（无 BLE 构建下桩返回 `false`），语义正确。
- **额外修复（§2.4“隐藏大头”）**：`firmware/src/ota_update_logic.h:105` 的 OTA 执行门 `if (!in.bleConnected) return OTA_GATE_DISCONNECTED;` 包 `#if CODE_BUDDY_BLE_ENABLED`。无 BLE 构建下该 BLE 断连门被移除（offer 经 USB 到达，无 BLE 链路可要求），否则 `in.bleConnected` 恒为 `false` 会导致所有 OTA 执行被永久判为 `OTA_GATE_DISCONNECTED`，彻底阻断 USB-OTA。

### ✅ `firmware/src/ota_boot_health_logic.h`
- 新增 `uint8_t otaBootReadyUsbDataSeen(void);` 声明。
- 新增宏：
  ```cpp
  #if CODE_BUDDY_BLE_ENABLED
    #define OTA_BOOT_READY_BLE_REQ (OTA_BOOT_READY_BLE)
  #else
    #define OTA_BOOT_READY_BLE_REQ (otaBootReadyUsbDataSeen() ? (OTA_BOOT_READY_BLE) : 0)
  #endif
  ```
- 原 `constexpr uint8_t OTA_BOOT_READY_ALL` 改为运行时内联函数 `inline uint8_t otaBootReadyAllBits()`（因无 BLE 取值依赖运行时“是否收到 USB 数据行”，不能再是编译期常量）；其位定义中用 `OTA_BOOT_READY_BLE_REQ` 替换原 `OTA_BOOT_READY_BLE`。BLE=1 时位掩码与原 `OTA_BOOT_READY_ALL` 逐位相同；无 BLE 时仅当本开机收到过有效 USB 数据行才含 BLE 就绪位。两处使用点（`otaBootHealthSignal`、`otaBootHealthNextAction`）同步改为调用 `otaBootReadyAllBits()`。

### ✅ `firmware/src/xfer.h`
- `unpair` 命令处理中的 `bleClearBonds()`（约 109）包 `#if CODE_BUDDY_BLE_ENABLED`。
- 同文件内其余 `bleWrite`/`bleSecure` 调用由 `ble_bridge.h` 桩接管。

### ✅ `firmware/src/ble_bridge.{cpp,h}`
- **未删除**，保留为可选源。
- `ble_bridge.h`：声明整体包 `#if CODE_BUDDY_BLE_ENABLED`；`#else` 分支提供一组 **编译期内联桩**（`bleInit`/`bleReady`/`bleStartupFailed`/`bleConnected`/`bleSecure`/`blePasskey`/`bleClearBonds`/`bleAvailable`/`bleRead`/`bleWrite`），使所有调用点在无 BLE 构建下仍能编译、链接，且不引入任何 Bluedroid 符号。桩语义：就绪类返回“已就绪/未失败”，连接类返回 `false`/`0`。
- `ble_bridge.cpp`：整个翻译单元包 `#if CODE_BUDDY_BLE_ENABLED ... #endif`，无 BLE 构建下编译为空，确保 Bluedroid 链接符号不进二进制。

### ✅ `firmware/scripts/inject-ota-trust.py` / `verify-ota-rollback-symbol.py`
- **未修改**（按要求保持不动）。

---

## OTA_BOOT_READY_BLE_REQ 最终实现方式

目标：无 BLE 构建下，新镜像的 30s 开机健康确认不再硬依赖 BLE，避免“永不确认→自动回滚”。

实现要点（耦合最小方案，函数实现放在 `main.cpp`，声明放在 `ota_boot_health_logic.h`）：

1. **就绪等效条件** = “本开机收到过任一有效 JSON 行”，即 `data.h` 的 `_lastLiveMs != 0` 语义。`main.cpp` 中定义 `uint8_t otaBootReadyUsbDataSeen(void) { return _lastLiveMs != 0 ? 1 : 0; }`（`_lastLiveMs` 在 `dataPoll`/`_applyJson` 处理到合法数据行时更新）。
2. **宏替换位**：`OTA_BOOT_READY_BLE_REQ` 在 BLE 构建下等于 `OTA_BOOT_READY_BLE`（原必需位），无 BLE 下等于 `(otaBootReadyUsbDataSeen() ? OTA_BOOT_READY_BLE : 0)`。
3. **就绪位集合** 由 `constexpr OTA_BOOT_READY_ALL` 改为运行时函数 `otaBootReadyAllBits()`（因为无 BLE 取值依赖运行时条件，无法保留为编译期常量）。无 BLE 时：
   - 若本开机收到过 USB 数据行 → 掩码含 BLE 就绪位 → `otaBootHealthReady(OTA_BOOT_READY_BLE)` 可将其置位 → 满足确认条件；
   - 若未收到 → 掩码不含该位 → 该位不再被要求 → 同样不会因缺失而回滚。
4. **boot-health 调用点**（`main.cpp` setup + loop）在无 BLE 下改为：`if (otaBootReadyUsbDataSeen()) otaBootHealthReady(OTA_BOOT_READY_BLE);`，绝不调用 `otaBootHealthCriticalFailure(OTA_BOOT_REASON_BLE)`，与“未失败”语义一致，且不改动 OTA 信任链/回滚监督的其余逻辑。

---

## 两种构建的正确性保证

- **BLE=1（`-DCODE_BUDDY_BLE_ENABLED=1`）**：所有 `#if` 分支走真实调用，`ble_bridge.cpp` 编译真实实现，`OTA_BOOT_READY_BLE_REQ == OTA_BOOT_READY_BLE`、`otaBootReadyAllBits()` 位掩码与原 `OTA_BOOT_READY_ALL` 完全一致，**行为与改动前逐位相同，未删除任何函数体或文件内容**。
- **BLE=0（默认）**：`ble_bridge.cpp` 编译为空；全部 BLE 符号引用由 `ble_bridge.h` 内联桩接管（或在 `data.h`/`main.cpp`/`ota_update_logic.h`/`xfer.h`/`ota_status.cpp` 中显式 `#if` 跳过）；`OTA_BOOT_READY_BLE_REQ` 以 USB 数据行为等效就绪条件。**无 BLE 符号进入二进制，且 USB-OTA 可正常执行与确认（不回滚）。**

## `#if`/`#endif` 配对
所有新增 `#if` 均有对应 `#endif`（位于 `ble_bridge.h` 声明块、`ble_bridge.cpp` 整文件、`data.h` 4 处、`main.cpp` 4 处、`ota_status.cpp` 1 处、`xfer.h` 1 处、`ota_update_logic.h` 1 处、`ota_boot_health_logic.h` 1 处）。被屏蔽代码内部的宏引用不参与编译，无需额外修改。
