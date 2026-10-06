# dsh-pet-seen

DSH 插件。把 Harness 的任务状态**推**给本机桌宠，并把「**用户确实看到了这次完成**」**回传**给 Harness —— 于是能做到「看到即取消提示」。**同时支持 DSH Web 与 DSH 桌面应用。**

面向两类开发者：**写桌宠接收端**的（读 [§4 协议](#4-协议)）与**改/复用本插件**的（读 [§5 开发](#5-开发)）。

**另一侧是你的桌宠** —— 语言、框架任选，只要实现 §4 里那几个端点；它**不在本包内**，由你自己实现。

## 1. 亮点

- **「看到即取消」不靠"窗口有焦点"** —— 判定分三级，只有 L3（**本次结果自己的那一行**进入对话滚动容器视口并连续停留 ≥ `seenDwellMs`）才算数。只判到 L2 会在多任务并行时**静默吞掉**提示（详见 [1.2](#12-看到即取消的判定分三级)）。
- **接收端不需要懂 DSH** —— 入站端点只有一个（`POST /event`），要调的接口三个（`/hello` / `/state` / `/ack`），接口面就这些；协议是**版本化且向后兼容**的：`/state` 的未知键一律忽略 ⇒ **加字段不必升 `v`**。你不必读 DSH 的会话文件、不必碰它的内部状态，也不必用 Node/JS 写。**证据等级、以及还没覆盖的那一半，写在 [§4 协议](#4-协议) 开头。**

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

# 第三条渠道：registry 包（不必克隆、不必构建、不能改源码）
dsh plugin add --profile web dsh-pet-seen@0.1.1

# 装完必须重启 DSH 才会加载宿主半边（这一步会中断正在运行的会话）
```

- **仓库根目录就是插件本身**，所以 `link:` / `file:` 指的都是仓库根（上面 `cd` 进克隆目录后用 `.`）。
- **克隆后不需要构建**：`lib/index.js`（宿主侧）与 `client/client.js`（浏览器侧）**已入库**，安装过程不需要 Node.js 或任何工具链。
- **只有改了 `src/` 才需要构建**（Node 22+）：`npm install && npm run build`；改完必须把 `src/` 与重建后的产物**一起提交**，否则 `npm run check` 会红。产物由 tsdown 生成，**不要手改**。
- `dsh plugin` 只是 pnpm 的一层封装，`add` **不会热加载**已运行的宿主。
- **registry 渠道**（`dsh-pet-seen@<版本>`）：包已发布在 npm 上（`npm view dsh-pet-seen dist-tags` 现取为 `latest = 0.1.1`），**这一条不需要克隆、不需要构建、也不能改源码** —— 包里带的是构建好的两半产物（`lib/index.js` + `client/client.js`）、`protocol/` 与 `cordis.patch.yml`。走它就不必看上面的 `cd` 与克隆步骤。
  - **写死版本号，别指望 `@latest`**（现取 2026-10-06，本机 `pnpm 11.21.0`）：`pnpm add dsh-pet-seen`（等价 `@latest`）解析到的是 **`0.0.1`**，而 `pnpm add dsh-pet-seen@0.1.1` 装到的才是 **`0.1.1`**。测法（可复现）：一个空目录 + `pnpm-workspace.yaml`，`.npmrc` 分别写 `registry=https://registry.npmjs.org/` 与默认的镜像源各跑一次 —— **两次都解析成 `0.0.1`** ⇒ 是 pnpm 侧 resolver 的行为，**不是**源不同步（同一时刻 `npm view` 两个源都报 `latest = 0.1.1`）。列版本 `@0.1.2` 之类就不会被这一步拦住。
  - 装完**一定要核对装到的是哪一版**（判据见 §2.3 的「装的是哪一版」那行）—— 这一步是静默的，装错了不会报错。
  - **与上面两条的关系**：源码改不动、`git pull` 也无关；升级 = 换一个版本号再 `add` 一次（见 2.2）。想改源码就用 `link:` / `file:`。

### 2.1 桌面应用（Electron）—— 它读 `desktop` profile

**桌面应用 boot 的是 `desktop` profile，不是 `web`。** 按上面的 `--profile web` 装完，插件落在 `web` profile 里，而桌面窗口读的是 `desktop` profile ⇒ 表现是**界面上什么都没发生、也没有报错**。桌面端这样装：

- **应用内侧栏 Plugins 页**（不必退出宿主）：目标填本目录**绝对路径**，装完**必须点「立即启用」**—— 只装不启用时该 profile 的 `dsh.profile.bundles` 里没有它，宿主不会加载。它把本地目录记成 **`link:`**（Junction），与 CLI `file:` 的实体拷贝语义不同。**本仓库只实测过这一条路**。
- 两个宿主同时跑会抢控制端口 `17323` ⇒ **同一时刻只跑一个**。改端口也救不了：凭据文件 `~/.dsh/pet-bridge.json` 是全局单文件，桌宠一次只能连一个宿主。

### 2.2 升级：`git pull` 之后

- `link:` 安装：源码改了**不用重装**（运行期直接读工作树），但 ① 宿主半边 `lib/index.js` **只有重启宿主才会换**（`link:` 不保证热重载，实测）；② 页面半边由宿主自己重建。⇒ 拿到新源码后：`npm run build` → **重启宿主**。
- `file:` 安装是**硬链接镜像**，不是打包解包：就地改写会**穿透**进 `node_modules`，改名/重建会**断链并冻住那个文件** ⇒ `git pull` 后**必须重装**，只跑 `build` 修不好已断链的那一半。
- `registry` 安装：`git pull` 与它**无关**（profile 里那份来自 registry，不是本仓工作树） ⇒ 升级 = **换一个新版本号再 `add` 一次**（例：`dsh plugin add --profile web dsh-pet-seen@0.1.2`）→ **重启宿主**。同一条命令重复跑不会"顺手升级"（见 §2 那条写死版本号的说明）。
- 三条渠道都成立的一条：**宿主半边只有重启宿主才会换** ⇒ 任何升级的最后一步都是重启。
- 改了包名或版本号 ⇒ profile 里的依赖名与 `dsh.profile.bundles` 条目名都会变 ⇒ **必须重装**。

### 2.3 装完怎么确认：**两半分开看**

这个插件是**两个各自独立加载的产物**（`lib/index.js` 宿主半边、`client/client.js` 页面半边），所以"没反应"必须分开判。下表每行的判据都**只有那一半会写**：

| 看什么 | 判据 | 为什么是它 |
| --- | --- | --- |
| 装进 profile 了吗 | 该 profile 的 `dsh.profile.bundles` 里有 `dsh-pet-seen` | 只装不启用时这里没有它，宿主不会加载 |
| 装的是哪一版 | `bridge-state.mjs` 头部行的 `plugin=<版本>` —— 与**你这次安装命令里写的那一版**逐字相同（`npm view dsh-pet-seen dist-tags.latest` 只是查最新版是多少，**不是**判据） | 走 registry 渠道时"我装到的是哪一版"最容易静默装错（`add dsh-pet-seen` 现取会解析成 `0.0.1`，见 §2）⇒ 这一行是**唯一**直接读数 |
| 宿主半边起来了吗 | `~/.dsh/pet-bridge.json` 存在，且 `controlPort` 就是你配的 `17323` | **只有宿主半边会写**这个文件；token 每次宿主启动轮换 |
| 宿主半边状态可读吗 | `node tools/bridge-state.mjs` 打出头部行（形如 `controlPort=17323 … plugin=0.1.1 build=<16 位>`） | 它自己读文件里的 token 去问 `/state`，不必手抄 token |
| 页面半边在报吗 | `/state` 的 `browserTabs` 里有你那个 tab 的行，且带 `reader=` 与 `build=` | **只有页面半边会报**这两条；行随 15 s 租约过期，"没有行"= 页面没在报，不等于没装 |
| 两半是同一个构建吗 | tab 行的 `build=` == 头部行的 `build=` | 一次构建必然同 id；两者不同 ⇒ `MIXED`，该 tab 从未报过 ⇒ `OLD`；`npm run probe:http` 把两者都判 FAIL |

**这一个代码块里，第一条与第二条要你手上有仓库**（`node tools/bridge-state.mjs` 与 `npm run probe:http` 都读仓里的文件/脚本，而 `tools/` 不随包发布，见 §6 末条）；走 registry 渠道的话看第三条 —— token 在 `~/.dsh/pet-bridge.json` 里，自己问 `/state` 就能同时拿到 `pluginVersion` 与 `buildId`。

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

本节是**契约的正文**：要实现的入站端点只有一个（`POST /event`），要调的接口三个（`/hello` / `/state` / `/ack`），字段、状态机与失败码都在这里。

> **证据等级**：这份契约**够不够写出一个接收端**是【实测】—— 本仓的第二个接收端只按本节 + `protocol/bridge-v1.schema.json` 写成，真机四条链路（握手 → 收结果事件 → `/state` 对齐 → `ack shown`）成立，另有一份抓线上真实字节逐条过 schema 的校验器。**没有取得的是"第三方独立接入"**【推断】—— 写它的人与本插件同源，真正的外部接收端至今没有一个。⇒ 本节承诺的是"照它接上了"，不是"别人已经照它接上了"。那份接收端与两条校验命令都在仓内 `tools/` 里，**不随包发布**（见 §5）。

**但它不是"你的桌宠唯一需要读的东西"** —— 有两件事按"一处一写"留在了本节之外，这里只给去处、不重复：

| 你还缺什么 | 去处 |
| --- | --- |
| 你自己的监听端口：默认值多少、握手之后以谁为准、端口在配置里的位置 | [§3 配置](#3-配置) 的 `petPort` 那行 |
| 装到哪个 profile、`link:` 与 `file:` 的升级语义有何不同 | [§2 安装](#2-安装) |

**契约没有写明、由你自己定**：监听端口被占用怎么办；同一台机器上多个桌宠同时握手怎么收场（`/hello` 是把端口记成**单槽**的，后一次握手覆盖前一次，没有投票或回退规则）。本仓的参考接收端选择的是"监听失败即明确报错退出、不静默换端口，并上报实际 bind 到的端口"—— 那是它的选择，不是协议要求；照你的实现写清楚即可。

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

归一化事件：`idle` / `running` / `completed` / `error` / `notice/seen`。`id` 全局唯一，**按它去重**；`sessionId` / `runId` / `targetTurnRef` 用来把你的提示归到正确的会话。

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

**接收端要回什么**（宿主**只判状态码是不是 2xx**，body 里的键只给人和日志看）：

| 情况 | 状态码 | body |
| --- | --- | --- |
| 收下 | 200 | `{ "v": 1, "ok": true }` |
| **重复 `id`**（同一事件又投了一次） | **200** | `{ "v": 1, "ok": true, "duplicate": true }` |
| body 不是 JSON 对象 / 缺 `id` / 不是合法 JSON | 400 | `{ "v": 1, "ok": false, "reason": "…" }` |
| body 超过 64 KiB（[§4.5](#45-安全)） | 413 | `{ "v": 1, "ok": false, "reason": "body too large" }` |

**重复一律回 `200`，不得用非 2xx 表达。** `409` / `404` 之类看着更像"冲突"或"没见过"，但宿主的判据只看状态码：非 2xx ⇒ 这一次推送算**未投递**（`src/pet-client.ts`），那条通知留在 `pending`，"看到即取消"当场断链。去重是你自己的事：重复只记日志，不改状态、不重弹、不重 ack。只有"这条我永远处理不了"（body 读不懂、没有 `id`、超限）才回 4xx。

### 4.2 桌宠 → 插件（控制端口）

```http
POST /hello { "v": 1, "petVersion": "…", "port": 17322, "token": "…",
              "protocol": { "min": 1, "max": 1 }, "capabilities": ["events", "ack-shown"] }
             # 响应：{ v, ok, revision, petPort, capabilities, agreed, legacy?, petVersion? }
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

**`sessions[]` 与 `notices[]` 每行的字段**（上面那张表只列顶层键）见 `protocol/bridge-v1.schema.json` 的 `SessionProgressSnapshot` / `NoticeSnapshot`：会话行有 `title` / `cwd`（工作目录，隐私口径见 [§4.4](#44-隐私边界)）/ `running` / `runId` / `lastTurnEnd` / `toolCalls` / `lastTool` / `todoCount` / `completedTodoCount` / `percent` / `reader`；通知行有 `noticeId` / `runId` / `reason` / `state` / `delivered` / `seenAt`。

握手文件写在 `~/.dsh/pet-bridge.json`（权限 0600）：

```json
{ "v": 1, "controlPort": 17323, "token": "<每次进程启动轮换>", "writtenAt": "…" }
```

启动顺序任一侧先起都可以：桌宠先监听自己的端口，重试 `/hello`，成功后拉 `/state` 按 `noticeId` 对齐本地提示。插件每次重启轮换 token，桌宠认证失败后重读文件再握手。

`shown` 只表示桌宠**已实际显示**，不能从 HTTP POST 成功推断 —— 而且只有真声明了 `ack-shown` 的桌宠才谈得上这一条（见下）。

#### 4.2.1 能力协商

两个方向都可省。**省 ≠ 空**，这是本节唯一必须记住的一条。

| 字段 | 方向 | 含义 |
| --- | --- | --- |
| `capabilities` | 桌宠 → 插件 | 你实现了哪些能力。**整个字段省略 = 旧桌宠**（响应里给 `legacy`）；`[]` = 明确声明"一个都不实现"。两者是不同的读数 |
| `protocol` | 桌宠 → 插件 | 你能说的协议版本区间（含两端）。写坏只是被忽略，不会让握手失败 |
| `capabilities` | 插件 → 桌宠 | 插件支持的能力全集（**广告**，不是"你会做"） |
| `agreed` | 插件 → 桌宠 | 插件**真正会依赖**的交集；旧桌宠拿到 `[]` |
| `legacy` | 插件 → 桌宠 | 只在请求没带 `capabilities` 时出现 |
| `petVersion` | 插件 → 桌宠 | 回显你报的版本（你报了才有） |

| 能力 | 含义 |
| --- | --- |
| `events` | 收 `POST /event`（事实上每个桌宠都有） |
| `state-sync` | 拉 `GET /state` 并按快照对齐本地提示 |
| `ack-shown` | 用 `/ack action=shown` 回报"提示真的上屏了" |
| `ack-dismissed` | 用 `/ack action=dismissed` 回报"用户手动关了" |
| `notice-seen` | 认得 `notice/seen` = "撤掉那条提示" |

**降级语义 —— 缺能力不阻塞接收**：

- 什么都不声明 ⇒ 握手照旧 200、事件照旧推；插件**不得**把你当成会回报 `shown` 的端。`agreed: []` 就是这句话的机器可读形式。
- 声明了子集 ⇒ 只有交集中的能力会被依赖；没声明的按"没有"处理。
- 未知能力名 / 未知字段 / 写坏的 `protocol` ⇒ **忽略**，不报错。新能力只有这样才能在不升协议版本的前提下加进来。
- 与"认不出的 `reason` 要给中性文案"（§4.4）是两件事，互不影响。

**契约的机器可读副本**：`protocol/bridge-v1.schema.json`（随包发布，`files` 里有它）。它列了每个消息的必填/可选字段、封闭枚举、未知字段规则，以及事件名的**完整**枚举 —— 这个 enum 就是全部词表，没有"预留却永不发"的第二组（`session/removed` 曾以 `reserved` 名占位，运行时探针证明它没有可触发面后已被撤销，见 §4.1）；本节的散文与它由 `tests/negotiation.test.ts` 逐条对锁 —— 只改一边会红。

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

v1 **只发**：事件名、`sessionId`、会话标题（可关、截断 160）、**会话工作目录 `cwd`**（截断 4096；只出现在 `/state.sessions[]` 里，事件流里没有它；**目前没有开关**，`includeTitle` 管不到它）、工具**名**、进度计数、有界状态文案。

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

三条容易漏掉的事实（它们决定你该怎么读这份契约）：

- **缺 `Origin` 的回环请求按同源放行**：判定是「`Host` 必须是回环名（`localhost` / `127.0.0.1` / `[::1]`）；`Origin` 缺席或为空 ⇒ 放行；带了 `Origin` 则其 host 必须回环、port 必须与 `Host` 逐字相等」。⇒ 本机上不带 `Origin` 的客户端（`curl` 之类）够得着 `/pet-bridge/*` 的**只读**面：`/notices` 会把待确认通知的 `noticeId` 给它。但**"读到"不等于"退休"** —— `/seen` 另有上面那条里的四项核对，缺一不可。
- **插件 → 桌宠的 `POST /event` 没有凭据**：token 保护的是反方向（桌宠 → 插件，见上面 token 那条）。⇒ **任何本机进程都能往你的桌宠端口投事件**。你的防线在接收端这一侧：按事件 `id` 去重、按 `noticeId` 建/撤提示（§4.1），并自行决定要不要只信回环来源。
- **L3 只看几何、不看遮挡**：判定是「结果行与可视带的矩形交集 + 连续停留 ≥ `seenDwellMs`」，被别的元素盖住**照样算看到**（§1.2）。⇒ 它证明的是"有机会看到"，不是"看到了"。这是设计选择：更严的判定（例如拿 `elementFromPoint` 探一下）会在吸顶标题与输入框遮罩上抖动，而误判会复活"提示被静默吞掉"这个插件存在的第一理由。

---

## 5. 开发

```powershell
npm run typecheck       # 对着仓库自己 pin 的 harness 声明类型检查（见 §5.2）
npm test                # 编译测试 + 跑全部单测/集成测试（末行打印实测条数）
npm run build           # 两个 bundle（lib/index.js、client/client.js）
npm run smoke:bundle    # 加载真实产物：纯净性、manifest、产物卫生、构建标识
npm run check:artifacts # 判定「HEAD 里的产物 = 源码产物」（在 build 之后跑）
npm run probe:http      # 探针：web 资产 + 控制面；陈旧半边、两半不同构建与漂移都判 FAIL
npm run roundtrip       # 离线跑通全链路（不碰运行中的 DSH）
npm run acceptance      # 真机 CDP 验收（一次只跑一个宿主）
npm run auth:check      # 离线自检验收驱动能不能认到 WebServer（无 cookie 401 / 自铸 cookie 200 / 篡改 cookie 401）
npm run mock-pet        # 假桌宠：收事件 + 交互 ack（seen/dismiss/state/quit）
npm run receiver:check  # 最小接收端（tools/min-receiver.py）的离线检查（要 python；故意不接进 check）
npm run wire:check      # 抓真 lib/index.js 的线上字节，逐条过 protocol/bridge-v1.schema.json（故意不接进 check）
npm run compat:0.2.0    # 对着 0.2.0-rc.2 的声明再查一遍（要联网，故意不接进 check；见 §5.2）
npm run check           # typecheck → build → smoke:bundle → check:artifacts → test（唯一闸门）
```

### 5.1 产物入库与一致性闸门

`lib/`（宿主侧）与 `client/`（浏览器侧）**入库**，克隆即可安装（见 §2）。代价是必须保证 "提交的产物 = 源码产物"，这条靠机制而不是靠人记得：

- `npm run check:artifacts` = `git diff --exit-code HEAD -- lib client`，**在 `build` 之后跑才有意义**：它比的是"刚从 `src/` 重建出来的产物"与"HEAD 里那份"。**红 ⇒ 当前源码的产物还没进 HEAD**（改了 `src/` 却没连产物一起提交；产物被手改也在这里被抓）。
- 改了 `src/` 的提交**必须**带重建后的产物；`prepack` 保证 `npm pack` / `npm publish` 前先重建。
- `smoke:bundle` 还断言产物里**没有探针残留**（denylist：`tamper-probe` / `probe-residue`）与**没有本机绝对路径**（`C:\Users` / `C:/Users` / `star_fox` / 仓库名 / `file:///`）。⇒ 往产物追加一行做伪造探针时，**那一行必须含 `tamper-probe`**，否则闸门认不出来、等于没打探针。

### 5.2 类型检查对着**哪份** harness 声明

`tsconfig.check.json` **不写 `paths`**：`@deepseek-ai/dsh-session`、`dsh-agent`、`cordis`、`schemastery` 由仓库自己的 `devDependencies` 提供（现取 pin 的是 **`0.2.0-rc.2`** 线），所以**机器上没有任何 DSH 安装、一个干净克隆**照样能跑 `npm ci && npm run check`。这现在是硬要求而不是偏好：CI 上没有宿主可指（见 §6）—— 一旦把类型检查退回本机 profile 路径，CI 必红。

`tsconfig.compat-0.2.0.json` 不再自己指任何路径（它 `extends` 上面的配置）：主 `check` 已经是同一条 `0.2.0-rc.2` 线，它只是把"这份声明"再查一遍；**故意不接进 `npm run check`** —— 它要联一次网，属"在线闸门"。它**红**才是重点：`src/pins.ts` 的 `_ReasonsCovered` 会在宿主新增 `turn/end` kind 时直接编译失败。

⚠️ **覆盖面的代价**：活 `web` profile 跑的是 `0.1.5` 线，而基准 `check` 是 `0.2.0-rc.2` ⇒ **那条线目前没有栅门**（`0.1.5` 线装不进 `devDependencies`：内部 peer 互不相容；要守它只能相对遍历指活 profile）。范围口径见 §2.4。

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

- **测试怎么跑**：`npm test` = `npm run build:test` + `node tools/run-tests.mjs`。运行器把测试文件显式列出，并**按当前 Node 线探测单进程开关**：Node 24 认 `--test-isolation=none`，Node 22 只认 `--experimental-test-isolation=none`（喂它稳定名会直接 `node: bad option: --test-isolation=none` + exit 9，压根不读测试文件），两条线都不认时退回默认的逐文件隔离。**为什么非要单进程**：默认的逐文件子进程走 `stdio: 'pipe'`，受限沙箱里会 `EPERM`。**用例条数会随版本变，别背它** —— 判据是每次跑完末行打印的实测条数（`tests <n>` 与 `pass <n>` 相等、`fail 0`）；CI 上两条 Node 线各跑一次，**CI 才是那条线的权威读数**。
- **DOM face 每次判定都重新解析**：L3 依赖 `[data-chat-flow]` 与 `[data-conversation-scroll]`，而 harness 每次切换会话都会重挂载会话槽 ⇒ `createVisibilityDeps()` **每次读取时重新 `query`**。存成值会在第一次切换后变成死引用（矩形测量全 0 ⇒ `isTurnVisible()` 恒 false ⇒ 页面此后**永远不发 `/seen` 且不打日志**，只有刷新才恢复）。

## 6. 发布与 CI

发布走 **GitHub Actions + npm Trusted Publishing（OIDC）**：workflow 里**没有任何 npm token**，凭据由 GitHub 的 OIDC token 现场换取。npm 侧只需要绑一处 —— 在 npmjs.com 的包设置里把 **Trusted Publisher** 指向本仓：仓库 `starwithfox/dsh-pet-seen`、workflow 文件名 **`publish.yml`**、environment 留空（**文件名改了要重新绑定**）。

两个 workflow 的分工是固定的：`.github/workflows/ci.yml` 在 push 到 `main` 与每个 PR 上跑 `npm ci` → `npm run check`，Node `22.x` 与 `24.x` 各跑一次（`engines` 声明的就是这两条线）；`.github/workflows/publish.yml` 在**发布 Release（published）**或**手动 dispatch** 时跑：**先读本提交的 `ci` 结果**（不是全绿就当场失败）→ `npm ci` → `npm run check` → 校验 tag 与 `package.json` 的 `version` 一致 → `npm publish`（`prepack` 会先 `npm run build`，所以包里带的是刚重建的两半产物）。

**顺序不能换：先 push、等 `ci` 全绿，再触发发布。** 这不是提醒而是硬闸门 —— publish job 的第一步就是读该提交的 ci 检查结果，`check (22.x)` / `check (24.x)` 有任何一条不是 `success`（或者这个提交还没有结果），发布直接失败。发一个新版本：
① 改 `package.json` 的 `version`；② `npm run check` 必须绿，改了 `src/**` 就要把重建后的 `lib/` 与 `client/` 一起提交（见 §5.1）；③ push 到 `main`，**等 `ci` 两个 matrix 都绿**；④ 在 GitHub 发 Release，**tag 用 `v<version>`**（例如 `v0.1.1`）—— publish job 会拿 tag 与 `version` 对照，不一致直接失败（发错版本不可逆：npm 的撤回窗口只有 72 小时）；⑤ 等 `publish` 绿，`npm view dsh-pet-seen@<version>` 应能查到。

发布只从 CI 走：`npm publish` **不要在本机直接跑** —— 本机 registry 默认是只读镜像，发布走不通，而 OIDC 这条路径本来也不需要任何长期 token。

CI 上**没有 DSH 安装**，所以类型检查只能对着仓库自己 `devDependencies` 里 pin 的 harness 声明跑：`tsconfig.check.json` 不写 `paths`，干净克隆 `npm ci && npm run check` 即可。这也是"别把类型检查退回本机 profile 路径"的原因 —— 一退回去，CI 必红。

**CI 绿不等于所有宿主版本都验过**：`npm run check` 覆盖的是 `devDependencies` pin 的那条线；`compat:0.2.0` 需要联网，**故意不接进** `check`；活 `web` profile 跑的那条 `0.1.5` 线目前**没有栅门**（范围口径见 §2.4）。

包内容不因 CI 改变：`files` 是 `lib`、`client`、`protocol`（§4 那份 `bridge-v1.schema.json`）、`cordis.patch.yml`、`README.md`、`LICENSE`；`src/`、`tests/`、`tools/` 与 `.github/` 都不随包发布。

## 7. 目录

```
├── package.json          # dsh.bundle.patch + dsh.client.{platform,inject}
├── cordis.patch.yml      # 把插件挂进 profile loader 树 + 默认配置
├── tsdown.config.ts      # 宿主 ESM bundle + 浏览器 CJS 工厂 bundle
├── lib/, client/         # 【入库】两半产物，tsdown 生成，勿手改
├── protocol/             # 【随包发布】bridge-v1.schema.json：§4 契约的语言无关副本
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
└── tools/                # build-id、mock-pet、roundtrip、smoke-bundle、probe-http、CDP 验收驱动、
                          #   min-receiver（第二个接收端：只按协议一节 + schema 写成）、
                          #   validate-bridge-wire（它抓的线上字节逐条过 schema）
```

## 8. 许可与范围

- **本包（`dsh-pet-seen`）是 MIT，著作权归 `starwithfox`**：正文见 `LICENSE`，且随包发布（`npm pack` 会带你核到）。
- **范围声明**：本包**只含 DSH 插件侧** —— `lib/`、`client/`、`protocol/`（含 §4 那份 `bridge-v1.schema.json`）、`cordis.patch.yml`、`README.md`、`LICENSE`（即 `package.json` 的 `files` 清单）。
- **另一侧（你的桌宠接收端）不在本包内**、也不随本包分发：它是你自己的程序，实现方式与许可证都由你定；本包只承诺 §4 那份协议。
