# gesture_recognizer — 算法要点 / 测试矩阵 / 已知局限

> 对应代码：`firmware/src/gesture_recognizer.h`、`firmware/tests_native/test_gesture.cpp`
> 配套规范：`prd-p2.md` FR3、`tech-p2.md` §4
> 测试命令：`g++ -std=c++17 -I firmware/src firmware/tests_native/test_gesture.cpp -o /tmp/test_gesture && /tmp/test_gesture`

---

## 1. 接口（仅纯算法，零硬件依赖）

```cpp
enum class Gesture : uint8_t { None, Circle, Cross };
struct GesturePoint { float x, y; uint32_t tMs; };

// 主入口：一段去重力后的轨迹点列（x/y 单位 g，tMs 可选用于插值）。
Gesture gestureClassify(const GesturePoint* pts, size_t n);

// 辅助：等弧长重采样到 32 点（用于行为诊断 / 复用）。
size_t gestureResample(const GesturePoint* in, size_t n,
                       GesturePoint* out, size_t outN);
```

- 不 include 任何 `<Arduino.h>` / `M5*.h` / `<vector>`，仅 `<stddef.h>` `<stdint.h>`，
  math 用 `__builtin_*`（host 测试可通过 `GR_USE_LIBC_MATH` 切到 `<cmath>`）。
- 所有可调阈值集中在顶部 `namespace gesture_cfg { ... }`，调参只改那一块。
- `inline` 头文件实现，可单独编译 `gesture_recognizer.cpp` 链接（仅偏好问题）。

## 2. 算法流程

```
gestureClassify(pts, n)
├── precheck
│   • 至少 kMinRawPoints (=8) 个点
│   • 总路径长 ≥ kMinPathLenG (=0.40 g)
│   • 包围盒直径 ≥ kMinBoundingDiamG (=0.20 g)
├── gestureResample -> 32 点等弧长
├── 分支 A — Circle
│   • 最小二乘代数圆拟合（Kasa 法，3×3 法方程组）
│   • 半径 ∈ [0.30, 1.20] g  （tech-p2.md §4）
│   • 闭合度 1 - |first-last|/diam ≥ 0.70  （spec >70%）
│   • 长短轴比（特征值）≥ 0.55  ← 拒绝细长蛋形
│   • 圆周平均残差 / 半径 ≤ 0.35
│   └ 任一不满足 → 不判 Circle
└── 分支 B — Cross
    • 在 32 个 resample 点上用相邻切线夹角找最大跳变作为 corner
    • corner 切线翻转 1-cos ≥ 0.50（即 ≥ ~60° 角变）
    • corner 索引在 [25%, 75%] 路径中段
    • 两段各自做主成分（PCA）拟合得方向与长度
    • 把每段方向按"起点 → 终点"重新对齐（消除 PCA 符号歧义）
    • 两段长度比 max/min ∈ [1.00, 1.60]  （spec 0.6~1.6 的
      max/min 解读 —— 严格长度比超出此区间拒绝）
    • 任意一段长度 < 0.25 g → 拒绝（防"第二笔只是回弹"）
    • 两段夹角 ∈ [90°, 160°]（tech-p2.md §4），sin ≥ 0.18 防近共线
    • 两段直线残差 / 段长 ≤ 0.30
    • 两条直线求交点；交点必须落在云质心 ± (0.5·diam+0.1) 的松弛包围盒内
    └ 任一不满足 → 不判 Cross
最终：Circle 不通过 + Cross 不通过 → None。
```

**关键设计取舍**

- **Circle 优先于 Cross**：先试 Circle，若满足则直接返回；否则才进 Cross。
  这避免"完美圆"被错误判成 X。
- **PCA 方向对齐**：原始主成分符号任意；用"段起点 → 段终点"做参考翻转，
  否则两条直线的相对方向可能在 ±180° 之间漂移导致夹角算错。
- **不做闭合度约束给 X 形状**：X 的头尾距离很可能接近包围直径（两笔各
  从一端画到另一端），所以用"两线交点近质心"代替头尾闭合度来验证
  "两条线真的在中间交叉"。
- **宁可漏识别**：每个分支不满足任一硬阈值即返回 None（tech-p2.md §8）。
  这避免误审批 — 设备上真实画 X 也允许重画。

## 3. 参数取值理由

| 参数 | 值 | 选择理由 |
|---|---|---|
| `kWindowMs = 800` | 800ms | tech-p2.md §4 明确写 800ms 滑窗；调用方负责按 tMs 切片 |
| `kResampleN = 32` | 32 点 | tech-p2.md §4 明确写 32 点；足够平滑又便宜 |
| `kMinRawPoints = 8` | 8 点 | 800ms/100Hz = 8 点，少于这个采样窗口不可信 |
| `kMinPathLenG = 0.40` | 0.40 g | 阈值 < 0.5 半径的圆周长 → 不允许太小的"圆" |
| `kMinBoundingDiamG = 0.20` | 0.20 g | 防止手指轻微抖动被当作动作 |
| `kCircleClosureMin = 0.70` | 0.70 | spec 原值 |
| `kCircleRadiusMinG/MaxG = 0.30/1.20` | spec 区间 | tech-p2.md §4 原值 |
| `kCircleAspectMin = 0.55` | 0.55 | 让椭圆长短轴比 ≥ 0.55，否则易把"细长摆动"误判 |
| `kCircleResidualRelMax = 0.35` | 0.35 | 抖动允许 ~35% 半径的偏离 |
| `kCrossLenRatioMin/Max = 1.00/1.60` | max/min | spec 写"长度比 0.6~1.6"，短/长 范围等价于 max/min ∈ [1, 1.6] |
| `kCrossAngleMinDeg/MaxDeg = 90/160` | spec | tech-p2.md §4 原值 |
| `kCrossMinSegLenG = 0.25` | 0.25 g | 短于 0.25g 的笔触更像"勾尾巴" |
| `kCrossCornerFracMin/Max = 0.25/0.75` | 中段 | 防止把第一笔的小回头当成 X |
| `kCrossCornerJumpMin = 0.50` | 1-cos ≥ 0.5 | ≈ 60° 切线翻转 — 真 X 的 corner 处 |
| `kCrossCollinearTol = 0.18` | sin ≥ 0.18 | ≈ 10° 最小夹角，避开"几乎共线的 V" |
| `kCrossSegResidualRelMax = 0.30` | 30% 残差/段长 | 真笔触允许 30% 抖动 |
| `kMaxRawPoints = 96` | 96 点 | 等弧长段长缓冲的固定上限；典型 800ms/100Hz ≈ 80 点 |

> 头文件内全部 constexpr，编译期可被 const-fold / 内联，运行时无开销。

## 4. 测试矩阵与结果

宿主测试 `firmware/tests_native/test_gesture.cpp` 自跑通过（截至交付时 5/5 稳定 PASS）。

| 用例族 | 用例数 | 结果 | 说明 |
|---|---:|---|---|
| 正圆（顺/逆时针，r=0.4~1.1） | 20 | 20/20 Circle | 干净圆 |
| 椭圆（aspect 0.75~1.0） | 15 | 15/15 Circle | 接近圆也算 |
| 噪声圆（±15% 抖动） | 15 | 15/15 Circle | 模拟手抖 |
| **Circle 家族小计** | **50** | **50/50 (100%)** | spec 要求 ≥90% ✓ |
| X 100°×ratio{1.0,1.3,1.55} × 5 reps | 15 | 15/15 Cross | |
| X 130°×ratio{1.0,1.3,1.55} × 5 reps | 15 | 15/15 Cross | |
| X 150°×ratio{1.0,1.3,1.55} × 5 reps | 15 | 15/15 Cross | |
| **Cross 家族小计** | **45** | **45/45 (100%)** | spec 要求 ≥90% ✓ |
| 任意方向直线 ×10 | 10 | 0 误判 | |
| 静止抖动 (amp 0.02g) ×10 | 10 | 0 误判 | |
| 静止抖动 (amp 0.10g) ×10 | 10 | 0 误判 | |
| 随机游走 (step 0.04g) ×10 | 10 | 0 误判 | |
| V/U 型超调笔触 ×5 | 5 | 0 误判 | |
| 不足点数 / nullptr / 极小圆 ×4 | 4 | 0 误判 | |
| **退化家族小计** | **48** | **48/48 (0 误判)** | spec 要求 0 误判 ✓ |
| 重采样首尾钉住验证 | 2 | 2/2 PASS | |
| **合计** | **145** | **全绿** | |

### 4.1 编译运行命令（PRD §交付物原样）

```bash
g++ -std=c++17 -I firmware/src firmware/tests_native/test_gesture.cpp \
    -o /tmp/test_gesture && /tmp/test_gesture
```

非零退出码表示失败；当前 PASS → 退出 0。

### 4.2 自证纯算法（不依赖平台）

```bash
g++ -fsyntax-only -std=c++17 -I firmware/src firmware/src/gesture_recognizer.h
```

无 error，无 include 任何 M5 / Arduino / 平台头。

## 5. 已知局限 / 真实使用可能漏识别

下列情况算法**会返回 None**（不会误判），需要真实用户复测验收：

| 场景 | 算法反应 | 备注 |
|---|---|---|
| 圆非常椭圆（长短轴比 < 0.55） | None | spec 没要求支持细长椭圆 |
| X 的两笔夹角 < 90°（如 "√"） | None | spec 明确 90°~160° |
| X 的两笔夹角 > 160°（接近直线回拉） | None | 易与直线混淆；规范上限 |
| 两笔长度差 > 60% | None | max/min 上限 1.6 硬卡 |
| 半径 < 0.30g 或 > 1.20g | None | spec 区间外（不在 IMU 标定区） |
| 圆心方向偏置（az ≠ 0） | 可能漏识别 | header 只接受 x/y 去重力值，z 轴姿态抑制在 main.cpp 端做（不在本算法职责） |
| 静止平放桌面 | None | 路径长与包围盒都过小，必然 None |
| 600ms 内画完 | None | raw points 不足 8 个（按 100Hz 估算） |
| 设备高速运动超过 1.2g | None | spec 范围外；调用方需要更宽的事件分类 |
| 极快画圆（< 200ms） | 可能 None | 32 点重采样下采样过稀；窗口策略留 main.cpp 处理 |

> **设计原则**：按 `tech-p2.md §8` "宁可漏识别不可误审批"，阈值都偏紧，
> 真机验收阶段可以放开一个或两个参数以提升召回，但需保留防误触底线。

## 6. 接线责任（给 main.cpp 端的提醒）

- 本模块**不做**重力去除、滑动窗口、姿态检测、防误触门控。这些归
  main.cpp / `gesturePoll(...)` 适配层负责（参考 `tech-p2.md §4.2`）。
- 推荐数据流：loop 里读 `M5.Imu.getAccelData()` → 去重力 → 按 tMs 切
  800ms 滑窗 → 攒够 8 点就调 `gestureClassify`。
- 命中 Circle / Cross 后，main.cpp 走与 A/B 键**等价**的审批路径
  （`tech-p2.md §4.2` 强调 "手势与按键完全等价"）。
- 1.5s 锁定防重入 + 平放抑制（`|az| < 0.9g` 或静止）放 main.cpp 端，
  不在本算法内。

## 7. 调参入口

`namespace gesture_cfg` 块即唯一调参点。`grep -n 'k' firmware/src/gesture_recognizer.h` 可一键列出所有常量；改值后用 §4 命令重跑测试即可验证。
