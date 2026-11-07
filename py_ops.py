#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dsh-bili-triple —— Python 半端（「本地环境」那一条）
============================================================================
宿主插件（index.js）**不自己发 HTTP 请求**，而是用它自己配好的 python.exe 起这个脚本，
把子命令的参数走 argv、结果走 stdout（一行 JSON）。

    python py_ops.py <cmd> [args...] --json '{...}'

约定的输出形状（宿主只看这一个）：

    {"ok": true,  "data": {...}}
    {"ok": false, "error": "人话", "code": 数字或 null, "data": {...}}

⚠️ stdout 只能有那**一行** JSON：bilibili_api 的 logger 走 stderr，宿主会丢掉它；
   真遇到"别的库往 stdout 打东西"，main() 最后那一步只取**最后一个能解析的行**。

子命令：
    whoami
    login-start                      出码（B站 passport 二维码）
    login-poll      --json {key}
    user-info       <uid>
    up-videos       <uid> --json {page,ps,order}
    search          <keyword> --json {num,order,page}
    rank            --json {num}
    fav-lists
    fav-content     <media_id> --json {page}
    video-state     <bvid>
    triple          <bvid> --json {coin,like,favMediaId,share,allowCoinWhenLiked}
    convert-uid     <输入>                 （用户手填的 UID / 空间链接 / BV / 视频链接）
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import sys
import tempfile
import time
import traceback
from pathlib import Path

import aiohttp

# ── 家目录 / 凭证文件 ───────────────────────────────────────────────────────
# 和「刷B站」共用同一份凭证：刷B站登录过一次，这边直接就是登录状态（反过来也一样）。
HOME = Path(__file__).resolve().parent
STATE_DIR = Path(os.environ.get("BILI_TRIPLE_HOME") or (Path.home() / ".dsh" / "bili-triple"))
DUTY_CRED = Path.home() / ".dsh" / "bili-duty" / "bili_credential.json"
OWN_CRED = STATE_DIR / "bili_credential.json"


def _cred_candidates() -> list[Path]:
    out = [OWN_CRED, DUTY_CRED]
    extra = os.environ.get("BILI_TRIPLE_CRED")
    if extra:
        out.insert(0, Path(extra))
    return out


def _read_cred_file(p: Path) -> dict:
    with p.open("r", encoding="utf-8-sig") as f:
        d = json.load(f)
    if not isinstance(d, dict):
        raise ValueError("凭证不是对象")
    for k in ("sessdata", "bili_jct"):
        if not d.get(k):
            raise ValueError(f"凭证缺 {k}")
    return d


def load_cred_dict() -> tuple[dict, Path]:
    errs = []
    for p in _cred_candidates():
        try:
            if p.exists():
                return _read_cred_file(p), p
        except Exception as e:  # noqa: BLE001
            errs.append(f"{p.name}: {e}")
    raise LoginRequired("还没登录 B 站（" + ("；".join(errs) if errs else "没找到凭证文件") + "）")


def save_cred_dict(d: dict, p: Path) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".cred-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


class LoginRequired(Exception):
    pass


class OpError(Exception):
    def __init__(self, msg: str, code=None, data=None):
        super().__init__(msg)
        self.code = code
        self.data = data


def get_cred():
    from bilibili_api import Credential

    d, _p = load_cred_dict()
    try:
        dede = int(d.get("dedeuserid") or 0)
    except (TypeError, ValueError):
        dede = 0
    return Credential(
        sessdata=d.get("sessdata") or None,
        bili_jct=d.get("bili_jct") or None,
        buvid3=d.get("buvid3") or None,
        dedeuserid=str(dede) if dede else None,
        ac_time_value=d.get("ac_time_value") or None,
    )


# ── 小工具 ────────────────────────────────────────────────────────────────
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def num(v, default=0):
    try:
        if isinstance(v, str):
            v = v.replace(",", "")
        return int(float(v))
    except (TypeError, ValueError):
        return default


def wrap(item: dict, **extra) -> dict:
    """把一个视频压成客户端要的那几个字段。

    B站 不同接口给的名字不一样：
      投稿列表  {bvid,title,author,mid,play,length,created,pic}
      搜索      {bvid,title,author,mid,play,duration,pubdate,pic,description}
      排行榜    {bvid,title,owner:{mid,name},stat:{view},duration,pubdate,pic}
      收藏夹    {bvid,title,upper:{mid,name},cnt_info:{play},duration,pubtime,cover}
    """
    owner = item.get("owner") if isinstance(item.get("owner"), dict) else {}
    upper = item.get("upper") if isinstance(item.get("upper"), dict) else {}
    stat = item.get("stat") if isinstance(item.get("stat"), dict) else {}
    cnt = item.get("cnt_info") if isinstance(item.get("cnt_info"), dict) else {}
    dur = item.get("duration") or item.get("length")
    if isinstance(dur, str) and ":" in dur:
        parts = [num(x) for x in dur.split(":")]
        dur = 0
        for p in parts:
            dur = dur * 60 + p
    d = {
        "bvid": item.get("bvid") or item.get("bv_id") or "",
        "aid": num(item.get("aid") or item.get("id") or stat.get("aid")),
        "title": clean_html(item.get("title") or ""),
        "author": str(owner.get("name") or upper.get("name") or item.get("author") or item.get("up_name") or ""),
        "mid": num(owner.get("mid") or upper.get("mid") or item.get("mid") or item.get("author_mid") or item.get("uid")),
        "play": num(item.get("play") or stat.get("view") or cnt.get("play") or item.get("view")),
        "duration": num(dur),
        "pubdate": num(item.get("pubdate") or item.get("created") or item.get("pubtime") or item.get("ctime") or item.get("senddate")),
        "pic": https(item.get("pic") or item.get("cover")),
        "desc": clean_html(str(item.get("description") or item.get("desc") or ""))[:200],
    }
    d.update(extra)
    return d


def https(u):
    u = str(u or "")
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("http://"):
        return "https://" + u[len("http://"):]
    return u


def clean_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s or "")
    s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
    return s.strip()


async def cmd_hot(args, opt):
    """热门：给「其他视频」当兜底池子（没点名 UP 主、也没配关键词时用）。"""
    from bilibili_api import hot

    num_ = min(50, max(1, num(opt.get("num"), 20)))
    pn = max(1, num(opt.get("page"), 1))
    raw = await hot.get_hot_videos(pn=pn, ps=num_)
    videos = []
    for it in (raw.get("list") or [])[:num_]:
        owner = it.get("owner") or {}
        videos.append(
            {
                "bvid": it.get("bvid") or "",
                "aid": num(it.get("aid")),
                "title": clean_html(str(it.get("title") or "")),
                "author": clean_html(str(owner.get("name") or "")),
                "mid": num(owner.get("mid")),
                "play": num((it.get("stat") or {}).get("view")),
                "duration": num(it.get("duration")),
                "pubdate": num(it.get("pubdate")),
                "pic": https(it.get("pic")),
                "desc": clean_html(str(it.get("desc") or ""))[:200],
            }
        )
    return {"page": pn, "num": len(videos), "videos": videos}



# ── 登录 ─────────────────────────────────────────────────────────────────
GEN_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
POLL_STATE = {
    86101: "waiting",   # 还没扫
    86090: "scanned",   # 扫了，没确认
    0: "ok",
    86038: "expired",   # 二维码过期
}


def _png_data_url(url: str) -> str | None:
    """把二维码画成 PNG（浏览器里 <img src> 直接用），没有 qrcode 库就算了。"""
    try:
        import qrcode  # type: ignore

        img = qrcode.make(url)
        buf = io.BytesIO()
        img.save(buf, format="PNG")  # type: ignore[arg-type]
        raw = buf.getvalue()
        try:
            (STATE_DIR).mkdir(parents=True, exist_ok=True)
            (STATE_DIR / "qrcode_login.png").write_bytes(raw)
        except OSError:
            pass
        return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
    except Exception:  # noqa: BLE001
        return None


async def cmd_login_start(_args, _opt):
    from bilibili_api.login_v2 import QrCodeLogin  # noqa: F401  （确认库在）

    async with aiohttp.ClientSession(headers={"User-Agent": _UA, "Referer": "https://www.bilibili.com/"}) as s:
        async with s.get(GEN_URL + "?source=main-fe-header") as r:
            j = await r.json(content_type=None)
    if j.get("code") != 0:
        raise OpError(f"出码失败：{j.get('message') or j}", code=j.get("code"))
    data = j.get("data") or {}
    url = data.get("url") or ""
    if not url:
        raise OpError("出码失败：接口没给 url")
    return {"key": data.get("qrcode_key"), "url": url, "qr": _png_data_url(url)}


_COOKIE_KEYS = {"sessdata": "SESSDATA", "bili_jct": "bili_jct", "dedeuserid": "DedeUserID", "buvid3": "buvid3"}


async def _get(url, params, cred):
    """带登录 cookie 的裸 GET，返回 data 字段（bilibili 的 code != 0 就抛）。"""
    cookie = ""
    if cred is not None:
        try:
            cookie = "SESSDATA=%s; bili_jct=%s; buvid3=%s" % (
                cred.sessdata or "",
                cred.bili_jct or "",
                getattr(cred, "buvid3", "") or "",
            )
        except AttributeError:
            cookie = ""
    headers = {"User-Agent": _UA, "Referer": "https://www.bilibili.com/"}
    if cookie:
        headers["Cookie"] = cookie
    async with aiohttp.ClientSession(headers=headers) as s:
        async with s.get(url, params=params) as r:
            j = await r.json(content_type=None)
    if j.get("code") != 0:
        raise OpError(f"{url} 返回 {j.get('code')}：{j.get('message') or ''}", code=j.get("code"))
    return j.get("data")


async def cmd_login_poll(_args, opt):
    key = str(opt.get("key") or "")
    if not key:
        raise OpError("缺 qrcode_key")
    async with aiohttp.ClientSession(headers={"User-Agent": _UA, "Referer": "https://www.bilibili.com/"}) as s:
        async with s.get(POLL_URL, params={"qrcode_key": key, "source": "main-fe-header"}) as r:
            j = await r.json(content_type=None)
            cookies = {}
            try:
                for m in r.cookies.values():  # type: ignore[attr-defined]
                    cookies[m.key] = m.value
            except Exception:  # noqa: BLE001
                pass
    code = num(j.get("code"), -1)
    data = j.get("data") or {}
    inner = num(data.get("code"), -1)
    state = POLL_STATE.get(inner) or POLL_STATE.get(code) or "unknown"
    if state != "ok":
        return {"state": state, "code": code, "inner": inner, "message": clean_html(data.get("message") or j.get("message") or "")}

    d = {}
    for k, cname in _COOKIE_KEYS.items():
        if cookies.get(cname):
            d[k] = cookies[cname]
    # 💡 用户确认后，url 里也带着同样的几个 cookie（refresh_token 等敏感项我们不存）
    try:
        from urllib.parse import parse_qs, urlparse

        q = parse_qs(urlparse(str(data.get("url") or "")).query)
        for k, cname in _COOKIE_KEYS.items():
            if not d.get(k) and q.get(cname):
                d[k] = q[cname][0]
    except Exception:  # noqa: BLE001
        pass
    if not d.get("sessdata") or not d.get("bili_jct"):
        raise OpError("确认了，但没拿到 SESSDATA / bili_jct —— 再扫一次")
    d["saved_at"] = int(time.time())
    save_cred_dict(d, OWN_CRED)   # 只写自己的家目录，不覆盖「刷B站」那份
    info = None
    try:
        info = await cmd_whoami([], {})
    except Exception:  # noqa: BLE001
        pass
    return {"state": "ok", "file": str(OWN_CRED), "user": info}


async def cmd_whoami(_args, _opt):
    d, p = load_cred_dict()
    from bilibili_api import user

    cred = get_cred()
    u = user.User(num(d.get("dedeuserid")), credential=cred)
    try:
        info = await u.get_user_info()
    except Exception as e:  # noqa: BLE001
        return {
            "loggedIn": False,
            "source": str(p),
            "uid": num(d.get("dedeuserid")),
            "error": f"凭证可能过期了：{e}",
        }
    return {
        "loggedIn": True,
        "source": str(p),
        "uid": num(info.get("mid"), num(d.get("dedeuserid"))),
        "name": info.get("name") or "",
        "face": https(info.get("face")),
        "level": num(info.get("level")),
        "vip": ((info.get("vip") or {}).get("label") or {}).get("text") or "",
    }


# ── 视频来源 ──────────────────────────────────────────────────────────────
_ORDER_MAP = {"pubdate": "pubdate", "click": "click", "stow": "stow"}


async def cmd_user_info(args, _opt):
    uid = num(args[0] if args else 0)
    if not uid:
        raise OpError("缺 UID")
    from bilibili_api import user

    u = user.User(uid, credential=_try_cred())
    info = await u.get_user_info()
    rel = {}
    try:
        rel = await u.get_relation_info()
    except Exception:  # noqa: BLE001
        pass
    counts = await _space_counts(uid)
    out = {
        "uid": uid,
        "name": info.get("name") or "",
        "face": https(info.get("face")),
        "sign": clean_html(str(info.get("sign") or ""))[:120],
        "level": num(info.get("level")),
        "fans": num(rel.get("follower")),
        "archives": counts["archives"],
        "likes": counts["likes"],
    }
    return out


def _try_cred():
    try:
        return get_cred()
    except LoginRequired:
        return None


# 热度/获赞数：relation_stat 里没有，走 https://api.bilibili.com/x/space/upstat 补一刀（拿不到就算了）
async def _space_counts(uid):
    """投稿数 / 获赞数 / 播放天数：relation_stat 里没有，单独补一枪（失败就返回 0）。"""
    cred = _try_cred()
    if cred is None:
        return {"archives": 0, "likes": 0}
    try:
        raw = await _get("https://api.bilibili.com/x/space/upstat", {"mid": uid}, cred)
        st = (raw or {}).get("archive") or {}
        return {"archives": num(st.get("count")), "likes": num((raw or {}).get("likes"))}
    except Exception:  # noqa: BLE001
        pass
    return {"archives": 0, "likes": 0}


async def cmd_up_videos(args, opt):
    uid = num(args[0] if args else opt.get("uid"))
    if not uid:
        raise OpError("缺 UID")
    pn = max(1, num(opt.get("page"), 1))
    ps = min(50, max(1, num(opt.get("ps"), 30)))
    order = _ORDER_MAP.get(str(opt.get("order") or "pubdate"), "pubdate")
    from bilibili_api import user

    u = user.User(uid, credential=_try_cred())
    vo = {"pubdate": user.VideoOrder.PUBDATE, "click": user.VideoOrder.VIEW, "stow": user.VideoOrder.FAVORITE}[order]
    r = await u.get_videos(pn=pn, ps=ps, order=vo)
    lst = (r.get("list") or {})
    vlist = lst.get("vlist") or []
    total = num((r.get("page") or {}).get("count"), len(vlist))
    videos = [wrap(v, mid=uid, author=v.get("author") or "") for v in vlist]
    return {"uid": uid, "page": pn, "ps": ps, "total": total, "videos": videos, "hasMore": pn * ps < total}


async def cmd_search(args, opt):
    kw = (args[0] if args else opt.get("keyword")) or ""
    kw = str(kw).strip()
    if not kw:
        raise OpError("缺搜索关键词")
    n = max(1, min(50, num(opt.get("num"), 30)))
    page = max(1, num(opt.get("page"), 1))
    order = str(opt.get("order") or "pubdate")
    from bilibili_api import search

    od = {
        "pubdate": search.OrderVideo.PUBDATE,
        "click": search.OrderVideo.CLICK,
        "totalrank": search.OrderVideo.TOTALRANK,
        "dm": search.OrderVideo.DM,
        "scores": search.OrderVideo.SCORES,
    }.get(order, search.OrderVideo.PUBDATE)
    r = await search.search_by_type(
        kw,
        search_type=search.SearchObjectType.VIDEO,
        order_type=od,
        page=page,
        page_size=min(42, max(n, 10)),
    )
    res = r.get("result") or []
    videos = [wrap(x) for x in res][:n]
    return {"keyword": kw, "page": page, "num": len(videos), "numResults": num(r.get("numResults")), "videos": videos}


async def cmd_rank(_args, opt):
    n = max(1, min(100, num(opt.get("num"), 30)))
    from bilibili_api import rank

    r = await rank.get_rank(type_=rank.RankType.All, day=rank.RankDayType.THREE_DAY)
    lst = r.get("list") or []
    videos = [wrap(x) for x in lst][:n]
    return {"num": len(videos), "videos": videos}


async def cmd_fav_lists(_args, _opt):
    d, _p = load_cred_dict()
    from bilibili_api import favorite_list

    cred = get_cred()
    me = num(d.get("dedeuserid"))
    r = await favorite_list.get_video_favorite_list(uid=me, credential=cred)
    out = []
    for x in r.get("list") or []:
        # ⚠️ 这个接口的每一项**就是**收藏夹本身（id / title 在顶层），不是 media_list 包一层
        out.append({"id": num(x.get("id")), "title": clean_html(x.get("title") or ""), "count": num(x.get("media_count"))})
    out = [x for x in out if x["id"]]
    # 「默认收藏夹」排第一个：三连没指定收藏夹时就用它
    out.sort(key=lambda x: (0 if "默认" in x["title"] else 1, x["count"]))
    return {"lists": out}


async def cmd_fav_content(args, opt):
    mid = num(args[0] if args else opt.get("media_id"))
    if not mid:
        raise OpError("缺收藏夹 id")
    page = max(1, num(opt.get("page"), 1))
    from bilibili_api import favorite_list

    cred = get_cred()
    r = await favorite_list.get_video_favorite_list_content(media_id=mid, page=page, credential=cred)
    vids = []
    for m in r.get("medias") or []:
        vids.append(
            wrap(
                {
                    "bvid": m.get("bvid"),
                    "title": m.get("title"),
                    "author": (m.get("upper") or {}).get("name"),
                    "mid": (m.get("upper") or {}).get("mid"),
                    "play": (m.get("cnt_info") or {}).get("play"),
                    "duration": m.get("duration"),
                    "pubdate": m.get("pubtime") or m.get("fav_time"),
                    "cover": m.get("cover"),
                }
            )
        )
    return {"mediaId": mid, "page": page, "hasMore": bool(r.get("has_more")), "videos": vids}


async def cmd_convert_uid(args, _opt):
    """用户手填的东西 → UID。认：纯数字、space.bilibili.com/123、video/BVxxx、BV 号本身。"""
    raw = str(args[0] if args else "").strip()
    if not raw:
        raise OpError("空输入")
    m = re.match(r"^(\d{1,12})$", raw)
    if m:
        return {"uid": int(m.group(1)), "how": "uid"}
    m = re.search(r"space\.bilibili\.com/(\d+)", raw) or re.search(r"^uid[:：]?\s*(\d+)$", raw, re.I)
    if m:
        return {"uid": int(m.group(1)), "how": "space-link"}
    m = re.search(r"(BV[0-9A-Za-z]{10})", raw) or re.search(r"av(\d+)", raw, re.I)
    if m:
        bv = m.group(1) if m.group(0).startswith("BV") else None
        from bilibili_api import video

        v = video.Video(bvid=bv) if bv else video.Video(aid=int(m.group(1)), credential=_try_cred())
        info = await v.get_info()
        return {"uid": num((info.get("owner") or {}).get("mid")), "how": "video", "videoTitle": info.get("title") or ""}
    raise OpError("看不出这是谁：填 UID（纯数字）或空间链接就行")


# ── 三连 ─────────────────────────────────────────────────────────────────
# 「其实已经做过了」这类错误码：不算失败，当成"本来就有"处理。
BENIGN = {
    71002: "已经点过赞了",
    65006: "重复点赞",
    34005: "硬币已经投过了 / 投币数上限",
    34006: "已经收藏过了",
    34003: "已经收藏过了",
    34103: "已经收藏过了",
    34004: "这是 UP 自己的投稿，投不了币",
}


def _probe(fn):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return None


async def cmd_video_state(args, _opt):
    bvid = str(args[0] if args else "").strip()
    if not re.match(r"^(BV[0-9A-Za-z]{10}|av\d+)$", bvid):
        raise OpError("视频号不对：" + bvid)
    from bilibili_api import video

    v = video.Video(bvid=bvid, credential=_try_cred())
    info = None
    info_err = None
    try:
        info = await v.get_info()
    except Exception as e:  # noqa: BLE001
        info_err = str(e)
    cred = _try_cred()
    out = {"bvid": bvid}
    if info:
        out.update(
            {
                "aid": num(info.get("aid")),
                "title": info.get("title") or "",
                "author": (info.get("owner") or {}).get("name") or "",
                "mid": num((info.get("owner") or {}).get("mid")),
                "play": num((info.get("stat") or {}).get("view")),
                "duration": num(info.get("duration")),
                "pubdate": num(info.get("pubdate")),
                "pic": https(info.get("pic")),
            }
        )
    elif info_err:
        out["infoError"] = info_err
    if cred is not None:
        try:
            out["liked"] = bool(await v.has_liked())
        except Exception as e:  # noqa: BLE001
            out["liked"] = None
            out["likedError"] = str(e)[:120]
        try:
            out["coins"] = num(await v.get_pay_coins())
        except Exception:  # noqa: BLE001
            out["coins"] = None
        try:
            out["favoured"] = bool(await v.has_favoured())
        except Exception:  # noqa: BLE001
            out["favoured"] = None
    return out


async def cmd_triple(args, opt):
    bvid = str(args[0] if args else "").strip()
    if not re.match(r"^(BV[0-9A-Za-z]{10}|av\d+)$", bvid):
        raise OpError("视频号不对：" + bvid)
    cred = get_cred()
    from bilibili_api import video

    v = video.Video(bvid=bvid, credential=cred)
    want_coin = 2 if num(opt.get("coin"), 1) >= 2 else 1
    want_like = bool(opt.get("like", True))
    want_fav = bool(opt.get("fav", True))
    fav_mid = num(opt.get("favMediaId"))
    want_share = bool(opt.get("share", False))
    coin_when_liked = bool(opt.get("allowCoinWhenLiked", True))

    steps: list[dict] = []
    state = {"liked": None, "coins": None, "favoured": None, "raw": {}}

    # 先看现状：已经做过的就别再打一次接口（B站 对重复操作有时不报错，白白触发风控）
    for k, fn in (("liked", v.has_liked), ("coins", v.get_pay_coins), ("favoured", v.has_favoured)):
        try:
            state[k] = await fn()
        except Exception as e:  # noqa: BLE001
            state["raw"][k] = str(e)[:120]
    if state["coins"] is not None:
        state["coins"] = num(state["coins"])

    async def step(name: str, coro_factory):
        try:
            r = await coro_factory()
            if isinstance(r, dict):
                state["raw"][name] = r
            steps.append({"step": name, "ok": True})
            return True
        except Exception as e:  # noqa: BLE001
            code = getattr(e, "code", None)
            code = num(code, None)
            msg = str(e)
            if code in BENIGN:
                steps.append({"step": name, "ok": True, "skipped": True, "message": BENIGN[code], "code": code})
                return True
            steps.append({"step": name, "ok": False, "message": msg[:200], "code": code})
            return False

    # ① 点赞
    if want_like:
        if state["liked"] is True:
            steps.append({"step": "like", "ok": True, "skipped": True, "message": "本来就已经赞了"})
        else:
            await step("like", lambda: v.like(True))

    # ② 投币（自己投自己的视频会报 34004，那算正常的失败，不当故障）
    if want_coin:
        if not coin_when_liked and state["liked"] is True and state["coins"] in (0, None):
            steps.append({"step": "coin", "ok": True, "skipped": True, "message": "设置里没开「赞过也投币」"})
        elif state["coins"]:
            steps.append({"step": "coin", "ok": True, "skipped": True, "message": f"已经投过 {state['coins']} 币"})
        else:
            await step("coin", lambda: v.pay_coin(num=want_coin, like=False))

    # ③ 收藏 —— ⚠️ 收藏接口**必须带收藏夹 id**（只传 rid 会被 B站 400 打回）。
    #    什么都没指定时用 media_id=2（B站系统收藏夹「稍后再看」，任何账号都有、不会失效）；
    #    以前退回「默认收藏夹」（id 随账号不同），老账号里可能碰到 401/410 这类已失效的收藏夹。
    if want_fav:
        mid = fav_mid or num(opt.get("defaultFavId")) or 2
        if state["favoured"] is True and not fav_mid:
            steps.append({"step": "fav", "ok": True, "skipped": True, "message": "本来就已经收藏了"})
        else:
            await step("fav", lambda: v.set_favorite(add_media_ids=[mid]))

    # ④ 分享（自选项：只算「分享」那天的经验，不会发到动态）
    if want_share:
        await step("share", lambda: v.share())

    ok = all(s.get("ok") for s in steps)
    title = ""
    aid = None
    try:
        info = await v.get_info()
        title = info.get("title") or ""
        aid = num(info.get("aid"))
    except Exception:  # noqa: BLE001
        pass
    # 回读一遍：结果以接口说的为准，而不是"没抛异常 = 成功"
    after = {}
    for k, fn in (("liked", v.has_liked), ("coins", v.get_pay_coins), ("favoured", v.has_favoured)):
        try:
            after[k] = await fn()
        except Exception:  # noqa: BLE001
            after[k] = None
    if after.get("coins") is not None:
        after["coins"] = num(after["coins"])
    return {"bvid": bvid, "aid": aid, "title": title, "ok": ok, "steps": steps, "before": {**{k: state[k] for k in ("liked", "coins", "favoured")}}, "after": after}


# ── 入口 ─────────────────────────────────────────────────────────────────
COMMANDS = {
    "whoami": cmd_whoami,
    "login-start": cmd_login_start,
    "login-poll": cmd_login_poll,
    "user-info": cmd_user_info,
    "up-videos": cmd_up_videos,
    "search": cmd_search,
    "rank": cmd_rank,
    "hot": cmd_hot,
    "fav-lists": cmd_fav_lists,
    "fav-content": cmd_fav_content,
    "convert-uid": cmd_convert_uid,
    "video-state": cmd_video_state,
    "triple": cmd_triple,
}


async def run(argv: list[str]):
    if not argv or argv[0] in ("-h", "--help", "help"):
        return {"ok": True, "data": {"commands": sorted(COMMANDS)}}
    cmd = argv[0]
    rest: list[str] = []
    opt: dict = {}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            i += 1
            if i >= len(argv):
                raise OpError("--json 后面没内容")
            opt = json.loads(argv[i])
            if not isinstance(opt, dict):
                raise OpError("--json 必须是对象")
        else:
            rest.append(a)
        i += 1
    fn = COMMANDS.get(cmd)
    if not fn:
        raise OpError(f"不认识的子命令：{cmd}")
    data = await fn(rest, opt)
    return {"ok": True, "data": data}


def main() -> int:
    argv = sys.argv[1:]
    # Windows 上子进程的默认编码是本地代码页（cp936），json.dumps 出来的中文和
    # 各种符号会直接报错 —— 先把 stdout/stderr 钉成 UTF-8（宿主按 UTF-8 解）。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    try:
        res = asyncio.run(asyncio.wait_for(run(argv), timeout=180))
    except LoginRequired as e:
        res = {"ok": False, "loginRequired": True, "error": str(e)}
    except OpError as e:
        res = {"ok": False, "error": str(e), "code": e.code, "data": e.data}
    except asyncio.TimeoutError:
        res = {"ok": False, "error": "超时（180 秒）—— B站 那边没回"}
    except Exception as e:  # noqa: BLE001
        res = {"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
    line = json.dumps(res, ensure_ascii=False)
    out = getattr(sys.stdout, "buffer", None)
    if out is not None:
        out.write(line.encode("utf-8", "replace") + b"\n")
        out.flush()
    else:  # pragma: no cover
        print(line)
    return 0 if res.get("ok") else 0   # 结论在 JSON 里，退出码不区分（宿主只看 JSON）


if __name__ == "__main__":
    sys.exit(main())
