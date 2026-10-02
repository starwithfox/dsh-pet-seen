# dsh-pet-seen

DSH 插件：把 Harness 的任务状态推给本机桌宠，并把"**用户确实看到了这次完成**"
回传给 Harness，从而做到「看到即取消提示」。

这是桌宠项目的 "DSH 侧一半"。另一半（桌宠接收端）在 `pet.py`，按本文协议对接。

> 设计依据与取舍：仓库根目录 `DESIGN-dsh-pet-plugin.md`。
> **下面所有 `working-docs/…` 路径都只在开发者的本地 checkout 里存在**——`working-docs/` 与 `archive/`
> 不随仓库发布；引用它们是为了给出可核对的记录位置，正文结论已在本文写全。
> **当前状态与下一步：`working-docs/STATUS.md`（唯一入口）**——一眼看清"探到哪了、还差什么、按什么顺序做"。
> 成熟度评估与安装/分发建议：`working-docs/PLUGIN-MATURITY.md`（平台层"谁有权装"、项目层可分发清单、
> 运维层共存与生效语义；含发布口径一节）。
> 过程文档保存在 `working-docs/`，旧轮次记录保存在 `archive/`。
> 桌面端（Electron 应用）实测：`working-docs/DESKTOP-PROBE-2026-09-30.md`（权威记录）与
> `working-docs/DESKTOP-COMPAT-FINDINGS.md`（已冻结的历史证据）。要点：桌面应用 boot 的是
> **`desktop` profile**，**不共享** `web` profile 的 `node_modules`（`DESKTOP-COMPAT-FINDINGS.md` §1
> 记录的"`:19387` 上 `/pet-bridge/*` 为 `404`"是**安装前**的状态；现插件已装入 `desktop` profile）；
> 两个宿主会抢控制端口，**同一时刻只跑一个**（该文档 §4）。
> 桌面容器把页面 origin 改成 `dsh-app://app` 并在转发时剥掉 `Origin`；**实测那条转发是通的**
> （桌面渲染进程内 `POST /pet-bridge/visibility` 全程 `200`），所以浏览器半边**不是**因容器而失效。
> **"要真正支持桌面端该怎么做"已定位到字节级、并且修复已落地**：根因是 0.2.0 从 `sessions.list`
> 快照里删掉了 `current`（0.1.5-rc.2 有），客户端因此永远拿不到当前会话，
> **连一次 `GET /pet-bridge/notices` 都不会发**，也就永远不会 `/seen`、永远不撤销桌宠提示。
> **它不是桌面端独有的问题**：`:19387` 对外提供的那份前端同样没有该字段，普通浏览器打开会一样失效。
> 见 `working-docs/DESKTOP-PROBE-2026-09-30.md` §3.3、§6.1。
> **修复已实施并在两个宿主上真机验收**（`working-docs/FIX-DESIGN-SESSION-CURRENT-2026-09-30.md`）：
> 首选读法改为 `uiSession.adapter.current`（0.1.5 / 0.2.0 都有且同形，一条路径双支持），再加代次复核与订阅；
> 判据是 `/pet-bridge/notices` 请求次数 > 0 且 `seenAt` 被写入——桌面宿主 `0.2.0-rc.2` 与
> `web` 宿主 `0.1.5-rc.2`（脚本化 CDP，Gate A 14/14 PASS、`/notices` 直接计数 15 次）**两边都成立**。
> **支持范围与"没测过的版本"怎么处理，见 §3.0。**

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

#### 已知限制（L3 的证据强度上限）

**L3 只能证明"有机会看到"，不能证明"看到了"。** 它是**几何**判定：读的是"这次完成结果自己的那一行
是否进入滚动容器视口并连续停留 ≥ `seenDwellMs`"，而不是眼球或阅读行为。所以本插件取消提示的依据是
"用户**有没有机会**看到"，不是"用户读没读"——**这是设计选择，不是待修的缺陷**；上表误判列里那句
"仍无法证明真的读了"就是这条上限，这里把它单独写明白。

- **论据**：`REFS-ANALYSIS.md` §4.3 指出，参考实现废弃的是**另一个问题**（"用户目光是否落在这只宠物上"，
  要猜意图），与本插件读的"行级几何 + 连续停留"不是同一件事 ⇒ **不能据此否掉 L3，也不能据此抬高它**。
  收编在 `working-docs/STATUS.md` §10.2。
- **两条同源边界**（都不是本条的替代品，别互相顶替）：
  ① L3 的**前置**是 L2（页面可见且聚焦），而"Alt+Tab 之后焦点 API 是否可信"**仍未在 Electron 上单独实测**
     ——`working-docs/STATUS.md` §10.1；
  ② face 曾因 harness 重挂载会话槽而**静默失效**（页面此后永不 `/seen`，只有刷新才恢复）——那是**缺陷，已修**，
     见 §5"DOM face 每次判定都重新解析"。**修好 face 只保证"确实有机会看到"，不提高 L3 的证据强度。**

---

## 2. 结构

```
DSH 宿主进程 (node)
├── dsh-pet-seen 宿主侧
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

### 3.0 支持范围 —— **"放行"不等于"兼容"**

声明的宿主范围写在 `package.json` 的 `peerDependencies`：

```json
"@deepseek-ai/dsh": "^0.1.5-rc.2 || ^0.2.0-rc.2"
```

- **只有这两个构建被真机验收过**：`0.1.5-rc.2`（`web` profile：浏览器 UI 与 CLI）与 `0.2.0-rc.2`
  （DSH 桌面应用 boot 的 `desktop` profile）。两者的判据都成立（见文首横幅）。
- ⚠️ **这是"放行"，不是"兼容"**：上面的范围会**放行** `0.1.6` / `0.2.0` 这类同系列新版本，
  但**未实测的版本不保证兼容**。上游一旦改动本插件依赖的内部面（`uiSession` 读法、
  `turn/end` 的 kind、`webServer` / `sessions` / `agents` 的服务形状），插件可能**静默**失效。
- **怎么测一个没测过的宿主版本**（判定一律用**宿主状态**，不要只看命令退出码）：
  1. 取**宿主运行时**的版本——读宿主自己的 `package.json`（桌面端在 `app.asar` 里那份
     `dsh-app-boot`），**不是** `dsh` CLI 那份；
  2. 先离线算区间：`semver.satisfies(<运行时版本>, <上面的 peer 范围>, { includePrerelease: true })`
     （`semver` 随全局 `dsh` 装着，不必 `npm install`）；
  3. 再真机冒烟：先确认插件**没被禁用**（兼容闸门命中时是 profile 里 `row.disabled = true`
     加 **stderr 一行**，**不写进 `/state`**），随后 `npm run probe:http` 要 `PASS`、
     `bridge-state.mjs` 不得出现 `STALE` / `DRIFT` / `OLD` / `MIXED`、`:17323/state` 的
     `sessions[].reader` 要能读到；
  4. 万一被拦：`dsh plugin allow-version` 会往 profile 的 `compatibility.json` 写**临时豁免**——
     **豁免不是验收**，它只让你能继续测。
- ⚠️ **别把 `pluginVersion` 当成宿主兼容性**：它（`0.1.1`）是**插件自己**的版本，只表"插件换代"；
  `buildId` 则表"同一版重新构建"。两者都**不**表示某个宿主版本被支持——那件事只由上面的 peer 范围表达。

### 3.1 装进 profile

```powershell
# 主推：软链（Junction）。改源码不需要重装，见 3.2
dsh plugin add --profile web link:<克隆目录>

# 备选：实体拷贝（硬链接镜像）。升级语义与上面不同，见 3.2
dsh plugin add --profile web file:<克隆目录>

# registry 渠道：等 0.1.1 正式发布之后才有意义
# （在此之前 registry 上是同名占位版本，别拿它当正式包）
dsh plugin --profile web add dsh-pet-seen

# 装完必须重启 DSH 才会加载宿主半边（这一步会中断正在运行的会话）
```

> **本仓库就是插件本身**：仓库根目录即插件目录（`dsh-plugin/` 那一层是它还在桌宠仓库里时的历史包袱）
> ⇒ 上面 `link:` / `file:` 指的都是**仓库根**。桌宠接收端（Python）不在本仓库内，见 §7。
>
> **克隆后不需要构建**：`lib/index.js`（宿主侧）与 `client/client.js`（浏览器侧）两个产物**已入库**，
> 装的过程也不需要 Node.js 或任何工具链。
>
> **只有改了 `src/` 才需要构建**（需要 Node 22+）：`cd <克隆目录>` → `npm install` → `npm run build`。
> 改完必须**把 `src/` 与重建后的产物一起提交**——`npm run check` 会先 `build`、再比对 HEAD 里的产物，
> 改了源码却没把产物一起提交就会红；`prepack` 在 `npm pack` / `npm publish` 前自动重建兜底。
> 产物由 tsdown 生成，**不要手改**。

> `dsh plugin` 只是 pnpm 的一层封装：`add` 不会热加载已运行的宿主。

### 3.2 升级：`git pull` 之后要做什么

- **`link:` 安装**：源码改了**不需要重装**（运行期直接读工作树）。但两件事必须记住：
  ① **宿主半边（`lib/index.js`）只有重启宿主才会换**——`link:` 只保证运行期读工作树，**不保证热重载**（实测）；
  ② **页面半边（`client/client.js`）由宿主自己重建**，不必重装。
  ⇒ 拿到新源码后：`npm run build` → **重启宿主**。
- **`file:` 安装是硬链接镜像，不是打包解包**：就地改写会**穿透**进 `node_modules`，**改名/重建会断链并
  冻住那个文件** ⇒ `git pull` 之后**必须重装**；只跑 `build` 修不好已经断链的那一半。
  ⚠️ "重装没生效"与"没重装"在旧工具下**形状相同**；现在 `probe:http` 与 `bridge-state.mjs` 会用
  `buildId` 把这种混合态直接判红。
- **改了包名或版本号时**（本项目就有一次：`dsh-pet-bridge` → `dsh-pet-seen`）：profile 里的依赖名与
  `dsh.profile.bundles` 条目名**都会变** ⇒ **必须重装**，并确认新名出现在 `dsh.profile.bundles` 里。

> **另一条路：应用内侧栏 Plugins 页**（产品入口，不必退出宿主）。目标填本目录的**绝对路径**；
> 装完**必须点「立即启用」**——只装不启用时 profile 的 `dsh.profile.bundles` 里没有它，宿主不会加载
> （页面原文："直接关闭则让它保持已安装但关闭"；"安装成功不代表模块一定能够激活"）。
> 它把本地目录记成 **`link:`（Junction 软链）**，与 CLI `file:` 的实体拷贝语义不同。
> **实测（2026-09-30，桌面应用 `0.2.0-rc.2` / `desktop` profile）：走界面装完免重启即加载**，
> `:19387/pet-bridge/notices` 由 `404` → `200`、`:17323` 当场归属桌面宿主。
> 步骤、判定表与证据边界见 `working-docs/DESKTOP-PROBE-2026-09-30.md`。

> **profile 归属（易踩）**：浏览器 UI 与 CLI 用 `web` profile（配套运行时 **0.1.5-rc.2**）；
> DSH **桌面应用** boot 的是 `desktop` profile（`~/.dsh/profiles/desktop`，配套运行时 **0.2.0-rc.2**），
> 两者**不共享** `node_modules`，所以上面那条命令只让浏览器端起效。
> **"往 `desktop` 再装一份"要装两半**：宿主侧够了（免重启加载、链路全通），页面侧的失效根因
> 已在第 1~6 步修掉，判据在两个宿主上分别取得——见 `working-docs/DESKTOP-PROBE-2026-09-30.md` §3.3、§6.1。
> 另外两个宿主会抢控制端口 `17323`，**同一时刻只跑一个宿主**——共存的半残行为见该文档 §4。

### 配置

`cordis.patch.yml` 的 `config` 段：

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
| `forked`（0.2.0 新增：分叉时剪断继承前缀里未闭合的回合） | `idle` | **否** —— 父会话没结束、子会话还没跑，不弹 |
| `unknown`（reason 缺失 / 畸形 / 尚未命名的新 kind） | `idle` | **否** —— 不猜成功 |

**DSH 新增 kind 不会静默落进 `unknown`**：`src/pins.ts` 的 `_ReasonsCovered` 拿宿主声明
`TurnEndReason['kind']` 去检查 `TurnEndKind`，**漏一个就编译失败**。0.2.0 的 `forked` 正是这样被发现的
（`npm run compat:0.2.0` 当时报 `src/pins.ts(107,3) TS2344`），所以 `unknown` 现在只兜
"reason 缺失 / 畸形"这类真正读不懂的输入。

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
GET  /state?token=…            # { v, revision, sessions, notices, petPort, browserRoutes, browserTabs, buildId, pluginVersion }
POST /ack   { "v": 1, "noticeId": "…", "action": "shown" | "dismissed", "token": "…" }
```

`/state` 的字段（桌宠只读 `sessions` 与 `revision`，其余键一律忽略 ⇒ 新增字段不必升协议版本）：

| 字段 | 含义 |
| --- | --- |
| `v` | **协议**版本（`1`），不是插件版本 |
| `revision` | 快照版本号，宿主进程内单调递增 |
| `sessions` / `notices` / `petPort` / `browserRoutes` | 会话桶、通知、桌宠端口、浏览器路由是否挂载 |
| `browserTabs` | 每个活页面最近一次上报的**会话读法诊断**与**构建标识**（15 s 租约，页面可见且聚焦才续租） |
| `buildId` | **宿主半边**的构建标识（见 §5「构建标识握手」） |
| `pluginVersion` | 该构建当时的 `package.json` `version`（人看的名字，与 `v` 无关） |

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
| `POST` | `/pet-bridge/visibility` | 上报 `tabId` / `sessionId` / `visible` / `focused`（+ title / 读法诊断 / `buildId`）；只用于焦点租约与诊断 |
| `GET` | `/pet-bridge/notices?sessionId=…` | 只返回该会话**待确认**通知的 `noticeId`/`runId`/`targetTurnRef` |
| `POST` | `/pet-bridge/seen` | `{ noticeId, runId, sessionId, tabId, observed: true }` |

`/visibility` 是**遥测**，不是同意：它标记不了任何通知已读，只有页面上的 L3 观察经
`/seen` 才能。它同时携带两类诊断——**会话读法自检**（`reader` / `readerReason` / `byIdCount`）与
**构建标识**（`buildId`，见 §5「构建标识握手」）——两者都只被宿主记录，桌宠永不读这条路由。

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
npm run typecheck       # 对着本机运行中的 DSH 类型检查（见下）
npm test                # 编译测试 + 跑全部单测/集成测试（末行打印实测条数）
npm run build           # 两个 bundle（lib/index.js、client/client.js）
npm run smoke:bundle    # 加载真实产物，校验 bundle 纯净性、manifest、产物卫生与构建标识
npm run check:artifacts # 判定「HEAD 里的产物 = 源码产物」（在 build 之后跑）
npm run probe:http      # 探针：web 资产 + 控制面；陈旧半边、两半不同构建与漂移都判 FAIL（可加 --state-json 夹具）
npm run roundtrip       # 离线跑通全链路（不碰运行中的 DSH）
npm run mock-pet        # 假桌宠：收事件 + 交互 ack（seen/dismiss/state/quit）
npm run check           # 以上全部（含产物一致性闸门）
```

### 产物入库与一致性闸门

`lib/`（宿主侧）与 `client/`（浏览器侧）**入库**，克隆即可安装（见 §3）。代价是必须保证
"提交的产物 = 源码产物"，这条靠机制而不是靠人记得：

- `npm run check:artifacts` = `git diff --exit-code HEAD -- lib client`，**在 `build` 之后跑才有意义**：
  它比的是"刚从 `src/` 重建出来的产物"与"HEAD 里那份"。**红 ⇒ 当前源码的产物还没进 HEAD**
  （改了 `src/` 却没连产物一起提交；产物被手改也在这里被抓）。**绿 ⇒ HEAD 里的产物就是当前源码的产物**。
- `npm run check` 已把它串在 `build` 与 `test` 之间（顺序就是这个前提）⇒ 今后"`check` 全绿"**同时**
  证明产物与源码一致；也因为入库了，`git status` 干净才真的能说明"机器上加载的就是仓库里那份"。
- 改了 `src/` 的提交**必须**带重建后的产物；`prepack` 保证 `npm pack` / `npm publish` 前先重建。
- `lib/types/*.d.ts` **已删除**：本包**不发布类型**（`tsconfig.types.json` 明文 `noEmit`、`exports` 里
  也没有 `types` 条件），那 6 个文件是 2026-09-24 旧构建的残留，却会被 `files: ["lib"]` 整目录打进包里。

### 产物卫生（第 5.1 步新增）

`smoke:bundle` 现在还断言两个产物里**没有探针残留**（denylist：`tamper-probe` / `probe-residue`）
与**没有本机绝对路径**（`C:\Users` / `C:/Users` / `star_fox` / 仓库名 / `file:///`）。

**约定**（成文落点；第 8 步收口）：往内置产物追加一行来做伪造探针时，**那一行必须含 `tamper-probe`**
——闸门认的 denylist 就是 `['tamper-probe', 'probe-residue']`（见 `tools/smoke-bundle.mjs` 的
`PROBE_RESIDUE` 与 "built artifacts carry no probe residue" 那条检查），不含就认不出来、**等于没打探针**。
来由是一次真实事故：4.3 的 P1 探针往 `client/client.js` 追加了一行，而 `file:` 安装与工作树**同 inode
（硬链接）**，那一行便**穿透**进了 `node_modules`，探针还原时又断开了链接——装出去的那份就冻在
"第 4.2 步产物 + 探针残留"上一整天，而所有闸门都是绿的（`working-docs/IMPL-LOG-SESSION-CURRENT.md` 第 5.1 步）。

⇒ **装/发之前**跑齐三条：`npm run build` → `npm run check:artifacts` → `npm run smoke:bundle`（都要绿）。

### 构建标识握手（第 6.1 步新增）

本插件是**两个各自独立加载的产物**：`lib/index.js`（宿主半边，**只有重启宿主才会换**）与
`client/client.js`（页面半边，随页面加载）。两者之间原本**没有任何版本握手** ⇒ 任何"半刷新"都会产生
**看不出来的混合态**：宿主新 / 页面旧，或反过来。最坏的一种就是"页面旧到不再取件"，表现成
**弹窗不消失，而宿主状态、退出码、日志全都正常**（`working-docs/IMPL-LOG-SESSION-CURRENT.md` 第 5.1 步
记了 2026-10-02 实测到的那一次）。

现在两半都会声明自己是哪一次构建：

- **标识是什么**：`tools/build-id.mjs` 里 `sha256(package.json 的 version + src/** 每个文件)` 的**前 16 位**，
  由 `tsdown.config.ts` 用 `define` **同时**烘焙进两半 ⇒ 同一次构建的两半必然相同，不同的构建必然不同。
  它是**内容派生**的：改了 `src/`（哪怕只改注释）或改了 `version`，id 就会变。
- **谁报给谁**：页面在每次 `POST /pet-bridge/visibility`（含 `pagehide` 那次）里带上自己的 `buildId`；
  宿主把自己的 `buildId` 与每个 tab 报来的 `buildId` **并列**放进 `/state`（外加人看的 `pluginVersion`）。
  **宿主不给判决**——它只陈述两个事实，"哪一半落后"留给读者，免得把这个信息压成一个布尔。
- **谁判红**：`npm run probe:http`。三条新判据排在读法判据之前（两半不同构建时，读法异常只是**症状**）：
  宿主没有 `buildId` ⇒ **FAIL**（宿主半边早于本步）；某个活 tab 没有 `buildId` ⇒ **FAIL**（该页面半边早于本步）；
  两者不一致 ⇒ **FAIL**（`MIXED`）。`bridge-state.mjs` 只打印 `OLD` / `MIXED` 标记，不判。
- **闸门**：`smoke:bundle` 第 8 条要求**两半产物都携带当前源码的 id**。它补的是一个实测过的假阴性——
  **改了 `src/` 却不 `build` 时，`check:artifacts` 是绿的**（两个闸门咬的不是同一件事：前者管"产物进没进
  HEAD"，这条管"产物是不是当前源码的"）。

**排障口径**（细节见 `working-docs/STATUS.md` §4 第 27 条与 §12 ⑩）：

- `link:` 安装**只保证运行期读工作树，不保证宿主半边热重载** ⇒ 改过 `lib/` 后**必须重启宿主**，
  页面半边则会自己重建。重启前 `probe:http` 报 `this host half predates the build handshake` **是预期**。
- `file:` 安装是**硬链接镜像**：就地改写会穿透，改名/重建会断链并**冻住该文件** ⇒ `git pull` 之后
  **必须重装**，只跑 `build` 修不好已断链的那一半。混装的两半会被上面那条判据直接抓出来。

### DOM face 每次判定都重新解析（L3 静默失效的修复）

L3 判定（"这轮的结果确实在屏上"）要靠两个 DOM 节点：`[data-chat-flow]` 与
`[data-conversation-scroll]`。**harness 在每次会话切换时都会重挂载会话槽**，所以这两个节点会被换成新的。

`createVisibilityDeps()` 因此**在每次读取时重新 `query`**，而不是建一次存起来：

- 存成值会在第一次切换会话后变成**死引用**——`querySelectorAll` 在脱离文档的节点上**仍会返回它当时的孩子**，
  于是 `flowItems()` 不会走 `document` 回退分支，而所有矩形测量都是 0
  ⇒ `isTurnVisible()` **恒 false** ⇒ 页面此后**永远不发 `/seen`，且不打任何日志**。
  现场表现就是"桌宠提示再也不自动消失"，**只有刷新页面才恢复**（2026-10-02 实测到的那次）。
- 重新解析的代价是每次判定多两次 `querySelector`，换来的是 `VisibilityDeps` 保持普通值形状、
  **所有消费点与测试夹具都不用改**。
- 覆盖用例：同一个 fixture 在 `apply()` **之后替换** flow/scroll 节点，`/seen` 仍须上报
  （`tests/client.test.ts` 与 `tests/visibility.test.ts` 各一条；把 face 改回"只解析一次"两条都会红）。

### 类型检查对着**活的** DSH

`tsconfig.check.json` 用 `paths` 把 `@deepseek-ai/dsh-session`、`dsh-agent`、
`cordis` 指向本机 profile 里**正在运行的那份声明**，而不是在插件里另装一份。

原因有两个：一是发布的 prerelease peer 范围互相打架
（`dsh-agent@0.1.5-rc.2` 会拉来要求 `dsh-session@^0.1.5-rc.3` 的
`dsh-session-projection`，而那个版本不存在）；二是**只有对着宿主真正加载的声明检查，
编译通过才说明运行时不会炸**。

#### `npm run compat:0.2.0`：对着**另一个**宿主版本的声明再查一遍

`tsconfig.check.json` 指向的是本机 profile（这里是 **0.1.5-rc.2**），而本插件声明同时支持
**0.2.0-rc.2**。桌面 `app.asar` 里**一份 `.d.ts` 都没有**（打包器把声明全丢了），所以
`tsconfig.compat-0.2.0.json` 改成指向 `_scratch/` 下**从 registry 取回、并与 asar 内 `.js`
逐字节核对过**的声明，并把 `dsh-session` 与 `dsh-agent` **两个**包都换到 0.2.0-rc.2。

⚠️ **它的前置不在版本控制里**（`_scratch/` 被 `.gitignore` 忽略）⇒ **别的机器、或清过
`_scratch/` 的克隆上，这条命令必然失败**。取回方式：

```powershell
node _scratch/fetch-dsh-session.mjs        # dsh-session@0.2.0-rc.2 的 lib/**/*.d.ts
node _scratch/fetch-dsh-agent-0.2.0.mjs    # dsh-agent@0.2.0-rc.2 的 lib/**/*.d.ts
node _scratch/compare-dsh-agent-asar.mjs   # 与 asar 内的 .js 逐字节核对（期望 11/11 same）
```

（取回脚本本身也在 `_scratch/` 里，属同一类"本机材料"。它**故意不接进 `npm run check`**：
一条依赖网络与 gitignored 目标的检查不该成为普通门禁的前置。**判据**：

- 它**绿**只说明"被 pin 的类型面在 0.2.0-rc.2 下能编译"；
- 它**红**才是重点——`src/pins.ts` 的 `_ReasonsCovered` 会在宿主新增 `turn/end` kind 时直接编译失败
  （0.2.0 的 `forked` 就是这样被发现的，当时的报错正是 `src/pins.ts(107,3) TS2344`）。

#### 本机绝对路径是已知债（**本轮只成文，不改造**）

`tsconfig.check.json` / `tsconfig.compat-0.2.0.json` / `tsconfig.test.json` 里共有
**15 处**本机绝对路径（6 + 4 + 4 + 1 处示例），指向这台机器的 DSH 安装位置。
装到别的机器上就得改它们；**结构性改造（环境变量/相对解析）留给 P1-E 专项**
（`working-docs/PRIORITIES-2026-09-30.md` §3），本轮不动。

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
dsh-pet-seen/            # 本仓库根目录 = 插件目录（没有 dsh-plugin/ 那一层）
├── package.json          # dsh.bundle.patch + dsh.client.{platform,inject}
├── cordis.patch.yml      # 把插件挂进 profile loader 树 + 默认配置
├── LICENSE               # MIT，署名 starwithfox（随包发布）
├── tsdown.config.ts      # 宿主 ESM bundle + 浏览器 CJS 工厂 bundle
├── tsconfig.check.json   # 对着活的 DSH 类型检查
├── tsconfig.client.json  # DOM 侧
├── tsconfig.test.json    # 测试（含 paths 映射）
├── tsconfig.host.json    # 给 tsdown 的 noCheck 配置
├── tsconfig.types.json   # Harness-free 基线（`noEmit`：本包不发射 .d.ts）
├── lib/                  # 【入库】宿主侧产物（tsdown 生成，勿手改）
│   └── index.js
├── client/               # 【入库】浏览器侧产物（tsdown 生成，勿手改）
│   └── client.js
├── src/
│   ├── index.ts          # apply(ctx, config)：订阅、控制服务、推送、可选浏览器路由
│   ├── pins.ts           # 唯一引用 DSH 内部类型的模块：faces + 编译期锚点 + 其机制
│   ├── protocol.ts       # 三方共享的协议事实源（无 node: 依赖，浏览器侧也 import）+ 构建标识
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
    ├── build-id.mjs      # 构建标识的唯一定义（version + src/** 的哈希），构建与门禁共用
    ├── mock-pet.mjs      # 假桌宠（`--ack-shown` 用来停在 shown 态）
    ├── roundtrip.mjs     # 离线全链路（凭据写私有临时路径，不碰活桥接）
    ├── cdp-acceptance.mjs / gate-c-*.js / *-page.js / browser-auth.mjs
    │                     # 真机 CDP 验收驱动（`npm run acceptance`）
    └── smoke-bundle.mjs  # 产物门禁
```

---

## 7. 许可与范围

- **本包（`dsh-pet-seen`）是 MIT，著作权归 `starwithfox`**：正文见同目录 `LICENSE`，
  且随包发布（`files` 里含 `LICENSE`，`npm pack` 会带你核到）。
- **范围声明**：本包**只含 DSH 插件侧**的代码与产物（`lib/`、`client/`、`cordis.patch.yml`、
  本文与 `LICENSE`）。**桌宠接收端（Python：`pet.py` / `pet_bridge.py` 等）不在本包内**，
  它的著作权不属于本插件作者，也不随本包分发。
- ⚠️ 仓库根目录另有一份 `LICENSE`，**署的是桌宠侧原作者**；两者不是同一份授权，**别互相顶替**。
- `working-docs/` 与 `archive/` 是开发者的本地过程记录，**不随包发布**。
