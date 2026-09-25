# DELIVERY-ROUND2 — D1~D5 修复 + 浏览器侧可执行测试环境

> 写于 2026-09-25（本地）。
> 执行 `PLAN-ROUND2.md` 的 §1（修复插件）与 §2（离线门禁）。
> §3 真机验收与 §4 `pet.py` **尚未执行** —— 见 §6。
> 前序记录：`DELIVERY-ROUND1.md`（实现）、`HANDOFF-ROUND2.md`（真机验证）、
> `HANDOFF-ROUND2-ADDENDUM.md`（Test Y 定案 + D1 根因）。

---

## 1. 一句话结论

`PLAN-ROUND2.md` §1 的五项（D1→D4 + dwell 同步）**已全部实施**，并为浏览器侧建立了
可执行的 DOM 测试环境（这是 ROUND 1 缺失、D1 因此溜过去的那一环）。
`npm run check`（含 **78/78** 单测）与 `npm run roundtrip`（**11 步**）全过。
**真机 Gate A / Test Y / Gate C / 反例尚未复跑**，所以本轮不是"完成"，而是
"离线部分完成、等真机验收"。

---

## 2. 改了哪些地方

| # | 缺陷 | 位置 | 做法 |
| --- | --- | --- | --- |
| D1 | L3 锚错元素 | `src/client/visibility.ts` | 不再用"第一个 `[data-chat-turn]` 匹配"，改为按 **flow kind** 找该 turn 的**结果项** |
| D2 | `shown` 对页面失明 | `src/state.ts` `pendingFor()` | 返回**非终结**状态（`pending` + `shown`），只排除 `seen` / `dismissed` |
| D3 | 最老通知挡住新通知 | `src/client/decide.ts` `selectWatchTarget` | 优先选**已渲染且结果项可见**的通知；全都不可见时才退回最老那条 |
| D4 | 拒报即永久拉黑 | `src/client/index.ts` + `decide.ts` | 区分**暂时拒绝**（可重试）与**终结拒绝**（停止）；重试前先刷新焦点租约 |
| D5 | dwell 写死 1500 ms | `src/client/index.ts` `resolveDwellMs` | 采用 `/notices` 广告的 `seenDwellMs`（非法值回退默认）；阈值变化时**重开计时** |

顺带按 addendum §5 的建议收敛请求节奏：`/notices` 查询加 500 ms 下限
（实测原来是 ≈2 次/秒）。

### 2.1 D1 的实际规则（与 addendum §4.6 的建议不同，理由在此）

addendum 建议"取高度最大的那个匹配项"。**没有采用**，因为 `PLAN-ROUND2.md` §1.1
明确说"不要把'高度最大'当成通用语义规则"，而且它过不了本轮要求的两个用例。
实际规则是**按语义分组、按优先级取第一个已渲染的组**：

```
RESULT_KINDS = ['assistant-step', 'turn-error', 'turn-max-tokens']
  1. assistant-step   —— 回复正文（turn-process 展开时是每一步一个 item，取并集）
  2. turn-error / turn-max-tokens —— 没有正文时，失败原因就是该 turn 的结果
  3. 都没有 —— 退回"该 turn 所有 item 的并集"（保底，不为空才用）
```

**为什么这是"回复正文"而不是猜**：`data-chat-flow-kind` 是上游**自己注册**的
`conversation.chat.node` 键，取值集合可从已安装产物里读出来：

```
$ node -e "…registerChatNodeRenderers…key:\"…\"…"
conversation.chat.node kinds:
["user","steering","context","system-prompt","assistant-step","command",
 "manual-compaction","compaction","model-retry","turn-error","turn-max-tokens",
 "turn-process","turn-tail","unknown"]
```

（来源：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`）

回复正文就是 `assistant-step`（`AssistantNodeView`）。`turn-process` 则**不是**结果
——它是可折叠的过程披露，其成员是 reasoning / tool-call，与"完成通知"无关。

**为什么用"并集"而不是"最大的那一个"**：一个长回合在过程展开时会有多个
`assistant-step`。用户读第 2 步时人就在该回合的结果里，取并集正好表达
"用户有机会看到这个结果"；取单项则会在步骤边界上抖动。

**为什么它能过用例 (i)**：正文在屏外而 turn 头在屏内时，`assistant-step` 组
**存在但零交集** ⇒ 不报 `seen`。这正是 addendum 说的"滚到结果 ≠ 被检查的元素可见"
要修掉的那个反例。

**保底与降级**：一个结果组"一个已渲染成员都没有"时被跳过（所以折叠/零高度的正文
不会把屏外的 turn 报成已看），继续往下试；`turnItems` 取不到任何 item ⇒ 不报 `seen`。
上游若不再发 `data-chat-flow-kind`，第 1、2 步落空、第 3 步接住，最坏退化为
"该 turn 任一 item 可见"，即**偏宽松**而非失效——这一点是**有意的取舍**，因为
保守方向（漏取消）正是本轮要修的病症。

### 2.2 D4 的机制（这里踩到并修掉了一个新坑）

`reportSeen()` 现在是：

```
暂时拒绝（no-effective-lease / tab-not-on-session / 根本没收到响应）
  → tracker.rearm()：重开计时，下次连续达标再报一次
终结拒绝（already-dismissed / unknown-notice / run-mismatch / session-mismatch
         / observed-flag-missing / incomplete-observation）
  → 记住 noticeId，本页不再重试
```

**坑（本轮实测踩到）**：一开始把"最小重试间隔"放在 `reportSeen()` 入口判断，
结果是**死锁** —— tracker 已经把自己的 `reported` 置位，而 `reportSeen` 因为
间隔没到直接 `return`，既没重试也没 `rearm`，于是这条通知**再也报不出去**。
实测时序：第一次上报 632 ms 失败，第二次 1255 ms 被间隔挡掉，此后 5 秒内
一个请求都没有。

**修法**：把"节流"上移到 tracker 的**开火判定**（新增 `canReport` 注入点）。
被节流挡下的上报**不消耗** dwell 状态，下次评估继续问。修后实测重试间隔
2.2 s / 2.2 s，符合设计。这一条已写成单测（`retries a transport failure until it lands`）。

---

## 3. 浏览器侧测试环境（`PLAN-ROUND2.md` §1「测试接线」）

ROUND 1 的 37 项测试**全是宿主/协议侧**，`tsconfig.test.json` 当时
`exclude: ["src/client/**"]` —— 所以 D1 能溜过去。

现在：

- `tsconfig.test.json` 加 `DOM`/`DOM.Iterable` 并**纳入 `src/client/**`**；
- `npm test` 从 3 份测试文件扩到 **6 份**；
- 新增 `tests/client-fixture.ts`（手写 DOM 替身）、`tests/visibility.test.ts`、
  `tests/decide.test.ts`、`tests/client.test.ts`；
- **测试调用的是出货代码**：`isTurnVisible` / `VisibilityTracker` / `selectWatchTarget`
  / `classifySeenOutcome` / `resolveDwellMs` 直接被测；除 `client-fixture.ts` 这个
  DOM 替身之外没有复制任何判定规则。

**为什么手写替身而不是 jsdom**：可见性判定需要**几何**，而任何没有排版引擎的
DOM 库（jsdom/linkedom/happy-dom）`getBoundingClientRect()` 一律返回 0，
反而必须把几何再打补丁进去——那就没有任何好处。替身只实现插件真正用到的
选择器子集，**遇到别的选择器直接抛错**（未知选择器是测试写错了，不该静默命中 0 个）。

覆盖的用例（对应 `PLAN-ROUND2.md` §1.1 点名的那几个）：

| 用例 | 断言 |
| --- | --- |
| 前项在屏内、正文在屏外 | **不**可见 |
| 正文在屏内、前项在屏外 | 可见 |
| 同一个 turn 多个 item | 取结果组并集 |
| 零尺寸占位 / 折叠 | 不可见，且不误用为空组 |
| 不同 turn | 互不串味 |
| 未渲染的 turn | 不可见 |

---

## 4. 离线门禁结果（实跑）

```
$ npm run check
  typecheck（host + client + tests 三份 tsconfig）      ok
  build (tsdown)                                       ok
  smoke:bundle           5/5                           ok
  npm test               78 tests / 78 pass / 0 fail    ok

$ npm run roundtrip
  1. handshake                                  ok
  2. completion pushed                          ok
  3. pet ack (shown)                            ok
  4. cross-origin refused                       ok
  5. visibility lease reported                  ok
  6. open notice query  (pending + shown)       ok   ← D2
  7. L2-only report refused                     ok
  8. lease-less report refused                  ok
  9. seen accepted -> pet cancels               ok
  10. repeated observation is a no-op           ok
  11. seen notice withheld                      ok   ← 新增：seen 后必须离开页面列表
```

`roundtrip` 第 6 步是本轮**改过断言**的：原来断言"只返回未确认的那条"，
现在断言 `pending` 与 `shown` **都在**、且顺序为最老优先。

产物核对：`client/client.js` 含 `assistant-step` / `data-chat-flow-kind` /
`canReport` / `setDwellMs` / `seenDwellMs`，**不含** `isTurnRowVisible`；
无新增运行时 import（`smoke:bundle` 第 3 项仍过）。

---

## 5. 真机侧已做的（只读，未动 profile）

本轮**没有**重启 DSH、没有刷页面、没有改 `~/.dsh/profiles/**`。

| 项 | 结果 |
| --- | --- |
| profile 里的插件是不是仓库本身 | **是**：`profiles/web/node_modules/dsh-pet-bridge` 是 `file:` 直装，`package.json` 指向 `file:.../dsh-plugin` |
| `/state` 可读、`browserRoutes=true` | **是**（`revision=493`） |
| `/pet-bridge/notices` | `200`，带上 `seenDwellMs: 1500` |
| `/state` 里 `pending` 与 `seen` 并存 | **是**：`208a7491`/`e8fe29ef` = `pending`，`ae73a6e6`/`39c54638` = `seen` |

> **一条更正（很重要，别被误导）**：早先我用"profile 里的 `lib/index.js` 与仓库
> 构建产物 SHA256 相同、时间戳也相同"推断"运行中的宿主已经在跑本轮代码"——
> **这个推断不成立**。从 bridge 文件的 `writtenAt`（11:29:59）可知 DSH 进程启动于
> 我的改动之前，而模块在启动时已加载进内存；磁盘上的文件后来被重新构建，
> 两者一致只说明"文件一致"，不说明**进程内存里**是哪个版本。
> 结论：**宿主侧改动要重启 DSH 才生效**（客户端要重建 + 强刷页面），
> 这也是下面"真机验证尚未做"的前提。

另外，`/state` 与 `/pet-bridge/notices` 都**不带** `state` 之外的新字段，且当前
没有处于 `shown` 的通知，所以"D2 在真机上可观测"这条**还没有真机直证**，
只有离线 roundtrip 第 6 步在证。

**为此本轮顺手补了一个可观测性改进**：`/pet-bridge/notices` 的每条通知现在带上
`state`（`pending` / `shown`）。原先浏览器侧的 payload 里**没有**这个字段，
只能靠"数量差"间接判断；加上之后：
`(Invoke-WebRequest ".../pet-bridge/notices?sessionId=..." -UseBasicParsing).Content`
一眼就能看出"这条是已弹出的还是从未送达的"，Test Y 的判读不再依赖推断。

---

## 6. 还没做的（诚实清单）

| 项 | 状态 |
| --- | --- |
| Gate A（短/长回复滚到正文后变 `seen`；只看 turn 头不取消） | **未跑** |
| Test Y 回归（ack `shown` 后仍能在 `/notices` 取回 → 看结果 → `notice/seen` → CANCEL） | **未跑** |
| Gate C（跨会话不被吞 + 旧 turn 屏外、新 turn 可见） | **未跑** |
| 反例四条（屏外/折叠、失焦、别的会话、`dismissed` 后重看） | **未跑** |
| §4 `pet.py` 接入 | **未开始** |
| `pet-bridge.json` DACL 收紧 | **未做** |
| V2（`idleGraceMs=1500` 标定）、多标签页租约裁决 | **未做** |

真机验收需要：重建（已做）→ **重启 DSH**（宿主侧改动生效）→ **强刷页面**
（客户端改动生效）→ mock pet 重读 token 并握手。按 `PLAN-ROUND2.md` §3，
这四项通过后才进入 `pet.py`。

---

## 7. 本轮新增的坑（请 ROUND 3 / 复查者别重复踩）

1. **`[data-chat-turn="N"]` 在同一个 turn 上命中几十个元素**，第一个是小起始项
   （h=78~210），回复正文是后面的 `assistant-step`（h=1428~2949）。任何按该属性
   做几何判定的代码都必须显式说明"取哪一个"。
2. **`data-chat-flow-kind` 才是"这一项是什么"的可靠语义**，取值见 §2.1 的 14 个键。
   `turn-process` **不是**结果，是可折叠过程披露。
3. **注意 trap 与 dwell 的交互**：节流放在"上报入口"会和 tracker 的 `reported`
   围栏**互相死锁**，把通知永久锁死。节流必须放在"是否开火"这一层（见 §2.2）。
4. **dwell 是惰性起算的**：`dwellStartedAt === null` 时，**那一次 `update()` 只是
   把时钟归零**，`dwellMs` 报 0。写测试时"重置后立刻 advance 到阈值"会差一拍。
5. **`/state` 的 `completedAt` / `seenAt` 是 epoch ms 数字**，`targetTurnRef` 是字符串。
   用 `[datetime]` 直接转会当成 ticks（详见 addendum §2）。
6. **本机 PowerShell 的 TLS 栈连不上 registry.npmjs.org**（SSL 握手失败），
   但 Node 的 `fetch` 可以 —— 需要联网装包时换 Node/python 客户端，别改系统配置。

---

## 8. 本轮文件改动

**源码**

- `src/client/visibility.ts` —— 重写测量核心（D1）；`VisibilityDeps` 改为可注入的
  `{document, flowElement, scrollElement, viewportHeight, rectOf}`；
  `VisibilityTracker` 增加 `setDwellMs` / `isTurnOnScreen` / `rearm` / `canReport`。
- `src/client/decide.ts` —— **新增**，页面侧的纯决策（D3/D4/D5）。
- `src/client/index.ts` —— 改接到 `decide.ts`；租约先刷新后上报；dwell 跟随宿主；
  `/notices` 查询 500 ms 下限；`reportSeen` 区分暂时/终结拒绝。
- `src/state.ts` —— `pendingFor()` 纳入 `shown`（D2）+ 更正误导性注释。
- `src/routes.ts` —— `/notices` 处补一句说明为什么 `shown` 也在列表里；
  payload 增加 `state` 字段（可观测性）。
- `src/protocol.ts` —— `PendingNotice` 增加 `state`。

**测试与工具**

- `tsconfig.test.json` —— 纳入 `src/client/**`，加 DOM lib。
- `package.json` —— `test` 脚本扩到 6 份测试文件。
- `tests/client-fixture.ts`、`tests/visibility.test.ts`、`tests/decide.test.ts`、
  `tests/client.test.ts` —— **新增**。
- `tests/state.test.ts` —— D2 那条测试改为断言 `pending` + `shown`。
- `tools/roundtrip.mjs` —— 第 6 步改断言，新增第 11 步。
- `tools/probe-client-page.js` —— 量测改为新版规则，并**同时打印旧规则**的读数
  （便于真机上一眼看出差异）；仍为只读，绝不上报 `/seen`。

**未改动**：`~/.dsh/profiles/**`、`DESIGN-dsh-pet-plugin.md`、`pet.py`、
`harness_status.py`、`DELIVERY-ROUND1.md`、`HANDOFF-ROUND2*.md`、
`PLAN-ROUND2.md`（历史记录保持原样）。
