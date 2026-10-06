#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/min-receiver.py 的本地干跑自测（PL-TS-NW-03 判据 ①/③ 的检查件）。

完全本地：起一个**假宿主**（只在 127.0.0.1:17399）冒充插件控制端口，
再用一个临时握手文件把 controlPort/token 交给 min-receiver.py（以 --port 0 起，避免占 17322）。
不碰真宿主、不碰真 ~/.dsh/pet-bridge.json、不占 17322/17323/3080/19387。

断言的是**线上字节 + 上屏面**（假宿主收到的 `/hello` `/state` `/ack` 与接收端的 `[screen]` 行）；
接收端的内部状态只在显式 `--debug` 时才有那条协议外路由，这条自测是仪器，所以它带 `--debug` 起。

来源：由 ⑤「盲测读者」的自测（冻结原件
working-docs/misc/PL-TS-NW-03-blind-receiver-2026-10-06/selftest.py）派生；
改动只有「被起的进程改成 min-receiver.py」与「加 --debug」。

用法： python tools/min-receiver-check.py            （或 npm run receiver:check）
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(HERE, "_selftest_tmp")
HOST_PORT = 17399
TOKEN_1 = "selftest-token-1"
TOKEN_2 = "selftest-token-2"
HOST_CAPS = ["events", "state-sync", "ack-shown", "ack-dismissed", "notice-seen"]

FAILURES: list[str] = []
PASSES = 0


def check(name: str, cond: bool, extra: str = ""):
    global PASSES
    if cond:
        PASSES += 1
        print(f"PASS  {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL  {name}   {extra}")


def wait_for(pred, timeout=8.0, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = pred()
        except Exception:
            v = None
        if v:
            return v
        time.sleep(step)
    return None


def http(url, obj=None, headers=None, method=None, raw=None, timeout=5.0):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"),
                                headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            try:
                return r.status, json.loads(body)
            except Exception:
                return r.status, body
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None
    except Exception as e:
        return None, {"_error": f"{type(e).__name__}: {e}"}


def screen_line(path, attempts=30):
    """取接收端**自己写**的那份面板日志（`--log`）里最后一行 `[screen] …`。

    PL-TS-NW-04：这行是「屏上现在有什么」的判据（条数 + ids + status），比内部状态更靠外。
    读不到宁可回 None（调用方的断言会红），不猜。
    """
    for _ in range(attempts):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                hits = [ln.rstrip("\n") for ln in f if "[screen]" in ln]
            if hits:
                return hits[-1]
        except OSError:
            pass
        time.sleep(0.1)
    return None


def notice_of(state, notice_id):
    """`__debug/state.active[]` 里那条提示的**全字段**（没有就 None）—— PL-TS-NW-04 的行为面快照。"""
    for n in ((state or {}).get("active") or []):
        if n.get("noticeId") == notice_id:
            return n
    return None


# ------------------------------------------------------------------ 假宿主

class FakeHost:
    def __init__(self):
        self.lock = threading.RLock()
        self.token = TOKEN_1
        self.revision = 7
        self.hellos: list[dict] = []
        self.state_hits: list[str] = []
        self.acks: list[dict] = []
        self.unauthorized = 0
        self.bad_ack = 0
        self.notices: list[dict] = []
        self.sessions = [{
            "sessionId": "sess-alpha", "title": "假会话", "cwd": "C:/tmp", "origin": None,
            "running": True, "runId": "run-1", "lastTurnEnd": None, "toolCalls": 3,
            "lastTool": "read", "todoCount": 4, "completedTodoCount": 1, "percent": 25,
            "updatedAt": 1758300000000,
        }]

    # -- 测试用的小工具
    def add_notice(self, notice_id, state="pending", delivered=True, reason="completed"):
        with self.lock:
            self.notices = [n for n in self.notices if n["noticeId"] != notice_id]
            self.notices.append({
                "noticeId": notice_id, "sessionId": "sess-alpha", "runId": "run-1",
                "targetTurnRef": "12", "reason": reason, "completedAt": 1758300000000,
                "state": state, "seenAt": None, "delivered": delivered,
            })

    def set_state(self, notice_id, state):
        with self.lock:
            for n in self.notices:
                if n["noticeId"] == notice_id:
                    n["state"] = state

    def drop_notice(self, notice_id):
        with self.lock:
            self.notices = [n for n in self.notices if n["noticeId"] != notice_id]

    def acks_for(self, notice_id, action=None):
        with self.lock:
            return [a for a in self.acks if a["noticeId"] == notice_id and (action is None or a["action"] == action)]

    def hello_tokens(self):
        with self.lock:
            return [h.get("token") for h in self.hellos]

    def last_hello(self):
        with self.lock:
            return self.hellos[-1] if self.hellos else None

    # -- HTTP
    def payload(self):
        with self.lock:
            return {
                "v": 1, "revision": self.revision, "sessions": self.sessions,
                "notices": self.notices, "petPort": (self.last_hello() or {}).get("port"),
                "browserRoutes": False, "buildId": "selftest-build",
                "pluginVersion": "0.0.0-selftest", "browserTabs": [],
            }


def make_host_handler(host: FakeHost):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, status, obj):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n).decode()) if n else {}

        def _auth(self, token):
            with host.lock:
                ok = token == host.token
                if not ok:
                    host.unauthorized += 1
            return ok

        def do_POST(self):
            path = urlsplit(self.path).path.rstrip("/")
            if path == "/hello":
                b = self._body()
                if not self._auth(b.get("token")):
                    return self._json(401, {"v": 1, "ok": False, "reason": "unauthorized"})
                with host.lock:
                    host.hellos.append(b)
                    agreed = [c for c in (b.get("capabilities") or []) if c in HOST_CAPS]
                return self._json(200, {"v": 1, "ok": True, "revision": host.revision,
                                        "petPort": b.get("port"), "capabilities": HOST_CAPS,
                                        "agreed": agreed, "petVersion": b.get("petVersion")})
            if path == "/ack":
                b = self._body()
                if not self._auth(b.get("token")):
                    return self._json(401, {"v": 1, "ok": False, "reason": "unauthorized"})
                with host.lock:
                    host.acks.append(b)
                    if b.get("action") == "shown":
                        host.set_state(b.get("noticeId"), "shown")
                return self._json(200, {"v": 1, "ok": True, "state": "shown"})
            return self._json(404, {"v": 1, "ok": False})

        def do_GET(self):
            u = urlsplit(self.path)
            if u.path.rstrip("/") == "/state":
                tok = self.headers.get("x-pet-token") or (parse_qs(u.query).get("token") or [""])[0]
                if not self._auth(tok):
                    return self._json(401, {"v": 1, "ok": False, "reason": "unauthorized"})
                with host.lock:
                    host.state_hits.append(tok)
                return self._json(200, host.payload())
            return self._json(404, {"v": 1, "ok": False})

    return H


# ------------------------------------------------------------------ 主流程

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main() -> int:
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)
    hs_path = os.path.join(TMP, "pet-bridge.json")
    log_path = os.path.join(TMP, "receiver.log")
    panel_path = os.path.join(TMP, "panel.log")   # 接收端自己写的那份（--log）

    host = FakeHost()
    srv = ThreadingHTTPServer(("127.0.0.1", HOST_PORT), make_host_handler(host))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[selftest] 假宿主（控制端口）在 127.0.0.1:{HOST_PORT}")

    # 初始快照：四种 state 各来一条
    host.add_notice("N0-shown-local-lost", state="shown", delivered=True)
    host.add_notice("N3-pending-delivered", state="pending", delivered=True)
    host.add_notice("N4-seen", state="seen", delivered=True)
    host.add_notice("N10-pending-undelivered", state="pending", delivered=False)

    with open(hs_path, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "controlPort": HOST_PORT, "token": TOKEN_1,
                   "writtenAt": "2026-01-01T00:00:00.000Z"}, f)

    logf = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "min-receiver.py"), "--port", "0",
         "--handshake-file", hs_path, "--align-interval", "1", "--no-stdin", "--debug",
         "--log", panel_path],
        cwd=HERE, stdout=logf, stderr=subprocess.STDOUT,
    )
    print(f"[selftest] min-receiver.py pid={proc.pid}，自测端口 0（系统分配）+ 握手文件 {hs_path}")
    print(f"[selftest] 自测用的控制端口 {HOST_PORT}（不是 17322/17323）")

    def debug():
        h = host.last_hello()
        if not h:
            return None
        pets = h.get("port")
        st, body = http(f"http://127.0.0.1:{pets}/__debug/state")
        return body if st == 200 else None

    try:
        # ---- 1. 握手
        got = wait_for(lambda: host.last_hello() is not None, 10)
        check("接收端起来后主动 POST /hello", got is not None)
        h = host.last_hello() or {}
        check("/hello body.v == 1", h.get("v") == 1, str(h))
        check("/hello body.port 是自己真实监听的端口（>0）", isinstance(h.get("port"), int) and h["port"] > 0, str(h))
        check("/hello body.token 来自握手文件", h.get("token") == TOKEN_1)
        check("/hello body.protocol == {min:1,max:1}", h.get("protocol") == {"min": 1, "max": 1}, str(h.get("protocol")))
        check("/hello body.capabilities 五项齐全", sorted(h.get("capabilities") or []) == sorted(HOST_CAPS), str(h.get("capabilities")))
        check("/hello 带了 petVersion（<=64）", isinstance(h.get("petVersion"), str) and len(h["petVersion"]) <= 64, str(h.get("petVersion")))

        # ---- 2. /state 对齐
        got = wait_for(lambda: len(host.state_hits) > 0, 10)
        check("握手成功后立刻拉 GET /state", got is not None)
        check("/state 用握手文件里的 token 认证", host.state_hits and host.state_hits[0] == TOKEN_1)

        d = wait_for(lambda: (debug() or {}).get("counters", {}).get("alignDone", 0) >= 1, 10)
        check("对齐跑过一次", bool(d))
        d = debug() or {}
        active = {n["noticeId"] for n in d.get("active", [])}
        closed = d.get("closed", {})
        check("快照 state=pending 且 delivered=true -> 建提示", "N3-pending-delivered" in active, str(active))
        check("快照 state=seen -> 不建提示并记墓碑", "N4-seen" not in active and "N4-seen" in closed, str(closed))
        check("快照 state=shown -> 补画但不重复回报 shown",
              "N0-shown-local-lost" in active and not host.acks_for("N0-shown-local-lost"), str(active))
        check("快照 state=pending 但 delivered=false -> 不建提示", "N10-pending-undelivered" not in active, str(active))
        got = wait_for(lambda: host.acks_for("N3-pending-delivered", "shown"), 8)
        check("重建的提示回报了 POST /ack action=shown", bool(got), str(host.acks))
        check("/ack body.v == 1 且带 token", (got or [{}])[0].get("v") == 1 and (got or [{}])[0].get("token") == TOKEN_1, str(got))
        check("屏上显示了会话进度（sessions 被读到）", "运行中" in (d.get("status") or ""), str(d.get("status")))

        h = host.last_hello()
        pet = f"http://127.0.0.1:{h['port']}"

        def ev(obj):
            return http(pet + "/event", obj)

        def post_event(eid, event, reason=None, notice_id=None, seen=None, title=None, message=None, extra=None):
            body = {"v": 1, "id": eid, "event": event, "source": "deepseek-harness",
                    "hook": "run/idle", "sessionId": "sess-alpha", "runId": "run-1",
                    "targetTurnRef": "12", "timestamp": 1758300000000}
            if reason is not None:
                body["reason"] = reason
            if notice_id is not None:
                body["noticeId"] = notice_id
            if seen is not None:
                body["seen"] = seen
            if title is not None:
                body["title"] = title
            if message is not None:
                body["message"] = message
            if extra:
                body.update(extra)
            return http(pet + "/event", body)

        # ---- 3. 结果事件 + 去重
        host.add_notice("N1")
        st, resp = post_event("e1", "completed", "completed", "N1", seen=False, title="会话一", message="任务完成")
        check("POST /event 返回 200 ok", st == 200 and (resp or {}).get("ok") is True, f"{st} {resp}")
        wait_for(lambda: "N1" in {n["noticeId"] for n in (debug() or {}).get("active", [])}, 5)
        d = debug() or {}
        active = {n["noticeId"] for n in d.get("active", [])}
        check("completed + noticeId + seen:false -> 弹出提示", "N1" in active, str(active))
        check("弹出的提示带 title/sessionId", any(n["noticeId"] == "N1" and n["title"] == "会话一" for n in d.get("active", [])))
        got = wait_for(lambda: host.acks_for("N1", "shown"), 5)
        check("shown 回报只在其真的画上屏之后发出", bool(got))
        before = len(host.acks)

        # ---- 3b. 行为面：同一 id 重复投递**不得改本地状态**（PL-TS-NW-04）
        # 上面那三条查的是 HTTP 响应 + 计数器；这一组查"屏上 / 接收端内部有没有被动过"。
        # 先等 ack 那条路**走完**（ackShownSent 落定）再拍快照，免得拍在"ack 还在路上"的中间态上。
        wait_for(lambda: (notice_of(debug() or {}, "N1") or {}).get("ackShownSent") is True, 8)
        screen0 = screen_line(panel_path)
        snap0 = debug() or {}
        notice0 = notice_of(snap0, "N1")
        events0 = list(snap0.get("lastEvents") or [])
        # 只比"这条事件可能碰到"的计数器：alignDone / hello* 归 /state 那条循环，与本组无关。
        EVENT_COUNTERS = ("eventReceived", "eventDuplicate", "eventMalformed",
                          "popupOpened", "popupClosed", "reopenBlocked", "ackQueued")
        counters0 = {k: (snap0.get("counters") or {}).get(k, 0) for k in EVENT_COUNTERS}

        # 重投载荷**故意与首发不同**（不带 title、换了 message）：协议只规定 id 全局唯一，
        # 没保证重投载荷逐字相同（宿主重启后重放就是这种形状）⇒ 载荷不同，"字段被改写"才可观测。
        st, resp = post_event("e1", "completed", "completed", "N1", seen=False, message="重投的文案不该上屏")
        check("同一 id 重复投递 -> 200 且标 duplicate", st == 200 and (resp or {}).get("duplicate") is True, f"{st} {resp}")
        time.sleep(0.4)
        check("重复事件没被再处理一次（没有新的 /ack）", len(host.acks) == before, f"{len(host.acks)} vs {before}")
        check("重复计数 +1", (debug() or {}).get("counters", {}).get("eventDuplicate") == 1)

        screen1 = screen_line(panel_path)
        snap1 = debug() or {}
        counters1 = {k: (snap1.get("counters") or {}).get(k, 0) for k in EVENT_COUNTERS}
        deltas = {k: counters1[k] - counters0[k] for k in EVENT_COUNTERS if counters1[k] != counters0[k]}
        check("重复投递后屏上提示条数与 ids 不变（[screen] 行逐字相同）",
              screen0 is not None and screen0 == screen1, f"{screen0!r} -> {screen1!r}")
        check("重复投递后那条提示的文案与字段逐字不变",
              notice0 is not None and notice0 == notice_of(snap1, "N1"),
              f"{notice0} -> {notice_of(snap1, 'N1')}")
        check("重复投递没有被再处理一遍（lastEvents 逐字不变）",
              list(snap1.get("lastEvents") or []) == events0,
              f"{len(events0)} -> {len(snap1.get('lastEvents') or [])}")
        check("重复投递只动 eventReceived/eventDuplicate 两个计数器（没有别的副作用）",
              deltas == {"eventReceived": 1, "eventDuplicate": 1}, str(deltas))

        # ---- 4. notice/seen 取消 + 乱序/重复不得重建
        st, _ = post_event("m1", "notice/seen", notice_id="N1")
        check("notice/seen 返回 200", st == 200)
        wait_for(lambda: "N1" not in {n["noticeId"] for n in (debug() or {}).get("active", [])}, 5)
        d = debug() or {}
        check("notice/seen 按 noticeId 撤下提示", "N1" not in {n["noticeId"] for n in d.get("active", [])})
        check("撤下的提示进了墓碑 closed", "N1" in d.get("closed", {}))
        blocked0 = d.get("counters", {}).get("reopenBlocked", 0)
        acks0 = len(host.acks)

        post_event("m2", "notice/seen", notice_id="N1")          # 重复投递（不同 id）
        post_event("e2", "completed", "completed", "N1", seen=False)   # 乱序：结果事件后到
        time.sleep(0.5)
        d = debug() or {}
        check("重复/乱序的 notice/seen 与补发结果事件都没重建已关闭的提示",
              "N1" not in {n["noticeId"] for n in d.get("active", [])}, str(d.get("active")))
        check("重建被明确挡下（reopenBlocked 增长）",
              d.get("counters", {}).get("reopenBlocked", 0) > blocked0, str(d.get("counters")))
        check("挡下时没有发出新的 /ack", len(host.acks) == acks0)

        # ---- 5. seen:true -> 不弹、记录已读
        host.add_notice("N2", state="seen")
        post_event("e3", "completed", "completed", "N2", seen=True)
        time.sleep(0.5)
        d = debug() or {}
        check("结果事件 seen:true -> 不弹", "N2" not in {n["noticeId"] for n in d.get("active", [])})
        check("结果事件 seen:true -> 记录已读/墓碑", "N2" in d.get("closed", {}) or "N2" in d.get("read", {}))
        check("结果事件 seen:true -> 不发 /ack", not host.acks_for("N2"), str(host.acks))

        # ---- 6. error 无 noticeId（运行中失败）不弹
        n_active = len(d.get("active", []))
        post_event("e4", "error", "error", None, message="运行出错：网络连接失败")
        time.sleep(0.4)
        d = debug() or {}
        check("error 没有 noticeId（运行中失败上报）-> 不弹", len(d.get("active", [])) == n_active, str(d.get("active")))
        check("error 写了状态行", "运行出错" in (d.get("status") or ""), str(d.get("status")))

        # ---- 7. reason 语义
        post_event("e5", "idle", "aborted", None)
        post_event("e6", "idle", "forked", None)
        post_event("e7", "idle", None, None)
        time.sleep(0.4)
        d = debug() or {}
        check("aborted/forked/缺 reason -> 不弹", len(d.get("active", [])) == n_active, str(d.get("active")))

        host.add_notice("N7", reason="max-tokens")
        post_event("e8", "completed", "max-tokens", "N7", seen=False)
        wait_for(lambda: "N7" in {n["noticeId"] for n in (debug() or {}).get("active", [])}, 5)
        d = debug() or {}
        t7 = next((n["text"] for n in d.get("active", []) if n["noticeId"] == "N7"), "")
        check("reason=max-tokens 的文案不写成正常完成", "任务完成" not in t7 and "token" in t7, t7)

        host.add_notice("N8", reason="unknown")
        post_event("e9", "completed", "unknown", "N8", seen=False)
        post_event("e10", "something/new", None, "N9", seen=False)   # 未知事件名
        wait_for(lambda: {"N8", "N9"} <= {n["noticeId"] for n in (debug() or {}).get("active", [])}, 5)
        d = debug() or {}
        texts = {n["noticeId"]: n["text"] for n in d.get("active", [])}
        check("认不出的 reason -> 中性文案「运行结束」", texts.get("N8") == "运行结束", str(texts.get("N8")))
        check("未知事件名（带 noticeId）也降级成中性文案", texts.get("N9") == "运行结束", str(texts.get("N9")))

        # ---- 8. /state 对齐撤下"快照里没有"的提示
        host.add_notice("N5")            # 让它先上屏
        post_event("e11", "completed", "completed", "N5", seen=False)
        wait_for(lambda: "N5" in {n["noticeId"] for n in (debug() or {}).get("active", [])}, 5)
        check("N5 先上了屏", "N5" in {n["noticeId"] for n in (debug() or {}).get("active", [])})
        host.drop_notice("N5")           # 宿主收口了它
        got = wait_for(lambda: "N5" in (debug() or {}).get("closed", {}), 6)
        check("不在 /state 快照里的本地提示被撤下", bool(got), str((debug() or {}).get("closed")))

        # ---- 9. 坏输入
        st, resp = ev({"v": 1, "event": "completed"})
        check("事件缺 id -> 400", st == 400, f"{st} {resp}")
        st, resp = http(pet + "/event", raw=b"{not json")
        check("请求体不是 JSON -> 400", st == 400, f"{st} {resp}")
        st, resp = http(pet + "/event", raw=b'{"v":1,"id":"big","event":"completed","message":"' + b"x" * 70000 + b'"}')
        check("请求体超过 64 KiB -> 413", st == 413, f"{st} {resp}")
        st, resp = http(pet + "/nope", {"v": 1})
        check("没实现的路由 -> 404", st == 404, f"{st} {resp}")

        # ---- 10. token 轮换（宿主重启）-> 认证失败后重读握手文件再握手
        with host.lock:
            host.token = TOKEN_2
        got = wait_for(lambda: host.unauthorized > 0, 8)
        check("宿主换 token 后接收端的请求被拒（401）", bool(got), f"unauthorized={host.unauthorized}")
        with open(hs_path, "w", encoding="utf-8") as f:
            json.dump({"v": 1, "controlPort": HOST_PORT, "token": TOKEN_2,
                       "writtenAt": "2026-01-01T00:10:00.000Z"}, f)
        got = wait_for(lambda: TOKEN_2 in host.hello_tokens(), 12)
        check("认证失败后重读握手文件并用新 token 重新 /hello", bool(got), str(host.hello_tokens()))
        host.add_notice("N6")
        post_event("e12", "completed", "completed", "N6", seen=False)
        got = wait_for(lambda: host.acks_for("N6", "shown"), 8)
        check("换 token 之后 /ack 仍能成功（用新 token）", bool(got) and (got or [{}])[0].get("token") == TOKEN_2, str(got))

        # ---- 11. 屏幕输出（"上屏面"确实显示过）
        time.sleep(0.3)
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            log = f.read()
        check("控制台有可读的提示面板（有 [screen] 行）", "[screen] popups=" in log)
        check("面板里出现过具体提示文案（上屏语义成立）", "任务完成" in log and "token 上限" in log)
        check("面板里出现过「运行结束」中性文案", "运行结束" in log)

        # ---- 12. 接收端自己写的日志（--log）：中文必须是干净 UTF-8（PL-TS-NW-03 T3）
        with open(panel_path, "r", encoding="utf-8", errors="replace") as f:
            panel = f.read()
        check("--log 给出的文件由接收端自己写了面板", "[screen] popups=" in panel)
        check("--log 文件里的中文是干净 UTF-8（没有 shell 夹在中间解码）",
              "本机接收端口" in panel and "\ufffd" not in panel, panel[:120])

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        logf.close()
        srv.shutdown()

    print("-" * 60)
    print(f"通过 {PASSES} 项，失败 {len(FAILURES)} 项")
    for f in FAILURES:
        print(f"  FAILED: {f}")
    print(f"[selftest] 接收端日志留在 {log_path}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
