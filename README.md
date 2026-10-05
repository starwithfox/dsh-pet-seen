# dsh-pet-seen

DSH 插件。把 Harness 的任务状态**推**给本机桌宠，并把「**用户确实看到了这次完成**」**回传**给 Harness —— 于是能做到「看到即取消提示」。**同时支持 DSH Web 与 DSH 桌面应用。**

面向两类开发者：**写桌宠接收端**的（读 [§4 协议](#4-协议)）与**改/复用本插件**的（读 [§5 开发](#5-开发)）。

**另一侧是你的桌宠** —— 语言、框架任选，只要实现 §4 里那几个端点；它**不在本包内**，由你自己实现。

## 1. 亮点

- **「看到即取消」不靠"窗口有焦点"** —— 判定分三级，只有 L3（**本次结果自己的那一行**进入对话滚动容器视口并连续停留 ≥ `seenDwellMs`）才算数。只判到 L2 会在多任务并行时**静默吞掉**提示（详见 [1.2](#12-看到即取消的判定分三级)）。
- **接收端不需要懂 DSH** —— 只要监听一个入站端点 `POST /event`，再会调 `/hello` / `/state` / `/ack` 三个接口就够；协议是**版本化且向后兼容**的：`/state` 的未知键一律忽略 ⇒ **加字段不必升 `v`**。你不必读 DSH 的会话文件、不必碰它的内部状态，也不必用 Node/JS 写。

### 1.1 为什么需要它

如果接收端**自己去读 DSH 的会话文件**（扫 `~/.dsh/sessions/**`、挑 mtime 最新的那个、解压取最后一条 `todo/write`），它有三个硬伤：**不知道用户在看哪个会话**（多任务并行时必然显示错的那个）、**慢**（轮询 + 全量解压）、**单向**（"已读"回不去）。

本插件把这一切改成**推送**：宿主按 `sessionId` 分桶，你的桌宠从"猜"改为"收"。

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

### 1.2 "看到即取消"的判定分三级

判定分三级，**只有第三级能取消提示**：

| 级别 | 信号 | 含义 | 能取消提示？ |
| --- | --- | --- | --- |
| L1 | `document.visibilityState === 'visible'` | 标签页在前台 | 否 |
| L2 | L1 且 `document.hasFocus()` | 窗口有焦点 | **否**，仅遥测 |
| L3 | L2 且**本次结果自己的 DOM 行**进入对话滚动容器视口并连续停留 ≥ `seenDwellMs` | 用户有机会看到这次结果 | **是**（宿主还要复核一次） |

只判到 L2 会在多任务并行时**静默吞掉**提示：用户盯着会话 A，会话 B 跑完了，标签页可见且窗口有焦点 ⇒ B 的提示被当成"用户已看到"而不弹。这是本插件存在的第一个理由。

**L3 是几何判定，只能证明"有机会看到"，不能证明"看到了"** —— 这是设计选择，不是待修的缺陷。

### 1.3 运行结束看 `agent/status`，不看 `turn/end`

`turn/end` **不结束一次运行**：goal 续跑、排队追问、多轮继续都会立刻开下一个 turn。所以 `turn/end` 只被*记录*（记下 reason），真正的结束信号是 `agent/status` 变为 `idle`。两者来源不同、**顺序无保证**：idle 先到时挂一个 `idleGraceMs` 宽限窗口等迟到的 `turn/end`，宽限期内 reason 到了就立刻结算；**过期仍无 reason 就不发通知** —— 没有 reason 的"完成"是猜的，一条错的"你的任务完成了"比没有更糟。

### 1.4 为什么宿主插件要自己再起一个端口

DSH 的 WebServer 是**给浏览器**用的（活在页面同源与 same-origin 防护里），桌宠是**非浏览器**的本机进程，让它去 DSH 端口上对话等于把它耦合进 Harness 的 HTTP 命名空间。独立控制端口的好处：只绑 `127.0.0.1`、DSH 关掉端口就没了（桌宠据此判定"DSH 离线"）、插件卸载/热重载即释放。端口：桌宠事件端 `17322`，插件控制端 `17323`（避开 dsh-desk 的 `17321`）。

## 2. 安装

装到哪由 **profile** 决定，而两个 profile **不共享 `node_modules`** ⇒ 得分别装、分别升级：

先把仓库克隆到本地（地址与 `package.json` 的 `repository` 同源）：

```powershell
git clone https://github.com/starwithfox/dsh-pet-seen.git
```

| 装到哪 | profile | 怎么装 |
| --- | --- | --- |
| DSH Web（`dsh web`：浏览器 UI 与 CLI） | `web` | 用下面的命令 |
| DSH 桌面应用（Electron） | `desktop`（`~/.dsh/profiles/desktop`） | **不是下面的命令** —— 桌面端的 profile 由桌面应用自己管，走应用内入口，见 2.1 |

```powershell
cd dsh-pet-seen                        # 上一步克隆出来的目录

# 主推：软链（Junction），改源码不必重装
dsh plugin add --profile web link:.

# 备选：实体拷贝（硬链接镜像），升级语义不同
dsh plugin add --profile web file:.

# 装完必须重启 DSH 才会加载宿主半边（这一步会中断正在运行的会话）
```

- **仓库根目录就是插件本身**，所以 `link:` / `file:` 指的都是仓库根（上面 `cd` 进克隆目录后用 `.`）。
- **克隆后不需要构建**：`lib/index.js`（宿主侧）与 `client/client.js`（浏览器侧）**已入库**，安装过程不需要 Node.js 或任何工具链。
- **只有改了 `src/` 才需要构建**（Node 22+）：`npm install && npm run build`；改完必须把 `src/` 与重建后的产物**一起提交**，否则 `npm run check` 会红。产物由 tsdown 生成，**不要手改**。
- `dsh plugin` 只是 pnpm 的一层封装，`add` **不会热加载**已运行的宿主。

### 2.1 桌面应用（Electron）—— 它读 `desktop` profile

**桌面应用 boot 的是 `desktop` profile，不是 `web`。** 按上面的 `--profile web` 装完，插件落在 `web` profile 里，而桌面窗口读的是 `desktop` profile ⇒ 表现是**界面上什么都没发生、也没有报错**。桌面端这样装：

- **应用内侧栏 Plugins 页**（不必退出宿主）：目标填本目录**绝对路径**，装完**必须点「立即启用」**—— 只装不启用时该 profile 的 `dsh.profile.bundles` 里没有它，宿主不会加载。它把本地目录记成 **`link:`**（Junction），与 CLI `file:` 的实体拷贝语义不同。**本仓库只实测过这一条路**。
- 两个宿主同时跑会抢控制端口 `17323` ⇒ **同一时刻只跑一个**。改端口也救不了：凭据文件 `~/.dsh/pet-bridge.json` 是全局单文件，桌宠一次只能连一个宿主。

### 2.2 升级：`git pull` 之后

- `link:` 安装：源码改了**不用重装**（运行期直接读工作树），但 ① 宿主半边 `lib/index.js` **只有重启宿主才会换**（`link:` 不保证热重载，实测）；② 页面半边由宿主自己重建。⇒ 拿到新源码后：`npm run build` → **重启宿主**。
- `file:` 安装是**硬链接镜像**，不是打包解包：就地改写会**穿透**进 `node_modules`，改名/重建会**断链并冻住那个文件** ⇒ `git pull` 后**必须重装**，只跑 `build` 修不好已断链的那一半。
- 改了包名或版本号 ⇒ profile 里的依赖名与 `dsh.profile.bundles` 条目名都会变 ⇒ **必须重装**。

### 2.3 装完怎么确认：**两半分开看**

这个插件是**两个各自独立加载的产物**（`lib/index.js` 宿主半边、`client/client.js` 页面半边），所以"没反应"必须分开判。下表每行的判据都**只有那一半会写**：

| 看什么 | 判据 | 为什么是它 |
| --- | --- | --- |
| 装进 profile 了吗 | 该 profile 的 `dsh.profile.bundles` 里有 `dsh-pet-seen` | 只装不启用时这里没有它，宿主不会加载 |
| 宿主半边起来了吗 | `~/.dsh/pet-bridge.json` 存在，且 `controlPort` 就是你配的 `17323` | **只有宿主半边会写**这个文件；token 每次宿主启动轮换 |
| 宿主半边状态可读吗 | `node tools/bridge-state.mjs` 打出头部行（形如 `controlPort=17323 … plugin=0.1.1 build=<16 位>`） | 它自己读文件里的 token 去问 `/state`，不必手抄 token |
| 页面半边在报吗 | `/state` 的 `browserTabs` 里有你那个 tab 的行，且带 `reader=` 与 `build=` | **只有页面半边会报**这两条；行随 15 s 租约过期，"没有行"= 页面没在报，不等于没装 |
| 两半是同一个构建吗 | tab 行的 `build=` == 头部行的 `build=` | 一次构建必然同 id；两者不同 ⇒ `MIXED`，该 tab 从未报过 ⇒ `OLD`；`npm run probe:http` 把两者都判 FAIL |

```powershell
node tools/bridge-state.mjs                 # /state 摘要：petPort、会话、每个 tab 的诊断、通知
npm run probe:http                          # web 资产 + 引导载荷 + 控制面 ⇒ 0 问题才 VERDICT: PASS
npm run probe:http http://127.0.0.1:19387   # 桌面宿主的 WebServer 端口不同（本仓库实测记录 19387）

curl "http://127.0.0.1:17323/state?token=<token>"                    # token 在 ~/.dsh/pet-bridge.json
curl "http://127.0.0.1:3080/pet-bridge/notices?sessionId=<会话 id>"
```

**看起来像坏了、其实是对的**：

- `bridge-state.mjs` 打出 `STALE` / `DRIFT` / `OLD` / `MIXED` **不是命令失败**，那是读数；把它判成红的是 `probe:http`。
- `probe:http` 报 `this host half predates the build handshake`：宿主半边在**重启宿主之前**就是旧构建—— 预期如此（见 §5.3）。
- 控制端口的 `401`（没带/带错 token）、`403`（`Host` 不是回环）、`404`（路径不对）、`405`（方法不对）、`413`（body 超 64 KiB）**都是判据在工作**。`probe:http` 若把控制面报成 **401**，含义是 `~/.dsh/pet-bridge.json` **属于另一个（或已死的）宿主** —— token 已被轮换，见 2.1 末条。
- `curl` 直接打 `/pet-bridge/notices?sessionId=…` 得到 `200`（没有待确认通知就是 `notices: []`）：缺 `Origin` 且 `Host` 是回环时按同源放行；换成非回环的 `Origin` 或 `Host` 就是 `403 cross-origin`。
- 除 `/seen` 外，拒绝体是 **`{"v":1,"ok":false,"reason":"…"}`**（如 `/pet-bridge/notices` 少了 `sessionId` ⇒ `400 missing-session`）；**成功体不带 `ok`**，看到 `ok:false` 就是明确拒绝。
- `POST /pet-bridge/seen` 被拒时返回 **`200` + `{"accepted":false,"reason":…}`**（`no-effective-lease` / `tab-not-on-session` / `observed-flag-missing` …），**不是 4xx** —— 页面据此记下原因，而不是当成传输错误去重试。
- `/pet-bridge/*` 整片 `404` ⇒ 该宿主上浏览器路由**没挂上**（插件没加载，或这个宿主没有 WebServer），不是路径写错 —— 回头对照上表第一行。

### 2.4 支持范围 —— **"放行"不等于"兼容"**

- 声明的宿主范围写在 `package.json` 的 `peerDependencies`：`"@deepseek-ai/dsh": "^0.1.5-rc.2 || ^0.2.0-rc.2"`。**只有 `0.1.5-rc.2`（`web` profile）与 `0.2.0-rc.2`（`desktop` profile）被真机验收过**；这个范围会**放行** `0.1.6` / `0.2.0` 这类同系列新版本，但**未实测的版本不保证兼容**：上游一旦改动本插件依赖的内部面（`uiSession` 读法、`turn/end` 的 kind、`webServer` / `sessions` / `agents` 的服务形状），插件可能**静默**失效。
- **测一个没测过的宿主版本**（判定一律看**宿主状态**，不要只看命令退出码）：① 取**宿主运行时**的版本 —— 桌面端读 `app.asar` 里那份 `dsh-app-boot` 的 `package.json`，**不是** `dsh` CLI 那份；② 离线算区间 `semver.satisfies(v, <peer 范围>, { includePrerelease: true })`；③ 真机冒烟 ——先确认插件**没被禁用**（被兼容闸门拦住时是 profile 里 `row.disabled = true` 加 stderr 一行，**不写进 `/state`**），再要 `npm run probe:http` 为 `PASS`。
- 被拦时可 `dsh plugin allow-version` 写**临时豁免**：**豁免不是验收**，它只让你能继续测。
- ⚠️ **别把 `pluginVersion` 当成宿主兼容性**：它是**插件自己**的版本（`0.1.1`）；`buildId` 表 "同一版重新构建"。两者都**不**表示某个宿主版本被支持 —— 那件事只由上面的 peer 范围表达。

## 3. 配置

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

---

## 4. 协议

本节是**你的桌宠唯一需要读的东西**。要实现的入站端点只有一个（`POST /event`），要调的接口三个（`/hello` / `/state` / `/ack`）。

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

归一化事件：`idle` / `running` / `completed` / `error` / `notice/seen` / `session/removed`。`id` 全局唯一，**按它去重**；`sessionId` / `runId` / `targetTurnRef` 用来把你的提示归到正确的会话。

**运行结算成哪个事件**（与 `src/index.ts` 的 `completionDispatch` 同源）：

| 结束原因 `reason` | 事件名 | 铸 `noticeId`？ |
| --- | --- | --- |
| `completed` | `completed` | 是 |
| `max-tokens` | `completed`（文案另写，不写成正常完成） | 是 |
| `error` / `blocked` | `error` | 是 |
| `aborted` / `interrupted` | `idle` | **否** —— 不算完成，不弹 |
| `forked`（0.2.0 新增：分叉时剪断继承前缀里未闭合的回合） | `idle` | **否** —— 父会话没结束、子会话还没跑，不弹 |
| `unknown`（reason 缺失 / 畸形 / 尚未命名的新 kind） | `idle` | **否** —— 不猜成功 |

**DSH 新增 kind 不会静默落进 `unknown`**：`src/pins.ts` 的 `_ReasonsCovered` 拿宿主声明的 `TurnEndReason['kind']` 去检查 `TurnEndKind`，**漏一个就编译失败**（0.2.0 的 `forked` 正是这样被发现的），所以 `unknown` 现在只兜"reason 缺失 / 畸形"这类真正读不懂的输入。

只有 `completed` 与 `error` 能携带 `noticeId`，这两种才叫**结果事件**。`error` 兼作运行中的失败上报（`tool/result`、`agent/error`），那时**没有** `noticeId` ⇒ 桌宠的判据是「有 `noticeId` 才算结果」，**不是**「名字叫 `error` 就算结果」。

**"看到即取消"的三种情况**（"结果事件"= 带 `noticeId` 的 `completed` 或 `error`）：

| 情况 | 插件发的 | 桌宠做的 |
| --- | --- | --- |
| 发结果事件前已收到**本次通知**的 L3 观察 | 结果事件带 `seen: true` | **不弹**，记录已读 |
| 发结果事件时还没有 L3 观察 | 结果事件带 `seen: false` | 弹提示，记住 `noticeId` |
| 提示已弹，之后用户才看到 | 补发 `notice/seen` 带同一 `noticeId` | **按 `noticeId` 取消那条提示** |

桌宠按事件 `id` 去重、按 `noticeId` 建/取消提示。重复或乱序的 `notice/seen` **不得**重建已关闭的提示。

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
| `buildId` | **宿主半边**的构建标识（见 [§5.3](#53-构建标识握手)） |
| `pluginVersion` | 该构建当时的 `package.json` `version`（人看的名字，与 `v` 无关） |

握手文件写在 `~/.dsh/pet-bridge.json`（权限 0600）：

```json
{ "v": 1, "controlPort": 17323, "token": "<每次进程启动轮换>", "writtenAt": "…" }
```

启动顺序任一侧先起都可以：桌宠先监听自己的端口，重试 `/hello`，成功后拉 `/state` 按 `noticeId` 对齐本地提示。插件每次重启轮换 token，桌宠认证失败后重读文件再握手。

`shown` 只表示桌宠**已实际显示**，不能从 HTTP POST 成功推断。

### 4.3 浏览器 → 插件（同源路由）

**这三条路由由插件内置的页面半边调用，与你的桌宠无关** —— 列在这里是为了让"看到即取消"的链路可以从头读到尾。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/pet-bridge/visibility` | 上报 `tabId` / `sessionId` / `visible` / `focused`（+ title / 读法诊断 / `buildId`）；只用于焦点租约与诊断 |
| `GET` | `/pet-bridge/notices?sessionId=…` | 只返回该会话**待确认**通知的 `noticeId`/`runId`/`targetTurnRef` |
| `POST` | `/pet-bridge/seen` | `{ noticeId, runId, sessionId, tabId, observed: true }` |

`/visibility` 是**遥测**，不是同意：它标记不了任何通知已读，只有页面上的 L3 观察经 `/seen` 才能。它同时携带会话读法自检（`reader` / `readerReason` / `byIdCount`）与构建标识（`buildId`），两者都只被宿主记录，桌宠永不读这条路由。

`/seen` 的准入条件（缺一不可，宿主持有最终裁决）：

- same-origin（`Origin` 的 host 与 port 必须等于 `Host`，且 host 是 loopback）
- `observed === true` 逐字存在 —— 只报"可见"不能退休通知
- `noticeId` / `runId` / `sessionId` 与已存通知三者一致
- 该 `tabId` 的焦点租约仍然有效（`visible && focused`，TTL 15s）
- 该标签页上报的当前会话就是通知所属会话

### 4.4 隐私边界

v1 **只发**：事件名、`sessionId`、会话标题（可关、截断 160）、工具**名**、进度计数、有界状态文案。

**不发**：prompt 全文、assistant 消息、工具参数原文、工具结果、`todo/write` 文本、凭据、请求体。工具结果失败只发通用类别，不发错误正文 —— 错误文本可能复述用户输入。

失败只以**封闭类别白名单**过线（`src/index.ts` 的 `ErrorCategory`）：

| 类别 | 上报文案 |
| --- | --- |
| `network` | 运行出错：网络连接失败 |
| `auth` | 运行出错：认证失败 |
| `rate-limit` | 运行出错：请求过于频繁 |
| `aborted` | 运行已中止 |
| `unknown` | 运行出错 |

`error.code` 只被用来**分类**（正则匹配标记），原文、`error.message`、原始字符串**一律不过线**，连截断后的形式也不发。接收端认不出的 `reason` 也**应**给中性文案（`运行结束`），**不得**写成「任务完成」。

> 截断是显示上界，**不是**隐私边界。字段白名单才是：敏感内容在协议里根本没有能承载它的字段。测试 `buildEvent: the privacy boundary` 锁住了这一点。

### 4.5 安全

- 控制服务只绑 `127.0.0.1`，绝不 `0.0.0.0`。
- 控制 API 需 bearer token（`/hello` `/ack` 在 body 里，`/state` 在 `x-pet-token` 头或 `?token=`）。回环地址本身**不能**鉴别本机进程。
- 请求体上限 64 KiB；控制端口被占用时明确报错并停用桥接，**不**把 token 或事件发给占用端口的进程。
- 所有 `register` / `listen` 的 disposer 都挂在 `ctx.effect` 上。
- 浏览器侧 `POST` 做 same-origin 校验后仍要过 `/seen` 的四项核对。

---

## 5. 开发

```powershell
npm run typecheck       # 对着本机运行中的 DSH 类型检查（见 §5.2）
npm test                # 编译测试 + 跑全部单测/集成测试（末行打印实测条数）
npm run build           # 两个 bundle（lib/index.js、client/client.js）
npm run smoke:bundle    # 加载真实产物：纯净性、manifest、产物卫生、构建标识
npm run check:artifacts # 判定「HEAD 里的产物 = 源码产物」（在 build 之后跑）
npm run probe:http      # 探针：web 资产 + 控制面；陈旧半边、两半不同构建与漂移都判 FAIL
npm run roundtrip       # 离线跑通全链路（不碰运行中的 DSH）
npm run acceptance      # 真机 CDP 验收（一次只跑一个宿主）
npm run mock-pet        # 假桌宠：收事件 + 交互 ack（seen/dismiss/state/quit）
npm run compat:0.2.0    # 对着 0.2.0-rc.2 的声明再查一遍（前置不在版本控制里，见 §5.2）
npm run check           # typecheck → build → smoke:bundle → check:artifacts → test（唯一闸门）
```

### 5.1 产物入库与一致性闸门

`lib/`（宿主侧）与 `client/`（浏览器侧）**入库**，克隆即可安装（见 §2）。代价是必须保证 "提交的产物 = 源码产物"，这条靠机制而不是靠人记得：

- `npm run check:artifacts` = `git diff --exit-code HEAD -- lib client`，**在 `build` 之后跑才有意义**：它比的是"刚从 `src/` 重建出来的产物"与"HEAD 里那份"。**红 ⇒ 当前源码的产物还没进 HEAD**（改了 `src/` 却没连产物一起提交；产物被手改也在这里被抓）。
- 改了 `src/` 的提交**必须**带重建后的产物；`prepack` 保证 `npm pack` / `npm publish` 前先重建。
- `smoke:bundle` 还断言产物里**没有探针残留**（denylist：`tamper-probe` / `probe-residue`）与**没有本机绝对路径**（`C:\Users` / `C:/Users` / `star_fox` / 仓库名 / `file:///`）。⇒ 往产物追加一行做伪造探针时，**那一行必须含 `tamper-probe`**，否则闸门认不出来、等于没打探针。

### 5.2 类型检查对着**活的** DSH

`tsconfig.check.json` 用 `paths` 把 `@deepseek-ai/dsh-session`、`dsh-agent`、`cordis` 指向本机 profile 里**正在运行的那份声明**，而不是在插件里另装一份 —— 发布的 prerelease peer 范围互相打架，而且**只有对着宿主真正加载的声明检查，编译通过才说明运行时不会炸**。

`tsconfig.compat-0.2.0.json` 针对另一个受支持宿主（`0.2.0-rc.2`）再查一遍；它指向 `_scratch/` 下从 registry 取回、并与桌面 `app.asar` 内 `.js` 逐字节核对过的声明 —— 该前置**不在版本控制里**，所以在别的机器上这条命令会失败，**故意不接进 `npm run check`**。它**红**才是重点：`src/pins.ts` 的 `_ReasonsCovered` 会在宿主新增 `turn/end` kind 时直接编译失败。

### 5.3 构建标识握手

本插件是**两个各自独立加载的产物**：`lib/index.js`（宿主半边，**只有重启宿主才会换**）与 `client/client.js`（页面半边，随页面加载）。两者之间原本没有任何版本握手 ⇒ 任何"半刷新"都会产生**看不出来的混合态**，最坏的一种表现成"弹窗不消失，而宿主状态、退出码、日志全都正常"。

- **标识是什么**：`tools/build-id.mjs` 里 `sha256(package.json 的 version + src/** 每个文件)` 的前 16 位，由 `tsdown.config.ts` 用 `define` **同时**烘焙进两半 ⇒ 同一次构建的两半必然相同。它是**内容派生**的：改了 `src/`（哪怕只改注释）或改了 `version`，id 就会变。
- **谁报给谁**：页面在每次 `POST /pet-bridge/visibility` 里带上自己的 `buildId`；宿主把自己的 `buildId` 与每个 tab 报来的 `buildId` **并列**放进 `/state`。**宿主不给判决** —— 只陈述两个事实。
- **谁判红**：`npm run probe:http`（宿主没有 `buildId` / 某个活 tab 没有 / 两者不一致 ⇒ FAIL）；`smoke:bundle` 第 8 条要求**两半产物都携带当前源码的 id** —— 它补的是一个实测过的假阴性：**改了 `src/` 却不 `build` 时，`check:artifacts` 是绿的**。

**排障口径**：`link:` 改过 `lib/` 后**必须重启宿主**（重启前 `probe:http` 报 `this host half predates the build handshake` **是预期**）；`file:` 是硬链接镜像，`git pull` 后**必须重装**（见 §2.2）。

### 5.4 宿主侧只在一处依赖 Harness 内部

宿主 bundle 只有两类外部 import：`node:*` 与 `@deepseek-ai/schemastery`（profile 的 `node_modules` 已提供）。`@deepseek-ai/dsh-session`、`dsh-agent`、`cordis` **只做类型引用**，`smoke:bundle` 会断言它们不在产物里。

harness 的结构化面集中在 **`src/pins.ts`** —— 唯一引用 DSH 内部类型的模块（face + 编译期锚点）。`src/index.ts` 只 type-import 它并 re-export faces，自身不含任何 `@deepseek-ai/dsh-*` 引用；**把插件移植到别的宿主版本时，要改的只有这一个文件**。

锚点必须是**会因约束不满足而失败**的形式（反例 `X extends Face ? true : never` 求值为 `never` 不产生编译错误 ⇒ 漂移静默通过）：`Assert<Satisfies<Actual, Face>>`，另有 `_ReasonsCovered` 锚住 `turn/end` 的 reason 全集。机制与测试必须共用同一份定义 —— `tests/pins.test.ts` 引用的就是**生产**的 `Assert` / `Satisfies`，自己再声明一份副本就拦不住"锚点被改回失效形式"这条回退。

### 5.5 其它

- **测试怎么跑**：`node --test` 默认给每个测试文件开子进程（`stdio: 'pipe'`），受限沙箱里会 `EPERM`，所以用 `--test-isolation=none --test-force-exit` 单进程跑；测试文件显式列出。
- **DOM face 每次判定都重新解析**：L3 依赖 `[data-chat-flow]` 与 `[data-conversation-scroll]`，而 harness 每次切换会话都会重挂载会话槽 ⇒ `createVisibilityDeps()` **每次读取时重新 `query`**。存成值会在第一次切换后变成死引用（矩形测量全 0 ⇒ `isTurnVisible()` 恒 false ⇒ 页面此后**永远不发 `/seen` 且不打日志**，只有刷新才恢复）。

## 6. 目录

```
├── package.json          # dsh.bundle.patch + dsh.client.{platform,inject}
├── cordis.patch.yml      # 把插件挂进 profile loader 树 + 默认配置
├── tsdown.config.ts      # 宿主 ESM bundle + 浏览器 CJS 工厂 bundle
├── lib/, client/         # 【入库】两半产物，tsdown 生成，勿手改
├── src/
│   ├── index.ts          # apply(ctx, config)：订阅、控制服务、推送、可选浏览器路由
│   ├── pins.ts           # 唯一引用 DSH 内部类型的模块：faces + 编译期锚点 + 其机制
│   ├── protocol.ts       # 三方共享的协议事实源（无 node: 依赖）+ 构建标识
│   ├── state.ts          # SessionProgress / Notice 表 + 运行结束聚合（纯函数）
│   ├── pet-client.ts     # 向桌宠 POST（超时/串行队列/abort）
│   ├── control-server.ts # /hello /state /ack
│   ├── routes.ts         # /pet-bridge/* + 焦点租约
│   └── client/           # 浏览器侧：index.ts（租约、查询、上报）+ visibility.ts（L1/L2/L3）
├── tests/                # 单测 / 集成（真 loopback）/ 负向类型 / L1-L3
└── tools/                # build-id、mock-pet、roundtrip、smoke-bundle、probe-http、CDP 验收驱动
```

## 7. 许可与范围

- **本包（`dsh-pet-seen`）是 MIT，著作权归 `starwithfox`**：正文见 `LICENSE`，且随包发布（`npm pack` 会带你核到）。
- **范围声明**：本包**只含 DSH 插件侧** —— `lib/`、`client/`、`cordis.patch.yml`、`README.md`、`LICENSE`（即 `package.json` 的 `files` 清单）。
- **另一侧（你的桌宠接收端）不在本包内**、也不随本包分发：它是你自己的程序，实现方式与许可证都由你定；本包只承诺 §4 那份协议。
