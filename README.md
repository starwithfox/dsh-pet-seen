# dsh-pet-bridge

DSH 插件：把 Harness 的任务状态推给本机桌宠，并把"**用户确实看到了这次完成**"
回传给 Harness，从而做到「看到即取消提示」。

这是桌宠项目的 "DSH 侧一半"。另一半（桌宠接收端）在 `pet.py`，按本文协议对接。

> 设计依据与取舍：仓库根目录 `DESIGN-dsh-pet-plugin.md`。
> **下面所有 `working-docs/…` 路径都只在开发者的本地 checkout 里存在**——`working-docs/` 与 `archive/`
> 不随仓库发布；引用它们是为了给出可核对的记录位置，正文结论已在本文写全。
> **当前状态与下一步：`working-docs/STATUS.md`（唯一入口）**——一眼看清"探到哪了、还差什么、按什么顺序做"。
> 成熟度评估与安装/分发建议：`working-docs/PLUGIN-MATURITY.md`（平台层"谁有权装"、项目层可分发清单、
> 运维层共存与生效语义；含一条新增发现：宿主兼容性闸门因未声明 `@deepseek-ai/dsh*` peer 而**空转**）。
> 过程文档保存在 `working-docs/`，旧轮次记录保存在 `archive/`。
> 桌面端（Electron 应用）实测：`working-docs/DESKTOP-PROBE-2026-09-30.md`（权威记录）与
> `working-docs/DESKTOP-COMPAT-FINDINGS.md`（已冻结的历史证据）。要点：桌面应用 boot 的是
> **`desktop` profile**，**不共享** `web` profile 的 `node_modules`（`DESKTOP-COMPAT-FINDINGS.md` §1
> 记录的"`:19387` 上 `/pet-bridge/*` 为 `404`"是**安装前**的状态；现插件已装入 `desktop` profile）；
> 两个宿主会抢控制端口，**同一时刻只跑一个**（该文档 §4）。
> 桌面容器把页面 origin 改成 `dsh-app://app` 并在转发时剥掉 `Origin`；**实测那条转发是通的**
> （桌面渲染进程内 `POST /pet-bridge/visibility` 全程 `200`），所以浏览器半边**不是**因容器而失效。
> **"要真正支持桌面端该怎么做"已实测出结论**：宿主侧全通，但页面侧 L3 在 **0.2.0-rc.2 上必然失效**——
> 0.2.0 从 `sessions.list` 快照里删掉了 `current`（0.1.5-rc.2 有），客户端因此永远拿不到当前会话，
> **连一次 `GET /pet-bridge/notices` 都不会发**，也就永远不会 `/seen`、永远不撤销桌宠提示。
> **它不是桌面端独有的问题**：`:19387` 对外提供的那份前端同样没有该字段，普通浏览器打开会一样失效。
> 见 `working-docs/DESKTOP-PROBE-2026-09-30.md` §3.3、§6.1。
> **修复设计与双支持决策已出**（仍**未实施**）：`working-docs/FIX-DESIGN-SESSION-CURRENT-2026-09-30.md`
> ——首选读法改为 `uiSession.adapter.current`（0.1.5/0.2.0 都有且同形，一条路径双支持），
> 支持范围建议 `"^0.1.5-rc.2 || ^0.2.0-rc.2"`；判据是 `/pet-bridge/notices` 请求次数 > 0 且 `seenAt` 被写入。
> 因此**在修复落地前`README` 描述的能力在 0.2.0 宿主上不成立**；状态与顺序见 `working-docs/STATUS.md`。

---

## 1. 为什么需要它

现有桌宠（`harness_status.py`）是**只读**的：扫描 `~/.dsh/sessions/**`，挑 mtime 最新的
会话，解压取最后一条 `todo/write`。三个硬伤：

1. **不知道用户在看哪个会话**——多任务并行时必然显示错的那个。
2. **延迟**——轮询 + 全量解压。
3. **单向**——桌宠无法告诉 DSH 任何事，"已读"永远回不去。

本插件改为**推送**：宿主侧按 `sessionId` 分桶，桌宠从"猜"改为"收"。

### "看到即取消"到底难在哪

参考实现（`hotpot-labs/dsh-notifier-plugin`）只用两条件判定前台：

```ts
document.visibilityState === 'visible' && document.hasFocus()
```

多任务并行时这会**静默吞掉**提示：用户正盯着会话 A，会话 B 跑完了。
此时标签页可见、窗口有焦点，判定成立，B 的提示被当成"用户已看到"而不弹——
用户永远不知道 B 完成了。这是本插件存在的第一个理由。

所以判定分三级，只有第三级才算数：

| 级别 | 信号 | 含义 | 误判 |
| --- | --- | --- | --- |
| L1 | `visibilityState === 'visible'` | 标签页在前台 | 可见≠在看 |
| L2 | L1 且 `hasFocus()` | 窗口有焦点 | 参考实现停在这里 |
| L3 | L2 且**本次完成结果自己的 DOM 行**进入对话滚动容器视口，连续停留 ≥ `seenDwellMs` | 用户有机会看到这次结果 | 仍无法证明真的读了 |

**L2 在本插件里只是遥测**，永远不能取消提示。只有 L3 能，且宿主还要再核对一次。

---

## 2. 结构

```
DSH 宿主进程 (node)
├── dsh-pet-bridge 宿主侧
│   ├── 订阅 session/event  → 对话事件流（turn/start, tool/call, turn/end …）
│   ├── 订阅 agent/status   → 运行生命周期（running ⇄ idle）★ 运行结束信号
│   ├── 控制服务 127.0.0.1:17323  ← 桌宠的 /hello /state /ack
│   ├── 向桌宠 127.0.0.1:<petPort> POST /event
│   └── 挂浏览器路由（可选，仅在 DSH WebServer 存在时）
└── DSH WebServer
    └── /pet-bridge/visibility | /notices | /seen   ← 同源，浏览器侧调用
```

### 为什么运行结束看 `agent/status` 而不是 `turn/end`

`turn/end` **不结束一次运行**：goal 续跑、排队追问、多轮继续都会立刻开下一个 turn。
所以 `turn/end` 只被*记录*，真正的结束信号是 `agent/status` 变为 `idle`：

```
turn/end(completed) ──记录 reason──┐
                                   ├─→ 到 idle 才消费，生成一条 Notice
agent/status: idle ───────────────┘
```

两者来源不同、**顺序无保证**：`idle` 可能先于 `turn/end` 到达。
所以 idle 到手但还没记到 reason 时，会挂一个 `idleGraceMs` 宽限窗口等迟到的 `turn/end`，
而不是立刻丢弃。宽限期内 reason 到了就立刻结算。

宽限过期仍无 reason 时**不发通知**——没有 reason 的"完成"是猜的，
一条错的"你的任务完成了"比没有更糟。

### 为什么宿主插件要自己再起一个端口

DSH 的 WebServer 是**给浏览器**用的，路由活在页面同源与 same-origin 防护里。
桌宠是**非浏览器**的本机进程；让它去 DSH 端口上对话，等于把它耦合进
Harness 的 HTTP 命名空间。独立控制端口的好处：

- 只绑 `127.0.0.1`，DSH 关掉端口就没了 —— 桌宠据此判定"DSH 离线"。
- 生命周期干净，插件卸载/热重载即释放。

端口：桌宠事件端 `17322`，插件控制端 `17323`（避开 dsh-desk 的 `17321`）。

---

## 3. 安装

```powershell
# 1. 构建（产物：lib/index.js 宿主侧、client/client.js 浏览器侧）
cd dsh-plugin
npm install
npm run build

# 2. 装进 web profile（本地目录直装，不走 registry）
dsh plugin add --profile web file:C:\Users\star_fox\.dsh\source\deepseek-harness-pet-main\dsh-plugin

# 3. 重启 DSH 才会加载（这一步会中断正在运行的会话）
```

> `dsh plugin` 只是 pnpm 的一层封装：`add` 不会热加载已运行的宿主。
> 开发时可用 `dsh plugin add --profile web link:<绝对路径>` 建软链，改完重建 + 重启即可。

> **另一条路：应用内侧栏 Plugins 页**（产品入口，不必退出宿主）。目标填本目录的**绝对路径**；
> 装完**必须点「立即启用」**——只装不启用时 profile 的 `dsh.profile.bundles` 里没有它，宿主不会加载
> （页面原文："直接关闭则让它保持已安装但关闭"；"安装成功不代表模块一定能够激活"）。
> 它把本地目录记成 **`link:`（Junction 软链）**，与 CLI `file:` 的实体拷贝语义不同：
> `link:` 下改源码不需要重装（但已加载的 JS 模块世代仍要重启才替换），`file:` 下改源码根本不生效。
> **实测（2026-09-30，桌面应用 `0.2.0-rc.2` / `desktop` profile）：走界面装完免重启即加载**，
> `:19387/pet-bridge/notices` 由 `404` → `200`、`:17323` 当场归属桌面宿主。
> 步骤、判定表与证据边界见 `working-docs/DESKTOP-PROBE-2026-09-30.md`。

> **profile 归属（易踩）**：浏览器 UI 与 CLI 用 `web` profile（配套运行时 **0.1.5-rc.2**）；
> DSH **桌面应用** boot 的是 `desktop` profile（`~/.dsh/profiles/desktop`，配套运行时 **0.2.0-rc.2**），
> 两者**不共享** `node_modules`，所以上面这条命令只让浏览器端起效。
> **"往 `desktop` 再装一份是否就够"已实测**：宿主侧够（免重启加载、链路全通），
> 但页面侧在 0.2.0 上**不够**——见 `working-docs/DESKTOP-PROBE-2026-09-30.md` §3.3、§6.1。
> 另外两个宿主会抢控制端口 `17323`，**同一时刻只跑一个宿主**——共存的半残行为见该文档 §4。

### 配置

`dsh-plugin/cordis.patch.yml` 的 `config` 段：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `controlPort` | `17323` | 插件控制端口（`/hello` `/state` `/ack`） |
| `petPort` | `17322` | 桌宠事件端口（握手前使用；握手后以桌宠上报为准） |
| `notifyDelayMs` | `2500` | 推 `completed` 前等待浏览器观察的窗口 |
| `petEventTimeoutMs` | `800` | 单次推送超时 |
| `idleGraceMs` | `1500` | 等迟到 `turn/end` 的宽限 |
| `seenDwellMs` | `1500` | L3 要求的连续停留时间 |
| `maxNotices` | `100` | 未确认通知保留上限 |
| `noticeTtlMs` | `86400000` | 已结束通知保留时长 |
| `includeTitle` | `true` | 是否把会话标题发给桌宠（标题含用户输入） |

同一个 DSH 进程跑两个实例时**必须**改 `controlPort`（端口是固定监听）。
两个**宿主进程**（例如 `web` 与桌面应用）同时跑同理，而且改端口也救不了：凭据文件
`~/.dsh/pet-bridge.json` 是全局单文件，桌宠只读它，一次只能连一个宿主
（`working-docs/DESKTOP-COMPAT-FINDINGS.md` §4）。

---

## 4. 协议

### 4.1 插件 → 桌宠 `POST http://127.0.0.1:<petPort>/event`

```json
{
  "v": 1,
  "id": "<uuid>",
  "event": "completed",
  "source": "deepseek-harness",
  "hook": "run/idle",
  "sessionId": "…",
  "runId": "<uuid>",
  "targetTurnRef": "12",
  "timestamp": 1758300000000,
  "title": "会话标题",
  "message": "任务完成",
  "reason": "completed",
  "seen": false,
  "noticeId": "<uuid>"
}
```

归一化事件：`idle` / `running` / `completed` / `error` / `notice/seen` / `session/removed`。

**运行结算成哪个事件**（与 `src/index.ts` 的 `completionDispatch` 同源）：

| 结束原因 `reason` | 事件名 | 铸 `noticeId`？ |
| --- | --- | --- |
| `completed` | `completed` | 是 |
| `max-tokens` | `completed`（文案另写，不写成正常完成） | 是 |
| `error` / `blocked` | `error` | 是 |
| `aborted` / `interrupted` | `idle` | **否** —— 不算完成，不弹 |
| `unknown`（reason 缺失 / 畸形 / DSH 新增的 kind） | `idle` | **否** —— 不猜成功 |

只有 `completed` 与 `error` 能携带 `noticeId`，这两种才叫**结果事件**。
`error` 兼作运行中的失败上报（`tool/result`、`agent/error`），那时**没有** `noticeId`。
所以桌宠的判据是「有 `noticeId` 才算结果」，**不是**「名字叫 `error` 就算结果」。

**"看到即取消"的三种情况**（下表的"结果事件"= 带 `noticeId` 的 `completed` 或 `error`）：

| 情况 | 插件发的 | 桌宠做的 |
| --- | --- | --- |
| 发结果事件前已收到**本次通知**的 L3 观察 | 结果事件带 `seen: true` | **不弹**，记录已读 |
| 发结果事件时还没有 L3 观察 | 结果事件带 `seen: false` | 弹提示，记住 `noticeId` |
| 提示已弹，之后用户才看到 | 补发 `notice/seen` 带同一 `noticeId` | **按 `noticeId` 取消那条提示** |

桌宠按事件 `id` 去重、按 `noticeId` 建/取消提示。
重复或乱序的 `notice/seen` **不得**重建已关闭的提示。

### 4.2 桌宠 → 插件（控制端口）

```http
POST /hello { "v": 1, "petVersion": "…", "port": 17322, "token": "…" }
GET  /state?token=…            # { v, revision, sessions, notices, petPort, browserRoutes }
POST /ack   { "v": 1, "noticeId": "…", "action": "shown" | "dismissed", "token": "…" }
```

握手文件写在 `~/.dsh/pet-bridge.json`（权限 0600）：

```json
{ "v": 1, "controlPort": 17323, "token": "<每次进程启动轮换>", "writtenAt": "…" }
```

启动顺序任一侧先起都可以：桌宠先监听自己的端口，重试 `/hello`，成功后拉 `/state`
按 `noticeId` 对齐本地提示。插件每次重启轮换 token，桌宠认证失败后重读文件再握手。

`shown` 只表示桌宠**已实际显示**，不能从 HTTP POST 成功推断。

### 4.3 浏览器 → 插件（同源路由）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/pet-bridge/visibility` | 上报 `tabId` / `sessionId` / `visible` / `focused`（+ title）；只用于焦点租约与诊断 |
| `GET` | `/pet-bridge/notices?sessionId=…` | 只返回该会话**待确认**通知的 `noticeId`/`runId`/`targetTurnRef` |
| `POST` | `/pet-bridge/seen` | `{ noticeId, runId, sessionId, tabId, observed: true }` |

`/seen` 的准入条件（缺一不可，宿主持有最终裁决）：

- same-origin（`Origin` 的 host 与 port 必须等于 `Host`，且 host 是 loopback）
- `observed === true` 逐字存在 —— 只报"可见"不能退休通知
- `noticeId` / `runId` / `sessionId` 与已存通知三者一致
- 该 `tabId` 的焦点租约仍然有效（`visible && focused`，TTL 15s）
- 该标签页上报的当前会话就是通知所属会话

### 4.4 隐私边界

v1 **只发**：事件名、`sessionId`、会话标题（可关、截断 160）、工具**名**、进度计数、
有界状态文案。

**不发**：prompt 全文、assistant 消息、工具参数原文、工具结果、`todo/write` 文本、凭据、请求体。
工具结果失败只发通用类别，不发错误正文——错误文本可能复述用户输入。

失败只以**封闭类别白名单**过线（`src/index.ts` 的 `ErrorCategory`）：

| 类别 | 上报文案 |
| --- | --- |
| `network` | 运行出错：网络连接失败 |
| `auth` | 运行出错：认证失败 |
| `rate-limit` | 运行出错：请求过于频繁 |
| `aborted` | 运行已中止 |
| `unknown` | 运行出错 |

`error.code` 只被用来**分类**（正则匹配标记），原文、`error.message`、原始字符串**一律不过线**，
连截断后的形式也不发。桌宠侧认不出的 `reason` 也一律给中性文案（`运行结束`），
不写成「任务完成」。

> 截断是显示上界，**不是**隐私边界。字段白名单才是：
> 敏感内容在协议里根本没有能承载它的字段。测试 `buildEvent: the privacy boundary`
> 锁住了这一点。

### 4.5 安全

- 控制服务只绑 `127.0.0.1`，绝不 `0.0.0.0`。
- 控制 API 需 bearer token（`/hello` `/ack` 在 body 里，`/state` 在 `x-pet-token` 头或 `?token=`）。
  回环地址本身**不能**鉴别本机进程。
- 请求体上限 64 KiB；控制端口被占用时明确报错并停用桥接，
  **不**把 token 或事件发给占用端口的进程。
- 所有 `register` / `listen` 的 disposer 都挂在 `ctx.effect` 上。
- 浏览器侧 `POST` 做 same-origin 校验后仍要过 `/seen` 的四项核对。

---

## 5. 开发

```powershell
npm run typecheck     # 对着本机运行中的 DSH 类型检查（见下）
npm test              # 编译测试 + 跑全部单测/集成测试（末行打印实测条数）
npm run build         # 两个 bundle
npm run smoke:bundle  # 加载真实产物，校验 bundle 纯净性与 manifest
npm run roundtrip     # 离线跑通全链路（不碰运行中的 DSH）
npm run mock-pet      # 假桌宠：收事件 + 交互 ack（seen/dismiss/state/quit）
npm run check         # 以上全部
```

### 类型检查对着**活的** DSH

`tsconfig.check.json` 用 `paths` 把 `@deepseek-ai/dsh-session`、`dsh-agent`、
`cordis` 指向本机 profile 里**正在运行的那份声明**，而不是在插件里另装一份。

原因有两个：一是发布的 prerelease peer 范围互相打架
（`dsh-agent@0.1.5-rc.2` 会拉来要求 `dsh-session@^0.1.5-rc.3` 的
`dsh-session-projection`，而那个版本不存在）；二是**只有对着宿主真正加载的声明检查，
编译通过才说明运行时不会炸**。

装到别的机器上时改 `tsconfig.check.json` / `tsconfig.test.json` 里的绝对路径即可。

### 测试怎么跑

`node --test` 默认给每个测试文件开一个子进程（`stdio: 'pipe'`）。在受限沙箱里这会
`EPERM`，所以用 `--test-isolation=none --test-force-exit` 在单进程内跑。
文件都显式列出（不用目录/glob），避免 Windows 下 glob 展开的差异。

### 宿主侧运行时不依赖 Harness 包

宿主 bundle 只有两类外部 import：`node:*` 与 `@deepseek-ai/schemastery`
（profile 的 `node_modules` 已经提供）。`@deepseek-ai/dsh-session`、
`dsh-agent`、`cordis` **只做类型引用**，`smoke:bundle` 会断言它们不在产物里。

harness 的结构化面集中在 **`src/pins.ts`** —— 这是唯一引用 DSH 内部类型的模块
（`SessionFace` / `AgentFace` / `SessionEventFace` + 锚点 + 机制）。`src/index.ts`
只 type-import 它并 re-export faces，自身不含任何 `@deepseek-ai/dsh-*` 引用；
把插件抽出来给别人用时，要对照宿主版本改的也只有这一个文件。

锚点必须是**会因约束不满足而失败**的形式：

```ts
export type Assert<T extends true> = T
export type Satisfies<Actual, Face> = Actual extends Face ? true : false
type _SessionPinned = Assert<Satisfies<import('@deepseek-ai/dsh-session').Session, SessionFace>>
```

反例（曾经用过、**无效**）：`X extends Face ? true : never` 求值为 `never` 不产生任何编译错误，
别名还没人读，于是漂移静默通过 `npm run typecheck`。
现在 `Assert` 的约束在实例化处即被检查；另有 `_ReasonsCovered` 锚住 `turn/end` 的 reason 全集。

**机制与测试必须共用同一份定义。** 这两个类型是 `export` 的，`tests/pins.test.ts`
经 `tests/harness.ts` 引用**生产**的 `Assert`/`Satisfies` 来构造负例。
测试若自己再声明一份副本，就拦不住"生产锚点被改回失效形式"这条回退 —— 那是它唯一的存在理由。
因此该测试能同时抓住三种回退：`Assert` 失去约束、`Satisfies` 变回 `? true : never`
（负例成为 `Assert<never>`，而 `never` 满足任意约束）、`Satisfies` 条件被改成恒真；
`_PinCount` / `_PinsHold` 另外断言锚点**清单**，防止锚点被删除而非弱化。

形状漂移会在 `npm run typecheck` 失败，而不是在用户会话的凌晨三点失败
（这是刻意的：DSH 升级新增结束原因时，宁可构建失败，也不能让它被降级成"任务完成"）。

### 浏览器侧 bundle 纯净性

`client/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 形式的懒加载 CJS 工厂。
本插件浏览器侧**不渲染任何 UI**，所以 externals 为空：
产物里没有任何 `import` / `require()`，这是 bundle 纯净性门禁最强的形态。
`smoke:bundle` 逐条断言。

---

## 6. 目录

```
dsh-plugin/
├── package.json          # dsh.bundle.patch + dsh.client.{platform,inject}
├── cordis.patch.yml      # 把插件挂进 profile loader 树 + 默认配置
├── tsdown.config.ts      # 宿主 ESM bundle + 浏览器 CJS 工厂 bundle
├── tsconfig.check.json   # 对着活的 DSH 类型检查
├── tsconfig.client.json  # DOM 侧
├── tsconfig.test.json    # 测试（含 paths 映射）
├── tsconfig.host.json    # 给 tsdown 的 noCheck 配置
├── tsconfig.types.json   # Harness-free 基线
├── src/
│   ├── index.ts          # apply(ctx, config)：订阅、控制服务、推送、可选浏览器路由
│   ├── pins.ts           # 唯一引用 DSH 内部类型的模块：faces + 编译期锚点 + 其机制
│   ├── protocol.ts       # 三方共享的协议事实源（无 node: 依赖，浏览器侧也 import）
│   ├── state.ts          # SessionProgress / Notice 表 + 运行结束聚合（纯函数）
│   ├── pet-client.ts     # 向桌宠 POST（超时/串行队列/abort）
│   ├── control-server.ts # /hello /state /ack
│   ├── routes.ts         # /pet-bridge/* + 焦点租约
│   └── client/
│       ├── index.ts      # 浏览器侧 apply(ctx)：租约、查询、上报
│       └── visibility.ts # L1/L2/L3 + turn 行可视 + 连续停留计时
├── tests/
│   ├── state.test.ts
│   ├── protocol.test.ts
│   ├── pins.test.ts          # 负向类型测试：引用生产机制，证明锚点真的会失败
│   ├── credentials.test.ts   # 手递文件只在「指定端口」时才发布（port 0 不得覆盖活桥接）
│   ├── integration.test.ts   # 真 loopback：控制服务 + 推送 + /state 对齐
│   ├── visibility.test.ts    # D1 取行规则 + L1/L2/L3 阶梯
│   ├── decide.test.ts
│   ├── client.test.ts
│   ├── acceptance-page.test.ts
│   ├── session-picker.test.ts
│   └── gate-c-judge.test.ts
└── tools/
    ├── mock-pet.mjs      # 假桌宠（`--ack-shown` 用来停在 shown 态）
    ├── roundtrip.mjs     # 离线全链路（凭据写私有临时路径，不碰活桥接）
    ├── cdp-acceptance.mjs / gate-c-*.js / *-page.js / browser-auth.mjs
    │                     # 真机 CDP 验收驱动（`npm run acceptance`）
    └── smoke-bundle.mjs  # 产物门禁
```
