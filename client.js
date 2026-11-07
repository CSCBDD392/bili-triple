/**
 * dsh-bili-triple —— 浏览器半端
 * ============================================================================
 * 三处入口，同一份面板：
 *
 *   ① 左侧栏图标（slot `sidebar.panellist`, id `bili-triple`, order 40）
 *      —— 点一下就把**主区**切到 `main` 槽里的同名 key（侧栏 id 就是主区 key）
 *   ② 主区面板（slot `main`, key `bili-triple`）
 *   ③ 设置里一页（slot `settings.section`, id `bili-triple`, order 35）
 *
 * 面板里三块：
 *   · 登录：扫码 QR 直接显示在页里；登录状态一行（昵称 / UID / 凭证从哪儿读的）
 *   · 挑视频：**先挑指定 UP 主的视频，再挑其他视频** —— 和「刷B站」一样能自己勾
 *   · 设置：给每个 UP 主配一条「三连规则」（赞不赞、投几币、收不收藏、收哪个夹、
 *     是不是只认新视频），再加一段「其他视频」的规则（关键词 / 排行榜 / 每轮几条）
 *
 * ⚠️ client bundle **不是 ESM**，是自注册脚本：window.__ModuleLoader__.load({ id, factory })，
 *    而且 id 必须等于 package.json 的 name（这里是 @local/bili-triple）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: '@local/bili-triple',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const API = '/api/bili-triple'

    /* ── 跟宿主说话 ───────────────────────────────────────────────────── */

    async function asJson(res) {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（没权限）' : res.status === 403 ? '（被宿主挡了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin', cache: 'no-store' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    /* ── 小工具 ────────────────────────────────────────────────────────── */

    const fmtNum = (n) => {
      const v = Number(n) || 0
      if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'
      if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万'
      return String(v)
    }
    const fmtDur = (s) => {
      const v = Number(s) || 0
      const m = Math.floor(v / 60)
      const ss = v % 60
      return m + ':' + String(ss).padStart(2, '0')
    }
    const fmtAgo = (sec) => {
      const t = Number(sec) || 0
      if (!t) return ''
      const d = (Date.now() / 1000) - t
      if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' 分钟前'
      if (d < 86400) return Math.round(d / 3600) + ' 小时前'
      if (d < 86400 * 30) return Math.round(d / 86400) + ' 天前'
      const dt = new Date(t * 1000)
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    }
    const fmtCountdown = (ms) => {
      if (ms <= 0) return '马上'
      const m = Math.round(ms / 60000)
      if (m < 60) return m + ' 分钟'
      const hh = Math.floor(m / 60)
      const mm = m % 60
      return hh + ' 小时' + (mm ? ' ' + mm + ' 分' : '')
    }
    const biliLink = (bvid) => 'https://www.bilibili.com/video/' + bvid

    /* ── 样式（只用真实存在的主题变量，拿不到就退回中性灰） ──────────────── */

    const CSS = `
[data-bt-page]{display:flex;flex-direction:column;gap:14px;padding:2px 2px 10px;max-width:760px;width:100%;}
[data-bt-page][data-bt-wide]{max-width:none;}
[data-bt-head]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-bt-title]{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
[data-bt-grow]{flex:1;min-width:0;}
[data-bt-sec]{display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));}
[data-bt-h]{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary,inherit);}
[data-bt-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,inherit);word-break:break-word;}
[data-bt-row]{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
[data-bt-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;padding:0;
  background:var(--dsw-alias-border-l2,rgba(128,128,128,.35));transition:background .15s;}
[data-bt-sw][data-on]{background:var(--dsw-alias-brand-primary,#3b82f6);}
[data-bt-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bt-sw][data-on] i{left:19px;}
[data-bt-sw][disabled]{opacity:.45;cursor:default;}
[data-bt-input]{box-sizing:border-box;padding:6px 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));
  background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);}
[data-bt-input]:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b82f6);}
[data-bt-input][data-bt-full]{width:100%;}
[data-bt-input][data-bt-num]{width:80px;text-align:center;}
select[data-bt-input]{color-scheme:light dark;}
select[data-bt-input] option,select[data-bt-input] optgroup{
  background-color:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);}
[data-bt-btn]{padding:6px 11px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit);}
[data-bt-btn]:hover{border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.55));}
[data-bt-btn][data-bt-primary]{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent;color:#fff;}
[data-bt-btn][data-bt-danger]{color:var(--dsw-alias-state-error-primary,#e5484d);}
[data-bt-btn][disabled]{opacity:.5;cursor:default;}
[data-bt-tabs]{display:flex;gap:4px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));}
[data-bt-tab]{flex:1;min-width:0;cursor:pointer;font:inherit;font-size:13px;padding:6px 10px;border:0;border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary,inherit);}
[data-bt-tab][aria-selected=true]{background:var(--dsw-alias-bg-base,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,inherit);
  font-weight:600;}
[data-bt-chip]{cursor:pointer;white-space:nowrap;font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;
  color:var(--dsw-alias-label-secondary,inherit);}
[data-bt-chip][aria-selected=true]{color:var(--dsw-alias-label-primary,inherit);font-weight:600;
  border-color:var(--dsw-alias-brand-primary,#3b82f6);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 18%,transparent);}
[data-bt-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,inherit);}
[data-bt-msg][data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#f59e0b);}
[data-bt-msg][data-tone=good]{color:var(--dsw-alias-state-success-primary,#22c55e);}
[data-bt-msg][data-tone=bad]{color:var(--dsw-alias-state-error-primary,#e5484d);}
[data-bt-qr]{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;}
[data-bt-qr] img{width:150px;height:150px;border-radius:10px;background:#fff;padding:6px;display:block;}
[data-bt-user]{display:flex;gap:10px;align-items:center;}
[data-bt-user] img{width:34px;height:34px;border-radius:50%;object-fit:cover;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.15));}
[data-bt-list]{display:flex;flex-direction:column;gap:6px;max-height:none;}
[data-bt-item]{display:flex;gap:10px;align-items:flex-start;padding:7px 8px;border-radius:10px;
  border:1px solid transparent;}
[data-bt-item]:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));}
[data-bt-item][data-picked]{border-color:var(--dsw-alias-brand-primary,rgba(76,141,255,.6));
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 10%,transparent);}
[data-bt-item] img.cover{width:96px;height:54px;flex:none;border-radius:7px;object-fit:cover;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.15));}
[data-bt-it]{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}
[data-bt-it-t]{font-size:12.5px;line-height:17px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
[data-bt-it-t] a{color:inherit;text-decoration:none;}
[data-bt-it-t] a:hover{text-decoration:underline;}
[data-bt-it-n]{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary,inherit);}
[data-bt-check]{flex:none;margin-top:2px;width:15px;height:15px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#3b82f6);}
[data-bt-rule]{display:flex;flex-direction:column;gap:8px;padding:10px 11px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));}
[data-bt-tag]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,inherit);}
[data-bt-pre]{margin:0;padding:8px 9px;border-radius:8px;max-height:220px;overflow:auto;font-size:11px;line-height:15px;
  white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.14));
  color:var(--dsw-alias-label-secondary,inherit);}
[data-bt-badge]{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,inherit);}
[data-bt-badge][data-on]{color:var(--dsw-alias-state-success-primary,#22c55e);}
[data-bt-badge][data-off]{color:var(--dsw-alias-state-warn-primary,#f59e0b);}
[data-bt-empty]{padding:26px 12px;text-align:center;font-size:12px;line-height:1.8;
  color:var(--dsw-alias-label-secondary,inherit);}
`

    /* ── 通用小部件 ────────────────────────────────────────────────────── */

    function Switch({ on, onChange, disabled, title }) {
      return h('button', {
        type: 'button',
        'data-bt-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: title || undefined,
        onClick: () => onChange && onChange(!on),
      }, h('i', null))
    }

    function Row({ children, style }) {
      return h('div', { 'data-bt-row': '', style }, children)
    }

    function Sec({ title, children, note }) {
      return h('div', { 'data-bt-sec': '' },
        title ? h('div', { 'data-bt-h': '' }, title) : null,
        children,
        note ? h('div', { 'data-bt-note': '' }, note) : null,
      )
    }

    function Msg({ tone, children }) {
      if (children === null || children === undefined || children === '') return null
      return h('div', { 'data-bt-msg': '', 'data-tone': tone || undefined }, children)
    }

    function TriBar({ value, onChange, disabled }) {
      // 三个小圆点：赞 / 币 / 藏 —— 点一下切换
      const items = [['赞', 'doLike'], ['币', 'doCoin'], ['藏', 'doFav']]
      return h(Row, null, items.map(([text, key]) =>
        h('button', {
          key,
          type: 'button',
          'data-bt-chip': '',
          'aria-selected': value[key] ? 'true' : 'false',
          disabled: Boolean(disabled),
          onClick: () => onChange && onChange({ ...value, [key]: !value[key] }),
        }, text)))
    }

    function VideoItem({ v, checked, onToggle, extra }) {
      return h('div', { 'data-bt-item': '', 'data-picked': checked ? '' : undefined },
        h('input', {
          type: 'checkbox',
          'data-bt-check': '',
          checked: Boolean(checked),
          onChange: () => onToggle && onToggle(!checked),
        }),
        h('img', { className: 'cover', src: v.pic || undefined, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }),
        h('div', { 'data-bt-it': '' },
          h('div', { 'data-bt-it-t': '' }, h('a', { href: biliLink(v.bvid), target: '_blank', rel: 'noreferrer noopener' }, v.title || v.bvid)),
          h('div', { 'data-bt-it-n': '' },
            [v.author || (v.mid ? 'UP ' + v.mid : ''), fmtNum(v.play) + ' 播放', v.duration ? fmtDur(v.duration) : '', fmtAgo(v.pubdate)]
              .filter(Boolean).join(' · ')),
          extra ? h('div', { 'data-bt-it-n': '' }, extra) : null,
        ))
    }

    /* ── 登录块 ────────────────────────────────────────────────────────── */

    function LoginBox({ st, onRefresh, busy, setBusy }) {
      const [qr, setQr] = useState(null)
      const [state, setState] = useState('')
      const [tip, setTip] = useState('')
      const keyRef = useRef('')
      const timerRef = useRef(null)

      const stop = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }
      useEffect(() => stop, [])

      const start = async () => {
        stop()
        setBusy('login')
        setTip('')
        try {
          setState('loading')
          const r = await jpost('/login/start', {})
          if (!r.ok) { setState('error'); setTip(r.error || '出码失败'); return }
          keyRef.current = r.key
          setQr(r.qr || null)
          setState('waiting')
          timerRef.current = setInterval(async () => {
            try {
              const p = await jpost('/login/poll', { key: keyRef.current })
              const s = p.state || 'unknown'
              setState(s)
              if (s === 'ok') {
                stop()
                setTip('登录成功' + (p.user && p.user.name ? '：' + p.user.name : ''))
                setQr(null)
                onRefresh && onRefresh()
              } else if (s === 'expired') {
                stop()
                setTip('二维码过期了，再点一次')
              }
            } catch (e) {
              /* 网络抖一下就下一轮再说 */
            }
          }, 2000)
        } catch (e) {
          setState('error')
          setTip(String((e && e.message) || e))
        } finally {
          setBusy(null)
        }
      }

      const logout = async () => {
        stop()
        setBusy('logout')
        try {
          const r = await jpost('/logout', {})
          setTip(r.ok ? '已退出（凭证已删）' : (r.error || '退出失败'))
          onRefresh && onRefresh()
        } catch (e) {
          setTip(String((e && e.message) || e))
        } finally {
          setBusy(null)
        }
      }

      const login = (st && st.login) || {}
      const stateText = {
        loading: '正在出码…',
        waiting: '用手机 B站 扫这个码',
        scanned: '扫到了，在手机上点「确认登录」',
        expired: '二维码过期了',
        error: '出码失败',
        unknown: '等结果…',
      }[state] || ''

      return h(Sec, {
        title: '账号',
        note: login.loggedIn
          ? `凭证读自：${login.source || '（不知道）'}`
          : '① 没登录过就看这里，扫码扫一下就行；② 也会自动用「刷B站」那份凭证（那边登录过这边直接能用）',
      },
      login.loggedIn
        ? h(Row, null,
          h('div', { 'data-bt-user': '' },
            login.face ? h('img', { src: login.face, alt: '', referrerPolicy: 'no-referrer' }) : null,
            h('div', { 'data-bt-it': '' },
              h('div', { 'data-bt-it-t': '' }, login.name || '（没名字）'),
              h('div', { 'data-bt-it-n': '' }, `UID ${login.uid || '?'}${login.level ? ' · LV' + login.level : ''}${login.vip ? ' · ' + login.vip : ''}`))),
          h('div', { 'data-bt-grow': '' }),
          h('button', { 'data-bt-btn': '', disabled: busy === 'login', onClick: start }, '重新扫码登录'),
          h('button', { 'data-bt-btn': '', 'data-bt-danger': '', disabled: busy === 'logout', onClick: logout }, '退出'))
        : h('div', { 'data-bt-qr': '' },
          qr ? h('img', { src: qr, alt: '登录二维码' }) : null,
          h('div', { 'data-bt-it': '', style: { flex: '1 1 200px' } },
            h(Msg, { tone: state === 'ok' ? 'good' : state === 'error' || state === 'expired' ? 'bad' : undefined },
              login.error ? '读不到登录状态：' + login.error : ''),
            h('div', { 'data-bt-note': '' }, stateText),
            h(Row, { style: { marginTop: 8 } },
              h('button', { 'data-bt-btn': '', 'data-bt-primary': '', disabled: busy === 'login', onClick: start },
                qr ? '换一张码' : '扫码登录'),
              state === 'expired' ? h('button', { 'data-bt-btn': '', onClick: start }, '重来') : null)),
            tip ? h('div', { style: { marginTop: 8 } }, h(Msg, { tone: 'good' }, tip)) : null))
    }
    // 注：上面的三元表达式里两个分支都自带结尾的 ')' —— 这里不再多补一个

    /* ── 挑视频：先 UP 主，再其他 ──────────────────────────────────────── */

    function PickTab({ st, cfg, patchCfg, busy, setBusy, picked, setPicked }) {
      const [sub, setSub] = useState('up')          // 'up' | 'other' | 'fav'
      // —— UP 主 ——
      const [uidInput, setUidInput] = useState('')
      const [upInfo, setUpInfo] = useState(null)
      const [upVideos, setUpVideos] = useState([])
      const [upPage, setUpPage] = useState(1)
      const [upTotal, setUpTotal] = useState(0)
      const [upBusy, setUpBusy] = useState(false)
      const [upMsg, setUpMsg] = useState('')
      const [order, setOrder] = useState('pubdate')
      const [uaid, setUaid] = useState('')           // 粘贴 BV/av/链接进来
      // —— 其他视频 ——
      const [kw, setKw] = useState('')
      const [kwOrder, setKwOrder] = useState((cfg && cfg.otherOrder) || 'pubdate')
      const [otherVideos, setOtherVideos] = useState([])
      const [otherBusy, setOtherBusy] = useState(false)
      const [otherMsg, setOtherMsg] = useState('')
      const [source, setSource] = useState('kw')    // 'kw' | 'rank'
      const [rankN, setRankN] = useState(30)
      // —— 三连参数 ——
      const [opt, setOpt] = useState({ doLike: true, doCoin: true, coinNum: 1, doFav: true })
      const [favId, setFavId] = useState(0)
      const [dryRun, setDryRun] = useState(false)
      const [resultLog, setResultLog] = useState(null)

      const favLists = (st && st.favLists) || []
      const rules = (cfg && cfg.upRules) || []

      const pickCount = picked.length

      const toggle = (v) => {
        setPicked((prev) => {
          const has = prev.find((x) => x.bvid === v.bvid)
          if (has) return prev.filter((x) => x.bvid !== v.bvid)
          return [...prev, { bvid: v.bvid, title: v.title, author: v.author, mid: v.mid }]
        })
      }
      const isPicked = (bvid) => picked.some((x) => x.bvid === bvid)

      const loadUser = async (uid) => {
        const u = String(uid || '').trim()
        if (!u) { setUpMsg('先填个 UID'); return }
        setUpBusy(true)
        setUpMsg('')
        try {
          const r = await jget('/convert-uid?q=' + encodeURIComponent(u))
          if (!r.ok || !r.uid) { setUpMsg('看不出这是谁：' + (r.error || '')); return }
          const info = await jget('/user-info?uid=' + encodeURIComponent(r.uid))
          setUpInfo(info.ok ? info : { uid: r.uid })
          setUidInput(String(r.uid))
          await loadVideos(r.uid, 1)
        } catch (e) {
          setUpMsg(String((e && e.message) || e))
        } finally {
          setUpBusy(false)
        }
      }

      const loadVideos = async (uid, page) => {
        setUpBusy(true)
        setUpMsg('')
        try {
          const r = await jget(`/up-videos?uid=${encodeURIComponent(uid)}&page=${page}&ps=30&order=${order}`)
          if (!r.ok) { setUpMsg(r.error || '拿不到投稿'); return }
          setUpVideos(r.videos || [])
          setUpTotal(r.total || 0)
          setUpPage(page)
        } catch (e) {
          setUpMsg(String((e && e.message) || e))
        } finally {
          setUpBusy(false)
        }
      }

      const byBvid = async () => {
        const raw = uaid.trim()
        if (!raw) return
        setUpBusy(true)
        setUpMsg('')
        try {
          const r = await jget('/video-state?bvid=' + encodeURIComponent(raw))
          if (!r.ok) { setUpMsg(r.error || '查不到这条视频'); return }
          const v = {
            bvid: r.bvid, title: r.title || r.bvid, author: r.author || '', mid: r.mid || 0,
            play: r.play || 0, duration: r.duration || 0, pubdate: r.pubdate || 0, pic: r.pic || '',
          }
          setUpVideos([v])
          setUpTotal(1)
          setUpPage(1)
          setUpInfo(r.mid ? { uid: r.mid, name: r.author } : null)
          setUpMsg('已按 BV 号查出这条视频 —— 记得先勾上再点「三连选中的」')
        } catch (e) {
          setUpMsg(String((e && e.message) || e))
        } finally {
          setUpBusy(false)
        }
      }

      const loadOther = async () => {
        setOtherBusy(true)
        setOtherMsg('')
        try {
          if (source === 'kw') {
            if (!kw.trim()) { setOtherMsg('先填个关键词'); return }
            const r = await jget(`/search?q=${encodeURIComponent(kw.trim())}&num=30&order=${kwOrder}`)
            if (!r.ok) { setOtherMsg(r.error || '搜不到'); return }
            setOtherVideos(r.videos || [])
            setOtherMsg(`「${kw.trim()}」共 ${r.videos ? r.videos.length : 0} 条`)
          } else {
            const r = await jget('/rank?num=' + rankN)
            if (!r.ok) { setOtherMsg(r.error || '排行榜拿不到'); return }
            setOtherVideos(r.videos || [])
            setOtherMsg(`排行榜前 ${(r.videos || []).length} 条`)
          }
        } catch (e) {
          setOtherMsg(String((e && e.message) || e))
        } finally {
          setOtherBusy(false)
        }
      }

      const runTriple = async (items) => {
        if (!items.length) return
        setBusy && setBusy('triple')
        setResultLog(null)
        try {
          const r = await jpost('/triple', {
            tag: sub === 'up' ? '手动挑选·UP' : '手动挑选·其他',
            items: items.map((x) => ({ bvid: x.bvid })),
            ...opt,
            favMediaId: Number(favId) || 0,
            dryRun,
          })
          setResultLog(r)
          if (r.ok) setPicked([])
          st && st.refresh && st.refresh()
        } catch (e) {
          setResultLog({ ok: false, error: String((e && e.message) || e) })
        } finally {
          setBusy && setBusy(null)
        }
      }

      const selectAll = (list) => setPicked((prev) => {
        const map = new Map(prev.map((x) => [x.bvid, x]))
        for (const v of list) map.set(v.bvid, { bvid: v.bvid, title: v.title, author: v.author, mid: v.mid })
        return [...map.values()]
      })

      const tripleOpts = h(Sec, {
        title: '这次怎么三连',
      },
      h(Row, null,
        h('span', { 'data-bt-note': '' }, '做哪些：'),
        h(TriBar, { value: opt, onChange: (v) => setOpt(v) }),
        h('span', { 'data-bt-note': '' }, '投几个币：'),
        h('select', {
          'data-bt-input': '', value: String(opt.coinNum),
          onChange: (e) => setOpt({ ...opt, coinNum: Number(e.target.value) }),
        }, h('option', { value: '1' }, '1 个'), h('option', { value: '2' }, '2 个'))),
      h(Row, null,
        h('span', { 'data-bt-note': '' }, '收藏到：'),
        h('select', {
          'data-bt-input': '', value: String(favId || 0),
          onChange: (e) => setFavId(Number(e.target.value) || 0),
        },
        h('option', { value: '0' }, favLists.length ? '（默认收藏夹）' : '（默认收藏夹 · 还没拉到列表）'),
        favLists.map((x) => h('option', { key: x.id, value: String(x.id) }, `${x.title}（${x.count}）`))),
        h('button', { 'data-bt-btn': '', onClick: () => st && st.refresh && st.refresh() }, '刷新收藏夹'),
        h('span', { 'data-bt-grow': '' }),
        h('span', { 'data-bt-note': '' }, '先演习一遍（不真发请求）：'),
        h(Switch, { on: dryRun, onChange: setDryRun })))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { 'data-bt-tabs': '', role: 'tablist' },
          [['up', '① 指定 UP 主的视频'], ['other', '② 其他视频'], ['fav', '③ 收藏夹']].map(([k, t]) =>
            h('button', {
              key: k, type: 'button', 'data-bt-tab': '', role: 'tab',
              'aria-selected': sub === k ? 'true' : 'false',
              onClick: () => setSub(k),
            }, t))),

        /* ── ① 指定 UP 主 ── */
        sub === 'up' ? h(Sec, {
          title: '先挑这个 UP 主',
          note: rules.length
            ? '已经加进「三连规则」的 UP 主：' + rules.map((r) => r.name || r.uid).join('、')
            : '填 UID（纯数字）或空间链接都行；也可以直接粘一条视频的 BV 号 / 链接',
        },
        h(Row, null,
          h('input', {
            'data-bt-input': '', placeholder: 'UID / space.bilibili.com/123 / 名字搜不了，得填 UID',
            value: uidInput, style: { flex: '1 1 220px' },
            onChange: (e) => setUidInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') loadUser(uidInput) },
          }),
          h('button', { 'data-bt-btn': '', 'data-bt-primary': '', disabled: upBusy, onClick: () => loadUser(uidInput) },
            upBusy ? '读…' : '看他的视频')),
        h(Row, null,
          h('input', {
            'data-bt-input': '', placeholder: '或者粘一条 BV / 视频链接 / av 号',
            value: uaid, style: { flex: '1 1 220px' },
            onChange: (e) => setUaid(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') byBvid() },
          }),
          h('button', { 'data-bt-btn': '', disabled: upBusy, onClick: byBvid }, '按视频找')),
        rules.length ? h(Row, null,
          h('span', { 'data-bt-note': '' }, '常看的：'),
          rules.map((r) => h('button', {
            key: r.uid, type: 'button', 'data-bt-chip': '',
            'aria-selected': String(upInfo && upInfo.uid) === String(r.uid) ? 'true' : 'false',
            onClick: () => loadUser(r.uid),
          }, r.name || r.uid))) : null,
        upInfo ? h(Row, null,
          h('div', { 'data-bt-user': '' },
            upInfo.face ? h('img', { src: upInfo.face, alt: '', referrerPolicy: 'no-referrer' }) : null,
            h('div', { 'data-bt-it': '' },
              h('div', { 'data-bt-it-t': '' }, upInfo.name || ('UID ' + upInfo.uid)),
              h('div', { 'data-bt-it-n': '' },
                [`UID ${upInfo.uid || '?'}`, upInfo.fans ? fmtNum(upInfo.fans) + ' 粉丝' : '', upTotal ? upTotal + ' 个投稿' : '']
                  .filter(Boolean).join(' · '))))) : null,
        upVideos.length ? h(Row, null,
          h('span', { 'data-bt-note': '' }, '排序：'),
          [['pubdate', '最新'], ['click', '播放'], ['stow', '收藏']].map(([k, t]) =>
            h('button', {
              key: k, type: 'button', 'data-bt-chip': '', 'aria-selected': order === k ? 'true' : 'false',
              onClick: () => { setOrder(k); loadVideos(upInfo.uid, 1) },
            }, t)),
          h('span', { 'data-bt-grow': '' }),
          h('button', { 'data-bt-btn': '', onClick: () => selectAll(upVideos) }, '这一页全勾上'),
          h('button', { 'data-bt-btn': '', onClick: () => setPicked([]) }, '清空勾选')) : null,
        upMsg ? h(Msg, null, upMsg) : null,
        upVideos.length
          ? h('div', { 'data-bt-list': '' }, upVideos.map((v) =>
            h(VideoItem, { key: v.bvid, v, checked: isPicked(v.bvid), onToggle: () => toggle(v) })))
          : h('div', { 'data-bt-empty': '' }, upBusy ? '读…' : '上面填个 UID，这里就会列出他的每一期视频'),
        upVideos.length && upTotal > 30 ? h(Row, null,
          h('button', {
            'data-bt-btn': '', disabled: upBusy || upPage <= 1,
            onClick: () => loadVideos(uidInput, upPage - 1),
          }, '上一页'),
          h('span', { 'data-bt-note': '' }, `第 ${upPage} 页 / 共 ${Math.max(1, Math.ceil(upTotal / 30))} 页（${upTotal} 条）`),
          h('button', {
            'data-bt-btn': '', disabled: upBusy || upPage * 30 >= upTotal,
            onClick: () => loadVideos(uidInput, upPage + 1),
          }, '下一页')) : null)
          : null,

        /* ── ② 其他视频 ── */
        sub === 'other' ? h(Sec, {
          title: '再挑其他视频',
          note: '关键词搜索或排行榜；已经在「三连规则」里的 UP 主的视频会自动被自动流程管，这里挑的只管这一次',
        },
        h(Row, null,
          h('button', { type: 'button', 'data-bt-chip': '', 'aria-selected': source === 'kw' ? 'true' : 'false', onClick: () => setSource('kw') }, '按关键词搜'),
          h('button', { type: 'button', 'data-bt-chip': '', 'aria-selected': source === 'rank' ? 'true' : 'false', onClick: () => setSource('rank') }, '排行榜')),
        source === 'kw' ? h(Row, null,
          h('input', {
            'data-bt-input': '', placeholder: '搜什么（比如：编程 / 原神 / 影视解说）',
            value: kw, style: { flex: '1 1 200px' },
            onChange: (e) => setKw(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') loadOther() },
          }),
          h('select', {
            'data-bt-input': '', value: kwOrder, onChange: (e) => setKwOrder(e.target.value),
          },
          h('option', { value: 'pubdate' }, '最新发布'),
          h('option', { value: 'click' }, '最多播放'),
          h('option', { value: 'totalrank' }, '综合排序'),
          h('option', { value: 'dm' }, '最多弹幕')),
          h('button', { 'data-bt-btn': '', 'data-bt-primary': '', disabled: otherBusy, onClick: loadOther }, otherBusy ? '搜…' : '搜'))
          : h(Row, null,
            h('span', { 'data-bt-note': '' }, '取前'),
            h('input', {
              'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 5, max: 100, value: rankN,
              onChange: (e) => setRankN(Math.max(5, Math.min(100, Number(e.target.value) || 30))),
            }),
            h('span', { 'data-bt-note': '' }, '条'),
            h('button', { 'data-bt-btn': '', 'data-bt-primary': '', disabled: otherBusy, onClick: loadOther }, otherBusy ? '读…' : '拉排行榜')),
        otherMsg ? h(Msg, null, otherMsg) : null,
        otherVideos.length ? h(Row, null,
          h('button', { 'data-bt-btn': '', onClick: () => selectAll(otherVideos) }, '这一批全勾上'),
          h('button', { 'data-bt-btn': '', onClick: () => setPicked([]) }, '清空勾选')) : null,
        otherVideos.length
          ? h('div', { 'data-bt-list': '' }, otherVideos.map((v) =>
            h(VideoItem, { key: v.bvid, v, checked: isPicked(v.bvid), onToggle: () => toggle(v) })))
          : h('div', { 'data-bt-empty': '' }, '搜一下，或者拉个排行榜'))
          : null,

        /* ── ③ 收藏夹 ── */
        sub === 'fav' ? h(Sec, {
          title: '从收藏夹里挑',
          note: '已经把视频收下的地方 —— 补三连（比如以前只收藏没点赞的）',
        },
        favLists.length
          ? h(Row, null, favLists.map((x) => h('button', {
            key: x.id, type: 'button', 'data-bt-chip': '',
            onClick: async () => {
              setOtherBusy(true)
              setOtherMsg('')
              try {
                const r = await jget(`/fav-content?mediaId=${x.id}&page=1`)
                setOtherVideos(r.ok ? r.videos || [] : [])
                setOtherMsg(r.ok ? `「${x.title}」前 ${(r.videos || []).length} 条` : (r.error || ''))
                setSub('fav')
              } catch (e) {
                setOtherMsg(String((e && e.message) || e))
              } finally {
                setOtherBusy(false)
              }
            },
          }, `${x.title}（${x.count}）`)))
          : h('div', { 'data-bt-empty': '' }, '还没拉到收藏夹列表 —— 先登录，或者点下面的按钮'),
        h(Row, null, h('button', { 'data-bt-btn': '', onClick: () => st && st.refresh && st.refresh() }, '刷新收藏夹列表')),
        otherMsg ? h(Msg, null, otherMsg) : null,
        otherVideos.length ? h(Row, null,
          h('button', { 'data-bt-btn': '', onClick: () => selectAll(otherVideos) }, '这一页全勾上')) : null,
        otherVideos.length
          ? h('div', { 'data-bt-list': '' }, otherVideos.map((v) =>
            h(VideoItem, { key: v.bvid, v, checked: isPicked(v.bvid), onToggle: () => toggle(v) })))
          : null)
          : null,

        tripleOpts,

        /* ── 勾选汇总 + 执行 ── */
        h(Sec, { title: `勾好了 ${pickCount} 条` },
          pickCount
            ? h('div', { 'data-bt-list': '' }, picked.map((x) =>
              h('div', { key: x.bvid, 'data-bt-item': '', 'data-picked': '' },
                h('div', { 'data-bt-it': '' },
                  h('div', { 'data-bt-it-t': '' }, x.title || x.bvid),
                  h('div', { 'data-bt-it-n': '' }, [x.bvid, x.author, x.mid ? 'UP ' + x.mid : ''].filter(Boolean).join(' · '))),
                h('button', { 'data-bt-btn': '', onClick: () => setPicked((p) => p.filter((y) => y.bvid !== x.bvid)) }, '去掉'))))
            : h('div', { 'data-bt-note': '' }, '上面勾几条，这里就可以一次性三连它们'),
          h(Row, null,
            h('button', {
              'data-bt-btn': '', 'data-bt-primary': '', disabled: !pickCount || busy === 'triple',
              onClick: () => runTriple(picked),
            }, busy === 'triple' ? '正在三连…' : `给选中的 ${pickCount} 条三连`),
            h('button', {
              'data-bt-btn': '', disabled: upVideos.length === 0,
              onClick: () => runTriple(upVideos),
            }, '这一页 UP 视频全三连'))),
        resultLog ? h(Msg, { tone: resultLog.ok ? 'good' : 'bad' },
          resultLog.ok
            ? (resultLog.results || []).map((r) => `${r.bvid} ${r.ok ? '✓' : '✗ ' + (r.error || '')}`).join('\n')
            : String(resultLog.error || '失败')) : null)
    }

    /* ── 设置：UP 三连规则 + 其他视频 ─────────────────────────────────── */

    function RuleCard({ rule, index, onChange, onRemove, onSyncNow, busy }) {
      const up = (patch) => onChange({ ...rule, ...patch })
      return h('div', { 'data-bt-rule': '' },
        h(Row, null,
          h('span', { 'data-bt-tag': '' }, `#${index + 1}`),
          h('span', { 'data-bt-title': '' }, rule.name || rule.uid || '（还没填 UID）'),
          h('span', { 'data-bt-note': '' }, rule.uid ? 'UID ' + rule.uid : ''),
          h('span', { 'data-bt-grow': '' }),
          h(Switch, { on: rule.enabled !== false, onChange: (v) => up({ enabled: v }) }),
          h('button', { 'data-bt-btn': '', 'data-bt-danger': '', onClick: onRemove }, '删掉')),
        h(Row, null,
          h('span', { 'data-bt-note': '' }, '三连哪些：'),
          h(TriBar, { value: rule, onChange: (v) => up(v) }),
          h('span', { 'data-bt-note': '' }, '投'),
          h('select', {
            'data-bt-input': '', value: String(rule.coinNum || 1),
            onChange: (e) => up({ coinNum: Number(e.target.value) }),
          }, h('option', { value: '1' }, '1 币'), h('option', { value: '2' }, '2 币')),
          h('span', { 'data-bt-note': '' }, `收藏夹 id`),
          h('input', {
            'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 0,
            value: rule.favMediaId || 0, title: '0 = 默认收藏夹',
            onChange: (e) => up({ favMediaId: Number(e.target.value) || 0 }),
          })),
        h(Row, null,
          h('span', { 'data-bt-note': '' }, '自动刷新：'),
          h(Switch, { on: rule.onlyNew !== false, onChange: (v) => up({ onlyNew: v }) }),
          h('span', { 'data-bt-note': '' }, rule.onlyNew !== false ? '只给他新发的视频三连' : '把他的每期视频都补一遍（老的也补）'),
          h('span', { 'data-bt-grow': '' }),
          h('span', { 'data-bt-note': '' }, '每轮最多'),
          h('input', {
            'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 0, max: 200,
            value: rule.dailyLimit || 0,
            onChange: (e) => up({ dailyLimit: Number(e.target.value) || 0 }),
          }),
          h('span', { 'data-bt-note': '' }, '条'),
          h('button', { 'data-bt-btn': '', disabled: busy, onClick: onSyncNow }, '现在就补一遍')),
        rule.lastSyncAt ? h('div', { 'data-bt-note': '' },
          `上次同步：${new Date(rule.lastSyncAt).toLocaleString()} · 已经三连过 ${(rule.syncedBvids || []).length} 条`) : null,
      )
    }

    function SettingsTab({ cfg, patchCfg, busy, setBusy, st }) {
      const rules = (cfg && cfg.upRules) || []
      const [newUid, setNewUid] = useState('')
      const [newMsg, setNewMsg] = useState('')
      const [kwInput, setKwInput] = useState('')
      const [runLog, setRunLog] = useState(null)

      const setCfg = (patch) => patchCfg(patch)
      const setRules = (next) => setCfg({ upRules: next })

      const addRule = async () => {
        const raw = newUid.trim()
        if (!raw) return
        setNewMsg('')
        try {
          const r = await jget('/convert-uid?q=' + encodeURIComponent(raw))
          if (!r.ok || !r.uid) { setNewMsg('认不出这个 UID：' + (r.error || '')); return }
          if (rules.some((x) => String(x.uid) === String(r.uid))) { setNewMsg('这个 UP 主已经在列表里了'); return }
          const info = await jget('/user-info?uid=' + encodeURIComponent(r.uid))
          const rule = {
            uid: String(r.uid),
            name: (info.ok && info.name) || '',
            face: (info.ok && info.face) || '',
            enabled: true, doLike: true, doCoin: true, coinNum: 1, doFav: true,
            favMediaId: 0, onlyNew: true, skipDone: true, dailyLimit: 20,
            lastSyncAt: 0, syncedBvids: [],
          }
          setRules([...rules, rule])
          setNewUid('')
          setNewMsg(`已添加：${rule.name || rule.uid} —— 记得点下面的「保存」`)
        } catch (e) {
          setNewMsg(String((e && e.message) || e))
        }
      }

      const runNow = async () => {
        setBusy && setBusy('run')
        setRunLog(null)
        try {
          const r = await jpost('/run', {})
          setRunLog(r)
          st && st.refresh && st.refresh()
        } catch (e) {
          setRunLog({ ok: false, error: String((e && e.message) || e) })
        } finally {
          setBusy && setBusy(null)
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Sec, {
          title: '给这些 UP 主的每一期视频三连',
          note: '规则按顺序执行：先 UP 主，再「其他视频」。同一轮里，UP 主自己的视频不会被「其他视频」重复处理',
        },
        h(Row, null,
          h('input', {
            'data-bt-input': '', placeholder: 'UP 主 UID / space.bilibili.com/123',
            value: newUid, style: { flex: '1 1 200px' },
            onChange: (e) => setNewUid(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') addRule() },
          }),
          h('button', { 'data-bt-btn': '', 'data-bt-primary': '', onClick: addRule }, '加进来')),
        newMsg ? h(Msg, null, newMsg) : null,
        rules.length
          ? rules.map((r, i) => h(RuleCard, {
            key: r.uid || ('new' + i),
            rule: r, index: i,
            busy: busy === 'run',
            onChange: (next) => setRules(rules.map((x, j) => (j === i ? next : x))),
            onRemove: () => setRules(rules.filter((x, j) => j !== i)),
            onSyncNow: async () => {
              await patchCfg({ upRules: rules.map((x, j) => (j === i ? { ...x, lastSyncAt: 0 } : x)) })
              await runNow()
            },
          }))
          : h('div', { 'data-bt-empty': '' }, '还没有 UP 主。上面填一个 UID 加进来，他以后每一期视频都会自动三连。')),

        h(Sec, {
          title: '其他视频',
          note: 'UP 主都处理完之后，再按订阅关键词搜到的、或者排行榜上的视频三连（★ 和「刷B站」一样：先 UP 主，再其他）',
        },
        h(Row, null,
          h('span', { 'data-bt-note': '' }, '也自动三连「其他视频」：'),
          h(Switch, { on: Boolean(cfg.otherEnabled), onChange: (v) => setCfg({ otherEnabled: v }) })),
        h(Row, null,
          h('span', { 'data-bt-note': '' }, '每轮最多'),
          h('input', {
            'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 0, max: 30,
            value: cfg.otherPerRun || 0, onChange: (e) => setCfg({ otherPerRun: Number(e.target.value) || 0 }),
          }),
          h('span', { 'data-bt-note': '' }, '条 · 最少播放'),
          h('input', {
            'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 0,
            value: cfg.otherSkipMinPlay || 0, onChange: (e) => setCfg({ otherSkipMinPlay: Number(e.target.value) || 0 }),
          }),
          h('span', { 'data-bt-note': '' }, '· 排行榜前'),
          h('input', {
            'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 0, max: 100,
            value: cfg.otherRankTop || 0, onChange: (e) => setCfg({ otherRankTop: Number(e.target.value) || 0 }),
          }),
          h('span', { 'data-bt-note': '' }, '条也算进来')),
        h(Row, null,
          h('input', {
            'data-bt-input': '', placeholder: '订阅一个搜索关键词，回车加进来',
            value: kwInput, style: { flex: '1 1 200px' },
            onChange: (e) => setKwInput(e.target.value),
            onKeyDown: (e) => {
              if (e.key !== 'Enter') return
              const k = kwInput.trim()
              if (!k) return
              if ((cfg.otherKeywords || []).includes(k)) { setKwInput(''); return }
              setCfg({ otherKeywords: [...(cfg.otherKeywords || []), k] })
              setKwInput('')
            },
          })),
        (cfg.otherKeywords || []).length
          ? h(Row, null, cfg.otherKeywords.map((k) => h('button', {
            key: k, type: 'button', 'data-bt-chip': '', 'aria-selected': 'true', title: '点一下删掉',
            onClick: () => setCfg({ otherKeywords: cfg.otherKeywords.filter((x) => x !== k) }),
          }, k + ' ×')))
          : h('div', { 'data-bt-note': '' }, '没加关键词的话，「其他视频」只会从排行榜里挑')),

        h(Sec, { title: '节奏与额度' },
          h(Row, null,
            h('span', { 'data-bt-note': '' }, '总开关：'),
            h(Switch, { on: cfg.enabled !== false, onChange: (v) => setCfg({ enabled: v }) }),
            h('span', { 'data-bt-note': '' }, '巡查间隔'),
            h('input', {
              'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 0, max: 1440,
              value: cfg.intervalMinutes || 0, onChange: (e) => setCfg({ intervalMinutes: Number(e.target.value) || 0 }),
            }),
            h('span', { 'data-bt-note': '' }, '分钟（0 = 只手动）')),
          h(Row, null,
            h('span', { 'data-bt-note': '' }, '每天最多三连'),
            h('input', {
              'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 1, max: 500,
              value: cfg.dailyLimit || 40, onChange: (e) => setCfg({ dailyLimit: Number(e.target.value) || 40 }),
            }),
            h('span', { 'data-bt-note': '' }, '条 · 每两条之间歇'),
            h('input', {
              'data-bt-input': '', 'data-bt-num': '', type: 'number', min: 300, step: 100,
              value: cfg.pauseMinMs || 1200, onChange: (e) => setCfg({ pauseMinMs: Number(e.target.value) || 1200 }),
            }),
            h('span', { 'data-bt-note': '' }, '毫秒（别太快，容易被风控）')),
          h(Row, null,
            h('button', { 'data-bt-btn': '', 'data-bt-primary': '', disabled: busy === 'run', onClick: runNow },
              busy === 'run' ? '跑一轮中…' : '现在就巡查一轮（先 UP 主，再其他）')),
          runLog ? h('pre', { 'data-bt-pre': '' },
            runLog.ok
              ? [runLog.summary || '', ...((runLog.log || []).map((x) => (typeof x === 'string' ? x : x.msg || '')))]
                .filter(Boolean).join('\n')
              : '失败：' + (runLog.error || '') + '\n' + ((runLog.log || []).map((x) => x.msg || '').join('\n'))) : null),

        h(Sec, {
          title: '本地环境',
          note: '所有 B 站请求都由本机 python 发（用的是「刷B站」装好的那个运行环境）',
        },
        h('div', { 'data-bt-note': '' }, `python：${(st && st.python) || '？'}${st && st.pythonNote ? '（' + st.pythonNote + '）' : ''}`),
        h('div', { 'data-bt-note': '' }, `家目录：${(st && st.home) || '？'}`),
        h('div', { 'data-bt-note': '' }, `今天已经三连：${(st && st.todayCount) || 0} / ${cfg.dailyLimit || 40} 条`),
        h(Row, null,
          h('input', {
            'data-bt-input': '', placeholder: 'python.exe 的完整路径（留空 = 自动找）',
            value: cfg.pythonPath || '', style: { flex: '1 1 240px' },
            onChange: (e) => setCfg({ pythonPath: e.target.value }),
          }))),

        h(Sec, { title: '最近的记录' },
          h('div', { 'data-bt-note': '' },
            st && st.lastRun && st.lastRun.at
              ? `上次巡查：${new Date(st.lastRun.at).toLocaleString()} · ${st.lastRun.summary || ''}`
              : '还没跑过'),
          st && st.lastRun && (st.lastRun.results || []).length
            ? h('pre', { 'data-bt-pre': '' }, (st.lastRun.results || []).slice(-40).map((x) => x.msg || '').join('\n'))
            : null),
      )
    }

    /* ── 主面板 ────────────────────────────────────────────────────────── */

    function Panel(props) {
      const wide = props && props.wide
      const [tab, setTab] = useState('pick')
      const [st, setSt] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [busy, setBusy] = useState(null)
      const [err, setErr] = useState('')
      const [saved, setSaved] = useState('')
      const [picked, setPicked] = useState([])
      const aliveRef = useRef(true)

      const loadStatus = useCallback(async () => {
        try {
          const r = await jget('/status')
          if (!aliveRef.current) return
          if (r.ok) { setSt(r); if (!cfg) setCfg(r.config) ; setErr('') }
          else setErr(r.error || '读不到状态')
        } catch (e) {
          if (aliveRef.current) setErr('读不到状态：' + String((e && e.message) || e))
        }
      }, [cfg])

      useEffect(() => {
        aliveRef.current = true
        loadStatus()
        const t = setInterval(() => loadStatus(), 20_000)
        return () => { aliveRef.current = false; clearInterval(t) }
      }, [])

      // 配置：先按服务器那份显示（第一次读到就填进来），之后每次保存整份 POST
      useEffect(() => {
        if (st && st.config && !cfg) setCfg(st.config)
      }, [st])

      const patchCfg = useCallback(async (patch) => {
        const next = { ...(cfg || {}), ...patch }
        setCfg(next)
        try {
          const r = await jpost('/config', patch)
          if (r.ok) {
            setCfg(r.config)
            setSaved('已保存 ' + new Date().toLocaleTimeString())
            setTimeout(() => setSaved(''), 2500)
          } else setErr(r.error || '保存失败')
        } catch (e) {
          setErr('保存失败：' + String((e && e.message) || e))
        }
      }, [cfg])

      // 每隔 20 秒重新读配置（别把用户正在编辑的草稿盖掉 —— 只在没在编辑时合）
      const firstCfgLoaded = useRef(false)
      useEffect(() => {
        if (!cfg) return
        const mergeRemote = async () => {
          if (!firstCfgLoaded.current && st && st.config) { firstCfgLoaded.current = true; return }
          try {
            const r = await jget('/config')
            if (!r.ok) return
            // 规则数量变化（别处改过）才覆盖，否则保留本地草稿
            const remote = r.config || {}
            setCfg((cur) => {
              if (!cur) return remote
              const remoteN = (remote.upRules || []).length
              const curN = (cur.upRules || []).length
              if (remoteN !== curN) return { ...cur, upRules: remote.upRules, otherKeywords: remote.otherKeywords, otherEnabled: remote.otherEnabled, otherPerRun: remote.otherPerRun, otherRankTop: remote.otherRankTop, otherSkipMinPlay: remote.otherSkipMinPlay, dailyLimit: remote.dailyLimit, intervalMinutes: remote.intervalMinutes, pauseMinMs: remote.pauseMinMs, enabled: remote.enabled }
              return cur
            })
          } catch { /* 忽略 */ }
        }
        const t = setInterval(mergeRemote, 30_000)
        return () => clearInterval(t)
      }, [st])

      const lastRun = st && st.lastRun
      const nextRunText = (() => {
        if (!cfg || cfg.enabled === false || !Number(cfg.intervalMinutes)) return '只手动'
        const base = (lastRun && lastRun.at) || (st && st.now) || Date.now()
        const due = base + Number(cfg.intervalMinutes) * 60000
        return fmtCountdown(due - Date.now())
      })()

      return h('div', { 'data-bt-page': '', 'data-bt-wide': wide ? '' : undefined },
        h('div', { 'data-bt-head': '' },
          h('span', { 'data-bt-title': '' }, 'B站三连'),
          st && st.login && st.login.loggedIn
            ? h('span', { 'data-bt-badge': '', 'data-on': '' }, '已登录 · ' + (st.login.name || st.login.uid))
            : h('span', { 'data-bt-badge': '', 'data-off': '' }, '未登录'),
          h('span', { 'data-bt-note': '' }, `今天 ${(st && st.todayCount) || 0}/${(cfg && cfg.dailyLimit) || 40}`),
          h('span', { 'data-bt-note': '' }, `下次：${nextRunText}`),
          h('span', { 'data-bt-grow': '' }),
          saved ? h('span', { 'data-bt-note': '', style: { color: 'var(--dsw-alias-state-success-primary,#22c55e)' } }, saved) : null,
          h('button', { 'data-bt-btn': '', disabled: Boolean(busy), onClick: () => loadStatus() }, '刷新')),

        err ? h(Msg, { tone: 'bad' }, err) : null,

        h(LoginBox, { st, busy, setBusy, onRefresh: loadStatus }),

        h('div', { 'data-bt-tabs': '', role: 'tablist' },
          [['pick', '挑视频'], ['settings', '设置']].map(([k, t]) =>
            h('button', {
              key: k, type: 'button', 'data-bt-tab': '', role: 'tab',
              'aria-selected': tab === k ? 'true' : 'false',
              onClick: () => setTab(k),
            }, t))),

        tab === 'pick'
          ? h(PickTab, { st: { ...(st || {}), refresh: loadStatus }, cfg, patchCfg, busy, setBusy, picked, setPicked })
          : h(SettingsTab, { cfg, patchCfg, busy, setBusy, st: { ...(st || {}), refresh: loadStatus } }),
      )
    }

    /* ── 左侧栏图标 ───────────────────────────────────────────────────── */

    function Icon(props) {
      const size = (props && props.size) || 18
      const active = Boolean(props && props.active)
      // 赞（拇指）+ 币（圆）+ 收藏（星），一眼看出这是「三连」
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block' }, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        opacity: active ? 1 : 0.78,
      },
      h('path', { d: 'M3.2 11.2h2.6v8.1H3.2z', fill: 'currentColor', fillOpacity: active ? 0.9 : 0.6, stroke: 'none' }),
      h('path', { d: 'M7.1 11.2l3-5.4c.5-.9 1.9-.6 2 .4l.2 2.6h4.2c1.2 0 2.1 1.1 1.9 2.3l-1 5.1c-.2 1-1 1.7-2 1.7H7.1z' }),
      h('circle', { cx: 18.6, cy: 6.4, r: 2.5 }),
      h('path', { d: 'M18.6 4.9v3M17.1 6.4h3', strokeWidth: 1.2 }))
    }

    /* ── 注册 ──────────────────────────────────────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-triple')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-triple: 样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // ① 左侧栏图标（点它 → 主区切到 key `bili-triple`）
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: 'bili-triple', order: 40, label: () => 'B站三连' },
          (props) => h(Icon, props || {}),
        ))

        // ② 主面板：侧栏 id 就是这里的 key
        slots.inject('main', () => slots.register(
          { name: 'main', key: 'bili-triple' },
          (props) => h(Panel, { ...(props || {}), wide: true }),
        ))

        // ③ 设置里一页
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-triple', order: 35, label: () => 'B站三连' },
          () => h(Panel, {}),
        ))
      },
    }
  },
})
