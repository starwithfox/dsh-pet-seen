#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-pet-seen "blind receiver" —— 仅凭一份协议文档实现的接收端（协议 v1）。

写作时只读过：
  * README.md  第 4 节「协议」（`## 4. 协议` 到 `## 5. 开发` 之前）
  * protocol/bridge-v1.schema.json

本文件里所有文档没说、只能猜的地方，注释都写成 `GUESS:`，并且逐条汇总在 GUESSES.md。
没有打开过仓库里任何别的文件（没有看 src/、没有看任何现成实现）。

它能做的事（对应文档要求）：
  1. 在本机监听 `POST /event`（默认 127.0.0.1:17322，可用 --port 改）；
  2. 读握手文件（默认 ~/.dsh/pet-bridge.json）拿 controlPort 与 token；
  3. `POST /hello` 握手（报端口 / token / protocol / capabilities）、`GET /state` 对齐、`POST /ack` 回报 shown；
  4. 有一个真的"上屏面"：终端面板，每次变化重绘，并在把提示画上屏**之后**才回报 shown；
  5. 按事件 id 去重；按 noticeId 建/取消提示；重复或乱序的 notice/seen 不会重建已关闭的提示。

只用标准库。
"""

# ---------------------------------------------------------------- 派生说明（PL-TS-NW-03 T2）
#
# 本文件是 PL-TS-NW-03 判据 ① 的交付物，由 ⑤「盲测读者」写出的版本**派生**而来：
#   * 冻结原件（逐字保留，作为 ⑤ 的证据，不许改）：
#       working-docs/misc/PL-TS-NW-03-blind-receiver-2026-10-06/receiver.py
#   * 相对原件的改动（只有两处，其余逐字未动 —— 包括所有 `GUESS:` 注释与它们的理由）：
#     1) T2：两个协议外只读路由（`GET /health`、`GET /__debug/state`）改成只在显式
#        `--debug` 时挂载 ⇒ 缺省配置下入站端点只有 `POST /event` 一个，与 README 协议
#        一节那句「要实现的入站端点只有一个」一致；`--debug` 是 T3/T4 抓线上真实字节
#        用的仪器，宿主永远不调它。
#     2) T3：加 `--log <路径>`，由**本进程**以 UTF-8 落一份面板日志。理由见 `_Tee`：
#        真机上用 shell 的 `Tee-Object` 会把面板中文解成乱码，并**不可逆地**写进文件。
#
# 依赖面纪律（判据 ① 的本体）：不 import 本仓 `src/` / `lib/` / `client/` 的任何模块，
# 不读 `~/.dsh/sessions/**`。只用 Python 标准库。

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlsplit

# ---------------------------------------------------------------- 常量 / 猜测

PROTOCOL_V = 1
NEUTRAL_TEXT = "运行结束"                 # README §4.4：认不出的 reason 给中性文案

# GUESS: 文档只写 <petPort>，§4.2 的例子写 17322。桌宠自己的端口从哪来文档没说，
#        于是默认取例子里那个值，并允许 --port 覆盖；真实端口永远以 /hello 的 port 字段为准。
DEFAULT_PET_PORT = 17322
DEFAULT_HOST = "127.0.0.1"                # GUESS: §4.5 只说了控制服务绑回环；接收端同理，不绑 0.0.0.0
DEFAULT_HANDSHAKE = os.path.join(os.path.expanduser("~"), ".dsh", "pet-bridge.json")  # README §4.2

MAX_BODY = 64 * 1024                      # README §4.5 请求体上限
EVENT_ID_MEMORY = 8192                    # 去重表容量（文档没规定，猜一个有界 LRU）
CLOSED_MEMORY = 8192                      # 已关闭提示的墓碑容量
ACK_MAX_ATTEMPTS = 5                      # GUESS: /ack 失败重试几次，文档没说
HTTP_TIMEOUT = 5.0                        # GUESS: 文档没说超时

PET_VERSION = "blind-receiver-0.1.0"      # GUESS: 自定义名字，schema 只要求 <=64 字符
CAPABILITIES = ["events", "state-sync", "ack-shown", "ack-dismissed", "notice-seen"]
PROTOCOL_RANGE = {"min": 1, "max": 1}     # 我只实现 v1

# GUESS: reason -> 文案。文档只锁了三条：max-tokens 不能写成正常完成；认不出的 reason 给「运行结束」；
#        不得把不可读的输入渲染成成功。其余中文文案是我自己写的。
TEXT_COMPLETED = "任务完成"
TEXT_MAX_TOKENS = "运行结束：达到 token 上限"
TEXT_ERROR = "运行出错"
TEXT_BLOCKED = "运行受阻"
# GUESS: 这三种 reason 按 §4.1 的表是 idle（不弹）。若它们意外带了 noticeId，我也不弹、只记日志。
NON_RESULT_REASONS = ("aborted", "interrupted", "forked")


def now_ms() -> int:
    return int(time.time() * 1000)


def short(s) -> str:
    if not isinstance(s, str):
        return "-"
    return s[:8] if len(s) > 8 else s


def result_text(ev: dict) -> str:
    """结果事件弹窗文案。文档没说文案从哪来：message 有就用，否则按 reason 兜。"""
    reason = ev.get("reason")
    msg = ev.get("message")
    if reason == "completed":
        return msg or TEXT_COMPLETED
    if reason == "max-tokens":
        return msg or TEXT_MAX_TOKENS
    if reason == "error":
        return msg or TEXT_ERROR
    if reason == "blocked":
        return msg or TEXT_BLOCKED
    # unknown / 缺失 / 没见过的 reason：中性文案，且**不显示 message**
    # （GUESS: 怕 message 里写着"任务完成"，把读不懂的输入渲染成成功。）
    return NEUTRAL_TEXT


def status_text(name, reason) -> str:
    """非结果事件的屏幕状态行。"""
    if name == "running":
        return "运行中"
    if name == "idle":
        return "空闲"
    if name == "completed":
        return NEUTRAL_TEXT            # GUESS: completed 却没有 noticeId —— 不上弹，只写中性状态
    if name == "error":
        return TEXT_ERROR
    return NEUTRAL_TEXT                # 未知事件名：降级，不失败（schema: unknown name degrades）


# ---------------------------------------------------------------- HTTP 客户端

def _parse(body: bytes):
    if not body:
        return None
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return {"_raw": body.decode("utf-8", "replace")[:200]}


def http_post(url: str, obj, headers: dict | None = None, timeout: float = HTTP_TIMEOUT):
    """返回 (status|None, body)。status None = 连不上/超时。"""
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, _parse(r.read())
    except urllib.error.HTTPError as e:
        return e.code, _parse(e.read())
    except Exception as e:                     # 连接被拒 / 超时 / DNS
        return None, {"_error": f"{type(e).__name__}: {e}"}


def http_get(url: str, headers: dict | None = None, timeout: float = HTTP_TIMEOUT):
    req = urllib.request.Request(url, method="GET", headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, _parse(r.read())
    except urllib.error.HTTPError as e:
        return e.code, _parse(e.read())
    except Exception as e:
        return None, {"_error": f"{type(e).__name__}: {e}"}


# ---------------------------------------------------------------- 数据结构

class Notice:
    """一条本地提示（弹窗）。GUESS: 同一宿主可以有多条并存，文档没规定只显示一条。"""

    __slots__ = ("notice_id", "session_id", "run_id", "target_turn_ref", "reason", "text",
                 "title", "created_ms", "state", "ack_shown_sent", "ack_pending", "source")

    def __init__(self, notice_id, session_id=None, run_id=None, target_turn_ref=None,
                 reason=None, text="", title=None, source="event", state="pending"):
        self.notice_id = notice_id
        self.session_id = session_id or ""
        self.run_id = run_id or ""
        self.target_turn_ref = target_turn_ref
        self.reason = reason
        self.text = text
        self.title = (title or "")[:160]      # schema: title maxLength 160
        self.created_ms = now_ms()
        self.state = state
        self.ack_shown_sent = False
        self.ack_pending = False
        self.source = source                  # "event" | "state"

    def to_dict(self):
        return {
            "noticeId": self.notice_id, "sessionId": self.session_id, "runId": self.run_id,
            "targetTurnRef": self.target_turn_ref, "reason": self.reason, "text": self.text,
            "title": self.title, "state": self.state, "createdAt": self.created_ms,
            "ackShownSent": self.ack_shown_sent, "ackPending": self.ack_pending,
            "source": self.source,
        }


# ---------------------------------------------------------------- 状态中心

class Store:
    def __init__(self, handshake_path: str):
        self.lock = threading.RLock()
        self.handshake_path = handshake_path

        self.pet_port = None
        self.status = "启动中"
        self.revision = None
        self.sessions = []
        self.hello_info = None
        self.control_port = None
        self.control_token = None
        self.ack_shown_agreed = False     # 只有 /hello 的 agreed 里真有 ack-shown 才回报 shown
        self.last_align_ms = None

        self.notices: "OrderedDict[str, Notice]" = OrderedDict()   # 在屏上的提示
        self.closed: "OrderedDict[str, str]" = OrderedDict()       # 墓碑：永不重建
        self.event_ids: "OrderedDict[str, int]" = OrderedDict()    # 事件 id 去重
        self.read_notices: "OrderedDict[str, int]" = OrderedDict()  # seen:true 之类"已读"

        self.last_events = []
        self.counters = {
            "eventReceived": 0, "eventDuplicate": 0, "eventMalformed": 0,
            "popupOpened": 0, "popupClosed": 0, "reopenBlocked": 0,
            "ackQueued": 0, "ackSent": 0, "ackFailed": 0,
            "alignDone": 0, "helloOk": 0, "helloFail": 0,
        }
        self.ack_q: "queue.Queue" = queue.Queue()

    # ---- 日志 / 屏幕

    def log(self, line: str):
        with self.lock:
            sys.stdout.write(f"{time.strftime('%H:%M:%S')} {line}\n")
            sys.stdout.flush()

    def render(self):
        """GUESS: 「上屏面」= 终端面板；每次状态变化重绘一次，并 flush。"""
        with self.lock:
            hs = self.hello_info
            if hs:
                bridge = (f"127.0.0.1:{hs.get('controlPort')}  revision={hs.get('revision')}  "
                          f"agreed={','.join(hs.get('agreed') or []) or '-'}")
            else:
                bridge = f"未握手（等待 {self.handshake_path} 并重试 /hello）"
            lines = [
                "=" * 72,
                " dsh-pet-seen | blind receiver | protocol v1",
                f" 本机接收端口 : {self.pet_port}   (POST /event)",
                f" 控制通道     : {bridge}",
                f" 状态         : {self.status}",
            ]
            if self.notices:
                lines.append(f" 提示 {len(self.notices)} 条：")
                for i, (nid, n) in enumerate(self.notices.items(), 1):
                    mark = "shown 已回报" if n.ack_shown_sent else ("shown 排队中" if n.ack_pending else "shown 未回报")
                    lines.append(f"   [{i}] {short(nid)}  {n.text}   [{mark}]  session={short(n.session_id)}")
            else:
                lines.append(" 提示 0 条：屏幕干净")
            lines.append("-" * 72)
            sys.stdout.write("\n".join(lines) + "\n")
            # 机器可读的一行，方便自测/肉眼核对
            sys.stdout.write("[screen] popups=%d ids=%s status=%s revision=%s\n" % (
                len(self.notices), ",".join(short(k) for k in self.notices), self.status,
                self.revision if self.revision is not None else "-"))
            sys.stdout.flush()

    def debug_state(self):
        with self.lock:
            return {
                "v": 1,
                "petPort": self.pet_port,
                "note": "非协议端点，只给自测/排障用；插件永远不调它",
                "handshakePath": self.handshake_path,
                "handshake": {"controlPort": self.control_port, "tokenPresent": bool(self.control_token)},
                "hello": self.hello_info,
                "ackShownAgreed": self.ack_shown_agreed,
                "revision": self.revision,
                "lastAlignAt": self.last_align_ms,
                "status": self.status,
                "sessions": [{"sessionId": s.get("sessionId"), "title": s.get("title"),
                              "running": s.get("running"), "percent": s.get("percent")}
                             for s in self.sessions if isinstance(s, dict)],
                "active": [n.to_dict() for n in self.notices.values()],
                "closed": dict(self.closed),
                "read": dict(self.read_notices),
                "counters": dict(self.counters),
                "lastEvents": self.last_events[-12:],
            }

    # ---- 凭据

    def refresh_credentials(self) -> bool:
        """读握手文件。GUESS: 只认 controlPort / token；v 与 writtenAt 不校验（多了不报错）。"""
        try:
            with open(self.handshake_path, "r", encoding="utf-8") as f:
                hs = json.load(f)
        except FileNotFoundError:
            self.log(f"[cred] 还没有握手文件 {self.handshake_path}（等宿主起来写它）")
            return False
        except Exception as e:
            self.log(f"[cred] 握手文件读不动/不是 JSON：{type(e).__name__}: {e}（稍后重试）")
            return False
        if not isinstance(hs, dict):
            self.log("[cred] 握手文件不是 JSON 对象，忽略")
            return False
        port, token = hs.get("controlPort"), hs.get("token")
        if not isinstance(port, int) or not isinstance(token, str) or not token:
            self.log(f"[cred] 握手文件缺 controlPort/token：{hs}（稍后重试）")
            return False
        if hs.get("v") not in (None, PROTOCOL_V):
            self.log(f"[cred] 握手文件 v={hs.get('v')!r}，仍按 v1 处理（未知只降级不失败）")
        with self.lock:
            self.control_port, self.control_token = port, token
        return True

    def control_endpoint(self):
        with self.lock:
            if not self.control_port or not self.control_token:
                self.refresh_credentials()
            return self.control_port, self.control_token

    # ---- 事件入口

    def ingest(self, ev):
        """POST /event 的处理。返回 (http_status, body)。"""
        with self.lock:
            self.counters["eventReceived"] += 1
            if not isinstance(ev, dict):
                self.counters["eventMalformed"] += 1
                self.log("[ev] 请求体不是 JSON 对象 -> 400")
                return 400, {"v": 1, "ok": False, "reason": "body is not a JSON object"}
            eid = ev.get("id")
            if not isinstance(eid, str) or not eid:
                # 没有 id 就没法去重，只能拒收（GUESS：400 + ok:false）
                self.counters["eventMalformed"] += 1
                self.log(f"[ev] 事件缺 id -> 400：{json.dumps(ev, ensure_ascii=False)[:200]}")
                return 400, {"v": 1, "ok": False, "reason": "missing id"}
            if eid in self.event_ids:
                self.counters["eventDuplicate"] += 1
                self.log(f"[ev] id={short(eid)} 重复投递 -> 忽略（按 id 去重）")
                return 200, {"v": 1, "ok": True, "duplicate": True}
            self.event_ids[eid] = now_ms()
            while len(self.event_ids) > EVENT_ID_MEMORY:
                self.event_ids.popitem(last=False)

            if ev.get("v") != PROTOCOL_V:
                # GUESS: v 不认识也只记日志、照收（未知字段/枚举都该降级），不因为版本号拒收事件
                self.log(f"[ev] v={ev.get('v')!r}（不是 1），仍按 v1 处理")
            try:
                self._dispatch(ev)
            except Exception as e:              # GUESS: 单条事件处理炸了不影响别的
                self.log(f"[ev] 处理异常：{type(e).__name__}: {e}")
            return 200, {"v": 1, "ok": True}

    def _dispatch(self, ev: dict):
        eid = ev.get("id")
        name = ev.get("event")
        reason = ev.get("reason")
        notice_id = ev.get("noticeId")
        seen_flag = ev.get("seen")
        self.last_events.append({"at": now_ms(), "id": eid, "event": name, "reason": reason,
                                 "noticeId": notice_id, "seen": seen_flag, "hook": ev.get("hook")})
        self.log(f"[ev] id={short(eid)} event={name!r} reason={reason!r} "
                 f"notice={short(notice_id)} seen={seen_flag} title={ev.get('title')!r}")

        if name == "notice/seen":
            if isinstance(notice_id, str) and notice_id:
                self._close_notice(notice_id, "notice/seen（用户看到了）", render=True)
            else:
                # GUESS: notice/seen 没带 noticeId -> 映射不到任何提示，忽略并记日志
                self.log("[ev] notice/seen 没带 noticeId -> 忽略（无法定位提示）")
                self.render()
            return

        if isinstance(notice_id, str) and notice_id:
            # 有 noticeId 就是"结果事件"（判据是"有 noticeId"，不是"名字叫 error"）
            if seen_flag is True:
                # 文档：结果事件带 seen:true -> 不弹，记录已读
                self._mark_read_already(notice_id, ev)
            elif reason in NON_RESULT_REASONS:
                # GUESS: 不该发生（这三种 reason 不铸 noticeId）。真来了也不弹，并立墓碑，
                #        免得后面 /state 对齐又把它弹出来（文档明说这三种"不算完成，不弹"）。
                self._close_notice(notice_id, f"reason={reason} 不算完成", render=False)
            else:
                self._open_notice(notice_id, ev, ack=True, source="event")
            self.render()
            return

        # 没有 noticeId：只是状态更新，不弹
        self.status = status_text(name, reason)
        self.render()

    # ---- 提示：建 / 关

    def _open_notice(self, notice_id: str, ev: dict, ack: bool, source: str = "event",
                     already_shown: bool = False):
        if notice_id in self.closed:
            # 这就是"重复或乱序的 notice/seen 不得重建已关闭的提示"那条
            self.counters["reopenBlocked"] += 1
            self.log(f"[popup] {short(notice_id)} 忽略：提示已关闭过（{self.closed[notice_id]}），不重建")
            return
        if notice_id in self.notices:
            n = self.notices[notice_id]
            n.text = n.text or result_text(ev)
            self.log(f"[popup] {short(notice_id)} 已在屏上，只更新字段，不重复弹/不重复回报")
            return
        n = Notice(
            notice_id,
            session_id=ev.get("sessionId"),
            run_id=ev.get("runId"),
            target_turn_ref=ev.get("targetTurnRef"),
            reason=ev.get("reason"),
            text=result_text(ev),
            title=ev.get("title"),
            source=source,
        )
        self.notices[notice_id] = n
        if already_shown:
            # 宿主快照里这条已经是 shown（它已经知道我回报过了）-> 补画，但不再回报一次
            n.ack_shown_sent = True
        self.counters["popupOpened"] += 1
        self.log(f"[popup] OPEN {short(notice_id)} 「{n.text}」 session={short(n.session_id)} "
                 f"run={short(n.run_id)} turn={n.target_turn_ref} (来源 {source})")
        # 先真的画上屏，再谈回报 —— "shown 只表示桌宠已实际显示"
        self.render()
        if ack:
            self._queue_ack(notice_id, "shown")

    def _close_notice(self, notice_id: str, why: str, render: bool):
        was_open = self.notices.pop(notice_id, None) is not None
        already = notice_id in self.closed
        if not was_open and already:
            self.counters["reopenBlocked"] += 1
            self.log(f"[popup] CLOSE {short(notice_id)} 重复/乱序到达 -> 忽略（已关闭：{self.closed[notice_id]}）")
        else:
            self.closed[notice_id] = why
            while len(self.closed) > CLOSED_MEMORY:
                self.closed.popitem(last=False)
            if was_open:
                self.counters["popupClosed"] += 1
            self.log(f"[popup] CLOSE {short(notice_id)}（{why}）{'从屏上撤下' if was_open else '屏上本来没有'}")
        if render:
            self.render()

    def _mark_read_already(self, notice_id: str, ev: dict):
        had = self.notices.pop(notice_id, None) is not None
        self.closed[notice_id] = "结果事件带 seen:true（页面早看到了）"
        while len(self.closed) > CLOSED_MEMORY:
            self.closed.popitem(last=False)
        if notice_id not in self.read_notices:
            self.read_notices[notice_id] = now_ms()
            while len(self.read_notices) > CLOSED_MEMORY:
                self.read_notices.popitem(last=False)
        self.log(f"[popup] {short(notice_id)} seen:true -> 不弹、记录已读"
                 f"{'（并撤下已在屏上的那条）' if had else ''}")

    # ---- /ack

    def _queue_ack(self, notice_id: str, action: str):
        if action == "shown" and not self.ack_shown_agreed:
            n = self.notices.get(notice_id)
            if n:
                n.ack_pending = False
            self.log(f"[ack] {short(notice_id)} shown 暂不回报：握手还没给出 agreed 含 ack-shown")
            return
        n = self.notices.get(notice_id)
        if n and action == "shown":
            if n.ack_shown_sent or n.ack_pending:
                return
            n.ack_pending = True
        self.counters["ackQueued"] += 1
        self.ack_q.put({"noticeId": notice_id, "action": action})

    def queue_pending_shown_acks(self):
        """握手/对齐成功之后，把屏上还没回报过 shown 的补回报一次。"""
        with self.lock:
            for nid in list(self.notices):
                n = self.notices[nid]
                if not n.ack_shown_sent and not n.ack_pending:
                    self._queue_ack(nid, "shown")

    def ack_succeeded(self, notice_id: str, action: str, resp: dict):
        with self.lock:
            self.counters["ackSent"] += 1
            n = self.notices.get(notice_id)
            if n:
                if action == "shown":
                    n.ack_shown_sent = True
                    n.ack_pending = False
                n.state = resp.get("state") or n.state
            self.log(f"[ack] OK {action} {short(notice_id)} state={resp.get('state')!r}")
            st = resp.get("state")
            if st in ("seen", "dismissed"):
                self._close_notice(notice_id, f"/ack 回应 state={st}", render=False)
                self.render()

    def ack_failed(self, notice_id: str, action: str, detail: str):
        with self.lock:
            self.counters["ackFailed"] += 1
            n = self.notices.get(notice_id)
            if n and action == "shown":
                n.ack_pending = False
            self.log(f"[ack] 放弃 {action} {short(notice_id)}：{detail}（下次 /state 对齐后会再试）")

    # ---- /state 对齐

    def align(self, state: dict, fetch_started_ms: int):
        with self.lock:
            self.revision = state.get("revision")
            self.sessions = [s for s in (state.get("sessions") or []) if isinstance(s, dict)]
            notices = [n for n in (state.get("notices") or []) if isinstance(n, dict)]
            self.last_align_ms = now_ms()
            self.counters["alignDone"] += 1

            live_ids = set()
            for n in notices:
                nid = n.get("noticeId")
                if not isinstance(nid, str) or not nid:
                    continue
                live_ids.add(nid)
                st = n.get("state")
                if st in ("seen", "dismissed"):
                    # 终态：撤下 + 立墓碑，永不重建
                    self._close_notice(nid, f"/state state={st}", render=False)
                elif st == "pending" and n.get("delivered") is True:
                    # GUESS: 快照里 pending 且 delivered=true 的，说明结果是发过给我的，重建提示并回报 shown
                    self._open_notice(nid, self._snapshot_as_event(n), ack=True, source="state")
                elif st == "shown":
                    # GUESS: 宿主已知道我回报过 shown；本地丢了就补画，但不再回报一次
                    self._open_notice(nid, self._snapshot_as_event(n), ack=False, source="state",
                                      already_shown=True)
                # pending 但 delivered != true：结果事件还没发给我，先不动（GUESS）

            # GUESS: 本地在屏、但快照里没有 -> 认为已被宿主收口，撤下。
            #        只撤"快照请求开始之前"就存在的，免得把并发新建的误撤。
            for nid in list(self.notices):
                if nid not in live_ids and self.notices[nid].created_ms <= fetch_started_ms:
                    self._close_notice(nid, "不在 /state 快照里", render=False)

            self.status = self._session_status()
            self.log(f"[state] 对齐完成 revision={self.revision} sessions={len(self.sessions)} "
                     f"notices={len(notices)} 屏上={len(self.notices)}")
            self.render()
            self.queue_pending_shown_acks()

    @staticmethod
    def _snapshot_as_event(n: dict) -> dict:
        return {"sessionId": n.get("sessionId"), "runId": n.get("runId"),
                "targetTurnRef": n.get("targetTurnRef"), "reason": n.get("reason"),
                "title": None, "message": None}

    def _session_status(self) -> str:
        running = [s for s in self.sessions if s.get("running")]
        if running:
            first = running[0]
            pct = first.get("percent")
            return f"运行中 {len(running)} 个会话" + (f"（{pct}%）" if isinstance(pct, (int, float)) else "")
        if self.sessions:
            return f"空闲（{len(self.sessions)} 个会话）"
        return self.status


# ---------------------------------------------------------------- 控制通道

class Bridge(threading.Thread):
    """读握手文件 -> /hello -> /state 对齐，循环重试。"""

    def __init__(self, store: Store, align_interval: float):
        super().__init__(name="bridge", daemon=True)
        self.store = store
        self.align_interval = align_interval
        self._stop = threading.Event()
        self.last_token = None
        self.last_port = None

    def stop_now(self):
        self._stop.set()

    def run(self):
        backoff = 0.5
        while not self._stop.is_set():
            if not self.store.refresh_credentials():
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 5.0)
                continue
            port, token = self.store.control_endpoint()
            rotated = (token != self.last_token) or (port != self.last_port)
            if rotated and self.last_token is not None:
                self.store.log("[hello] token/端口变了（宿主重启轮换 token）-> 重新握手")
            ok, resp, wait_s = self._hello(port, token)
            if not ok:
                self.store.counters["helloFail"] += 1
                self._stop.wait(wait_s)
                backoff = min(backoff * 2, 5.0)
                continue
            self.last_token, self.last_port = token, port
            backoff = 0.5
            auth_failed = self._align(port, token)
            if auth_failed:
                continue                     # 立刻重读握手文件再握手
            self._stop.wait(self.align_interval)

    def _hello(self, port: int, token: str):
        body = {
            "v": PROTOCOL_V,
            "petVersion": PET_VERSION,
            "port": self.store.pet_port,
            "token": token,
            "protocol": dict(PROTOCOL_RANGE),
            "capabilities": list(CAPABILITIES),
        }
        url = f"http://127.0.0.1:{port}/hello"
        status, resp = http_post(url, body)
        if status is None:
            self.store.log(f"[hello] 控制端口 {port} 连不上（{resp.get('_error')}）-> 稍后重试")
            return False, resp, 1.0
        if status in (401, 403):
            self.store.log(f"[hello] token 被拒（HTTP {status}）-> 重读握手文件再握手")
            self.store.refresh_credentials()
            return False, resp, 0.2
        if status != 200 or not isinstance(resp, dict) or resp.get("ok") is not True:
            self.store.log(f"[hello] 响应不合预期 status={status} body={resp} -> 稍后重试")
            return False, resp, 1.0
        agreed = [c for c in (resp.get("agreed") or []) if isinstance(c, str)]
        with self.store.lock:
            self.store.ack_shown_agreed = "ack-shown" in agreed
            self.store.hello_info = {
                "controlPort": port,
                "revision": resp.get("revision"),
                "petPort": resp.get("petPort"),
                "capabilities": resp.get("capabilities"),
                "agreed": agreed,
                "legacy": resp.get("legacy"),
                "petVersion": resp.get("petVersion"),
            }
            if self.store.hello_info["petPort"] not in (None, self.store.pet_port):
                self.store.log(f"[hello] 注意：宿主记的 petPort={self.store.hello_info['petPort']} "
                               f"与我实际监听的 {self.store.pet_port} 不一致")
        self.store.counters["helloOk"] += 1
        self.store.log(f"[hello] OK revision={resp.get('revision')} agreed={agreed or '[]'} "
                       f"capabilities={resp.get('capabilities')} legacy={resp.get('legacy')}")
        self.store.queue_pending_shown_acks()
        return True, resp, 0.0

    def _align(self, port: int, token: str) -> bool:
        """返回 True 表示认证失败（调用方应立刻重读握手文件）。"""
        t0 = now_ms()
        # GUESS: 文档说 /state 的 token 可以走 x-pet-token 头或 ?token=；两个都带上最稳。
        url = f"http://127.0.0.1:{port}/state?token={quote(token, safe='')}"
        status, resp = http_get(url, headers={"x-pet-token": token})
        if status is None:
            self.store.log(f"[state] 拉取失败：{resp.get('_error')}（下次对齐再试）")
            return False
        if status in (401, 403):
            self.store.log(f"[state] token 被拒（HTTP {status}）-> 重读握手文件再握手")
            self.store.refresh_credentials()
            return True
        if status != 200 or not isinstance(resp, dict):
            self.store.log(f"[state] 响应不合预期 status={status} body={str(resp)[:200]}")
            return False
        if resp.get("v") != PROTOCOL_V:
            self.store.log(f"[state] v={resp.get('v')!r}（不是 1），仍按 v1 读（未知只降级）")
        self.store.align(resp, t0)
        return False


class AckSender(threading.Thread):
    """POST /ack，失败重试。"""

    def __init__(self, store: Store):
        super().__init__(name="ack", daemon=True)
        self.store = store

    def run(self):
        while True:
            task = self.store.ack_q.get()
            if task is None:
                return
            self._deliver(task)

    def _deliver(self, task):
        notice_id, action = task["noticeId"], task["action"]
        detail = "unknown"
        for attempt in range(1, ACK_MAX_ATTEMPTS + 1):
            port, token = self.store.control_endpoint()
            if not port or not token:
                detail = "还没有控制端口/token"
            else:
                status, resp = http_post(f"http://127.0.0.1:{port}/ack",
                                         {"v": PROTOCOL_V, "noticeId": notice_id,
                                          "action": action, "token": token})
                if status == 200 and isinstance(resp, dict) and resp.get("ok") is True:
                    self.store.ack_succeeded(notice_id, action, resp)
                    return
                detail = f"HTTP {status} {resp}"
                if status in (401, 403):
                    self.store.log(f"[ack] token 被拒（HTTP {status}）-> 重读握手文件")
                    self.store.refresh_credentials()
            if attempt < ACK_MAX_ATTEMPTS:
                time.sleep(min(0.25 * (2 ** (attempt - 1)), 3.0))
        self.store.ack_failed(notice_id, action, detail)


# ---------------------------------------------------------------- 入站服务器

class EventHandler(BaseHTTPRequestHandler):
    server_version = "dsh-pet-blind-receiver/0.1"
    store: Store = None            # 由 make_handler 绑定
    debug: bool = False            # PL-TS-NW-03 T2：协议外路由只在显式 --debug 时挂载

    def log_message(self, fmt, *a):    # 关掉 BaseHTTPRequestHandler 的默认 stderr 噪音
        pass

    def _send(self, status: int, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_POST(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:
            self._send(400, {"v": 1, "ok": False, "reason": "bad Content-Length"})
            return
        if length > MAX_BODY:
            # README §4.5：请求体上限 64 KiB
            self.store.log(f"[http] 请求体 {length} 字节 > 64 KiB -> 413")
            self._send(413, {"v": 1, "ok": False, "reason": "body too large"})
            return
        raw = self.rfile.read(length) if length else b""
        if path != "/event":
            self._send(404, {"v": 1, "ok": False, "reason": f"no such route: {path}"})
            return
        try:
            ev = json.loads(raw.decode("utf-8"))
        except Exception as e:
            with self.store.lock:
                self.store.counters["eventMalformed"] += 1
            self.store.log(f"[http] /event 请求体不是 JSON：{e}")
            self._send(400, {"v": 1, "ok": False, "reason": "invalid JSON"})
            return
        status, body = self.store.ingest(ev)
        self._send(status, body)

    def do_GET(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        # PL-TS-NW-03 T2：这两条路由不是协议的一部分，缺省 404（只有 --debug 才挂）
        if self.debug and path == "/__debug/state":
            self._send(200, self.store.debug_state())
            return
        if self.debug and path == "/health":
            self._send(200, {"ok": True, "petPort": self.store.pet_port})
            return
        self._send(404, {"v": 1, "ok": False, "reason": f"no such route: {path}"})


def make_handler(store: Store, debug: bool = False):
    return type("BoundEventHandler", (EventHandler,), {"store": store, "debug": debug})


# ---------------------------------------------------------------- stdin（可选）

def stdin_loop(store: Store):
    sys.stdout.write("命令：d <noticeId前缀> = 用户手动关掉那条提示（回报 dismissed）；p = 重画；q = 退出\n")
    sys.stdout.flush()
    for line in sys.stdin:
        cmd = line.strip().split()
        if not cmd:
            continue
        if cmd[0] == "q":
            os._exit(0)
        if cmd[0] == "p":
            store.render()
            continue
        if cmd[0] == "d" and len(cmd) > 1:
            pref = cmd[1]
            with store.lock:
                hits = [nid for nid in store.notices if nid.startswith(pref)]
            if not hits:
                store.log(f"[ui] 没有匹配 {pref} 的提示")
                continue
            for nid in hits:
                store._close_notice(nid, "用户手动关闭", render=False)
                store.ack_q.put({"noticeId": nid, "action": "dismissed"})
            store.render()


# ---------------------------------------------------------------- 日志落盘（PL-TS-NW-03 T3）

class _Tee:
    """把 stdout 同时写进一个由**本进程**打开的 UTF-8 日志文件。

    为什么不用 shell 的 redirect（`python … | Tee-Object -FilePath …`）：Windows 上
    PowerShell 用 `[Console]::OutputEncoding`（中文机器上是 CP936）去解码子进程管道的
    字节，而这个接收端按 UTF-8 写面板 ⇒ 中文被解成乱码，替换字符还会**不可逆地**
    落进日志文件（2026-10-06 真机上就是这么毁掉一份 T3 日志的）。

    日志文件必须由接收端自己写，编码才由自己说了算 —— 跨仓 `pet.py` 出于同样的理由
    也要自己落盘（`pythonw` 连控制台都没有）。
    """

    def __init__(self, stream, path: str):
        self._stream = stream
        self._file = open(path, "a", encoding="utf-8", newline="\n")

    def write(self, text: str):
        self._stream.write(text)
        self._file.write(text)

    def flush(self):
        try:
            self._stream.flush()
        finally:
            self._file.flush()

    def isatty(self) -> bool:
        return self._stream.isatty()

    def fileno(self):
        return self._stream.fileno()

    def close(self):
        try:
            self._file.close()
        except Exception:
            pass


# ---------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="dsh-pet-seen 接收端（盲写版，只依据 README §4 + schema）")
    ap.add_argument("--port", type=int, default=DEFAULT_PET_PORT,
                    help=f"接收 /event 的端口，0 = 让系统随便给（默认 {DEFAULT_PET_PORT}）")
    ap.add_argument("--host", default=DEFAULT_HOST, help="监听地址（默认回环）")
    ap.add_argument("--handshake-file", default=DEFAULT_HANDSHAKE,
                    help=f"握手文件（文档固定在 {DEFAULT_HANDSHAKE}，此参数只为本地自测/换机）")
    ap.add_argument("--align-interval", type=float, default=15.0,
                    help="两次 GET /state 之间的秒数（文档没说频率，猜 15s）")
    ap.add_argument("--no-stdin", action="store_true", help="别起 stdin 命令线程")
    ap.add_argument("--debug", action="store_true",
                    help="挂上协议外的只读路由 /health 与 /__debug/state（验收/排障用，宿主从不调用）")
    ap.add_argument("--log", default=None,
                    help="把面板与日志同时写进这个文件（接收端自己写 UTF-8；别用 shell 的 Tee，见 _Tee 的说明）")
    args = ap.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # 免得中文在 GBK 控制台上炸
    except Exception:
        pass

    if args.log:
        # 由接收端自己落盘，而不是让 PowerShell 去 redirect：见 _Tee 的文档字符串。
        directory = os.path.dirname(os.path.abspath(args.log))
        try:
            os.makedirs(directory, exist_ok=True)
            sys.stdout = _Tee(sys.stdout, args.log)
        except OSError as e:
            sys.stderr.write(f"[fatal] 打不开日志文件 {args.log}：{e}\n")
            return 2

    store = Store(args.handshake_file)
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), make_handler(store, args.debug))
    except OSError as e:
        # GUESS: 自己端口被占用就明确报错退出，不偷偷换端口（换了宿主就找不到我了）
        sys.stderr.write(f"[fatal] 监听 {args.host}:{args.port} 失败：{e}\n"
                         f"        换个端口：--port <N>（记得宿主看到的 petPort 以 /hello 里报的为准）\n")
        return 2
    httpd.daemon_threads = True
    store.pet_port = httpd.server_address[1]
    store.log(f"[boot] 接收端监听 http://{args.host}:{store.pet_port}/event；握手文件 {args.handshake_file}")
    store.render()

    bridge = Bridge(store, args.align_interval)
    bridge.start()
    ack = AckSender(store)
    ack.start()
    if not args.no_stdin:
        try:
            if sys.stdin and sys.stdin.isatty():
                threading.Thread(target=stdin_loop, args=(store,), daemon=True).start()
        except Exception:
            pass

    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        store.log("[boot] Ctrl-C -> 退出")
    finally:
        bridge.stop_now()
        store.ack_q.put(None)
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
