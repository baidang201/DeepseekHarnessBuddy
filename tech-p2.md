# 🏗️ 第二期技术方案｜「程序员鼓励师」改造

> **文档版本**：v2.1（配套 `prd-p2.md`），按用户产品愿景重写
> **架构不变**：USB CDC + dsh 插件 + 固件，deepseek-harness 源码零修改
> **现状锚点（已核实）**：音频 `M5.Speaker.tone()`（beep, main.cpp:207）可用即扬声器在线；角色系统 `characters/bufo/`（manifest.json + 每态 GIF + 多帧 idle）现成；IMU `M5.Imu.getAccelData`（checkShake, main.cpp:1517 同源）现成

---

## 1. 模块增量总览

```text
firmware/
├── src/
│   ├── audio_clips.h/.cpp        # 新增：WAV 装载 + 播放调度（M5.Speaker.playRAW）
│   ├── gesture_recognizer.h/.cpp # 新增：画圆/画X 识别（800ms 滑窗）
│   ├── main.cpp                  # 改：审批路径接语音与手势；error_seq 解析
│   └── data.h                    # 改：+error_seq 字段（一行解析）
├── characters/encourager/        # 新增：二次元角色包（manifest + 七态 GIF）
└── assets/audio/                 # 新增：5 条 WAV 源文件（构建期打包）

dsh-hardware-buddy/src/
└── bridge.ts                     # 改：turn/end → completion_seq；tool/result.error → error_seq
```

---

## 2. FR1 语音包

### 2.1 资产规格

- 5 条 WAV：`approve/deny/error/idle_1/idle_2/boot`（文案见 PRD §3）
- 16kHz / 16bit / 单声道 PCM，每条 1~3s，总预算 ≤ 500KB
- 生成管线：任意 TTS/配音工具产 WAV → `ffmpeg -ar 16000 -ac 1 -sample_fmt s16` 归一 → `tools/wav_to_header.py` 转 C 数组（或 LittleFS 打包，P2-0 定，与 bufo GIF 装载机制对齐）

### 2.2 固件播放管线（`audio_clips.cpp`）

```cpp
enum class Clip : uint8_t { Approve, Deny, Error, Idle1, Idle2, Boot };

// M5.Speaker 异步 RAW 播放；单通道互斥（新clip打断旧的）
void playClip(Clip c);
bool clipPlaying();
```

- `M5.Speaker.playRAW(pcm, len, 16000)`（M5Unified 现成 API；beep 已证明 Speaker 在线）
- 音量：`M5.Speaker.setVolume(volume)`，上限 192/255（≈75%），设置菜单可调（沿用现有 settings 存储）

### 2.3 触发点接线（main.cpp）

| 触发 | 现行为 | 二期行为 |
|---|---|---|
| 审批放行（A 键/画圆）| `beep(2400,60)` | `playClip(Approve)`（beep 保留为静音回退）|
| 审批拒绝（B 键/画X）| `beep(600,60)` | `playClip(Deny)` |
| 工具报错 | 无 | `playClip(Error)`（由 `error_seq` 递增驱动，见 2.4）|
| turn 完成 | `playCompletionSound()` | 保留轻音（不语音，避免吵）|
| 待机偶发 | 无 | idle 态每 20~40 分钟随机 `playClip(Idle1/2)`（可关）|
| 开机 | 无 | `playClip(Boot)` |

### 2.4 error 联动协议小扩展

与 `completion_seq` 同模式（设备端已有等价消费路径可仿写）：

- 插件 `bridge.ts`：`session/event` 归一化后 `type === 'tool/result'` 且 `ev.error` 存在 → `state.errorSeq += 1`，随心跳携带
- 固件 `data.h`：`+error_seq` 解析（照抄 `completion_seq` 的 has/seq 双字段模式）；
  `main.cpp` loop：`errorSeqObserve(...)` 递增即 `playClip(Error)` + 角色切报错鼓励动画（复用 one-shot 机制，如 dizzy 的 `triggerOneShot`）

## 3. FR2 二次元角色包

### 3.1 复用现有系统（零固件新代码）

`characters/bufo/manifest.json` 结构：`{name, colors{body,bg,text,textDim,ink}, states{sleep, idle[], busy, attention, dizzy, celebrate, heart}}`。新角色同构：

```text
characters/encourager/
├── manifest.json     # name: encourager；配色按素材调整
├── sleep.gif  idle_0..7.gif  busy.gif  attention.gif
├── dizzy.gif  celebrate.gif  heart.gif
└── README.md
```

- P2-0 摸底 bufo 的 GIF 尺寸/帧数/总体积作为预算基线（当前单文件 10~137KB，总包内含）
- 角色切换走现有设置菜单；ASCII 18 宠物不受影响
- **素材生产管线（长杆，可远程/并行）**：AI 生图（每态关键帧）→ 抖动/调色板适配（屏幕 135×240 ST7789）→ 合成 ≤8 帧 GIF → 体积压缩到预算内；先用简笔占位风格跑通全链，精美化迭代

## 4. FR3 手势审批（画圆 = 同意，画 X = 拒绝）

### 4.1 新模块 `gesture_recognizer.{h,cpp}`

```cpp
enum class Gesture : uint8_t { None, Circle, Cross };

// 每 loop 调用（仅门控开启时内部采样）
Gesture gesturePoll(uint32_t now);
```

**采样与预处理**：
- 800ms 滑动窗口，每 loop 读 `M5.Imu.getAccelData`（与 checkShake 同源；P2-0 确认 `getGyroData` 可用性，可用则 Z 轴角速度积分增强）
- XY 去重力：减滑动基线（同 checkShake 的 EMA 思路），得到运动轨迹点列
- 重采样至 32 点（等弧长）

**画圆判定**：
- 最小二乘拟合圆心/半径；闭合度 = |首尾距离| / 轨迹直径 > 70% 视为闭合
- 半径落 0.3g~1.2g 等效区间（排除抖动与夸张大幅度）；方向不限

**画 X 判定**：
- 轨迹分两段直线（转折点检测：方向角突变）；两段夹角 90°~160°、长度比 0.6~1.6、交点近中心

### 4.2 防误触门控（main.cpp 接线）

```cpp
// 仅当审批悬挂时识别；平放抑制；识别后锁定
if (inPrompt && !gestureLockUntil && postureHeldNotFlat()) {
  switch (gesturePoll(now)) {
    case Gesture::Circle: gestureLockUntil = now + 1500;
                          /* 走 A 键同一路径：sendCmd(permission once) + celebrate + playClip(Approve) */ break;
    case Gesture::Cross:  gestureLockUntil = now + 1500;
                          /* 走 B 键同一路径：sendCmd(permission deny) + playClip(Deny) */ break;
    default: break; // 识别中可触发 dizzy 视觉
  }
}
```

- `postureHeldNotFlat()`：`|az| < 0.9g` 或角速度活跃才认为"握持中"（平放 az≈1g 且静止 → 抑制）
- 复用 A/B 按键的既有发送与动画路径（**手势与按键完全等价**，AC-P2-6 的实现基础）
- 参数（窗口、闭合度、半径带、锁定时长）集中成 `gesture_config.h` 常量，便于调参迭代识别率

### 4.3 识别率迭代计划（AC-P2-4/5）

- 每轮：20×画圆 + 20×画X + 5 分钟平放，记录识别/误触矩阵 → 调参数 → 复测
- 达标线 ≥85% 识别、0 平放误触；不达标则参数放宽/收紧分径调

## 5. B 线小件（锚点已核实，直接实现）

|项|落点|
|---|---|
|FR4 完成提示音|`bridge.ts`：`turn/end` → `state.completionSeq += 1`（间隔 8s 合并）；flush 携带；固件 `completionChimeObserve`（main.cpp:2251）已就绪，零固件改动|
|FR5 时间同步|`bridge.ts` flush 低频附带 `time:[epoch, tz]`（60s 一次）；设备解析与校验已存在（data.h:193-249）|
|FR6a 多实例锁|新 `lock.ts`：`~/.dsh/hardware-buddy.lock`（pid+ts）；拿不到锁→一次性提示并静默退位（审批走 Web UI）；stale 锁接管|
|FR6b 品牌清理|`main.cpp` btName `Codex-*`（约 36-39 行）→ `DSH-*`；grep 全仓 Codex 文案；README 溯源说明；Python 旧 host 删除归档|

## 6. 测试策略

|层|用例|
|---|---|
|插件单测（vitest）|completion_seq 生成/间隔合并、error_seq 递增、time 节流、信封归一化回归（一期教训）、锁竞争|
|固件|BLE=0/1 双构建回归；gesture_config 两组参数编译；音频头文件体积预算检查脚本|
|真机验收|PRD §5 八条 AC；手势按 §4.3 矩阵法；语音逐条实播|
|回归|一期能力全回归（A/B 键、状态镜像、拔插回落、超时）|

## 7. 执行顺序与分包建议

```text
P2-0（本地 0.5d）：playRAW 试播一条 WAV；bufo 打包机制/资产规格摸底；getGyroData 可用性
P2-1 语音包（2d）：固件管线本地做；WAV 素材生成可指派远程（TTS 工具 + 规格脚本）
P2-2 角色包（2d）：manifest/装载本地验证；GIF 素材生成远程/用户自备（最大变数）
P2-3 手势（2.5d）：gesture_recognizer 模块可指派远程（纯算法 + 单测模拟轨迹）；
                    真机调参必须本地（需要手感）
P2-4 联调 + B 线（1.5d）
```

验收口径：每包合并前 `npm test` 全绿 + 固件双构建 SUCCESS + 真机冒烟（审批 A/B/手势三路等价）。

## 8. 不要做的事

- 不做实时 TTS（预生成 WAV 是硬边界）
- 不修改 deepseek-harness / web-app 任何文件
- 不绕过写合并器直接 `port.write`（一期教训）
- 不删除 `ble_bridge.{cpp,h}` 与 ASCII 宠物（回退完备性，NFR5）
- 手势识别失败时**不猜测**（None 就是无动作），宁可漏识别不可误审批
