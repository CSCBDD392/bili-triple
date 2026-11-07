/**
 * dsh-bili-triple — 宿主半端
 *
 * 这个插件干三件事：
 *   1. 扫码登录 B 站（二维码在插件自己那一页里出，宿主只管路由代理到 Python 半端）；
 *   2. 用本机环境：所有 B 站请求都交给本机 python（bilibili-api-python）跑，不走浏览器；
 *   3. 三连：设置里给某个 UP 主的每一期视频点赞 + 投币 + 收藏，外加一份自动巡查。
 * 另有一整套「自己挑视频」的能力（和刷B站那个插件一样）：
 *   - 先看指定 UP 主的视频（挑着三连 / 一键全三连）；
 *   - 再看其他视频（按 UP 主 / 关键词 / 排行榜 / 收藏夹找）。
 *
 * 前端在 client.js（左侧栏一个图标 + 设置里一页），两边靠 /api/bili-triple/* 说话。
 * ================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_PREFIX = '/api/bili-triple'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'bili-triple')
const CONFIG_FILE = join(STATE_DIR, 'config.json')
const HISTORY_FILE = join(STATE_DIR, 'history.jsonl')
const FAV_IDS_FILE = join(STATE_DIR, 'fav-ids.json')
const PY_SCRIPT = join(HERE, 'py_ops.py')

export const name = 'bili-triple'

/* ── 配置 ───────────────────────────────────────────────────────────────── */

const DEFAULT_CONFIG = {
  enabled: true,                     // 定时巡查总开关
  pythonPath: '',                    // 空 = 自动找（先看刷B站的 venv，再试 py / python）
  credentialFile: '',                // 空 = 先用自己的家目录，没有就用刷B站那份
  // 指定 UP 主的三连规则
  // [{ uid, name, face, enabled, doLike, doCoin, coinNum, doFav, favMediaId, onlyNew, skipDone, dailyLimit, lastSyncAt, syncedBvids }]
  upRules: [],
  // 「其他视频」：先挑这些 UP 主的投稿，再（没点名时）用关键词 / 排行榜兜底
  otherEnabled: false,
  otherUids: [],
  otherKeywords: [],
  otherOrder: 'pubdate',
  otherRankTop: 0,
  otherPerRun: 5,
  otherDoneBvids: [],
  otherSkipMinPlay: 0,
  intervalMinutes: 60,               // 巡查间隔（0 = 只手动）
  dailyLimit: 40,                    // 全插件每天最多三连多少条
  pauseMinMs: 1200,                  // 每条之间歇多久（毫秒，防触发风控）
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

function loadConfig() {
  const raw = readJson(CONFIG_FILE, {}) || {}
  const cfg = { ...DEFAULT_CONFIG, ...raw }
  if (!Array.isArray(cfg.upRules)) cfg.upRules = []
  if (!Array.isArray(cfg.otherUids)) cfg.otherUids = []
  if (!Array.isArray(cfg.otherKeywords)) cfg.otherKeywords = []
  if (!Array.isArray(cfg.otherDoneBvids)) cfg.otherDoneBvids = []
  cfg.otherUids = cfg.otherUids.map((x) => String(x ?? '').trim()).filter((x) => /^\d{1,12}$/.test(x))
  cfg.upRules = cfg.upRules
    .map((r) => ({
      uid: String(r?.uid ?? '').trim(),
      name: String(r?.name ?? ''),
      face: String(r?.face ?? ''),
      enabled: r?.enabled !== false,
      doLike: r?.doLike !== false,
      doCoin: r?.doCoin !== false,
      coinNum: Number(r?.coinNum) >= 2 ? 2 : 1,
      doFav: r?.doFav !== false,
      favMediaId: Number(r?.favMediaId) || 0,
      onlyNew: r?.onlyNew !== false,
      skipDone: r?.skipDone !== false,
      dailyLimit: Math.max(0, Number(r?.dailyLimit) || 0),
      lastSyncAt: Number(r?.lastSyncAt) || 0,
      syncedBvids: Array.isArray(r?.syncedBvids) ? r.syncedBvids.slice(-5000) : [],
    }))
    .filter((r) => /^\d{1,12}$/.test(r.uid))
  return cfg
}

function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg)
  return cfg
}

/* ── 本机 python：找解释器 + 起一个子进程跑 py_ops.py ─────────────────────── */

const PY_CANDIDATES = [
  join(DSH_HOME, 'bili-duty', '.venv', 'Scripts', 'python.exe'),     // 刷B站的 venv（首选）
  join(DSH_HOME, 'bili-duty', '.venv', 'bin', 'python'),             // 非 Windows
]

function resolvePython(configured) {
  if (configured && existsSync(configured)) return { path: configured, note: '设置里填的' }
  for (const c of PY_CANDIDATES) {
    if (existsSync(c)) return { path: c, note: c.includes('bili-duty') ? '刷B站装的运行环境' : '' }
  }
  // 宿主进程不一定带用户的 PATH（Windows 版是 Electron），所以常见的装法自己找一遍
  const exe = process.platform === 'win32' ? 'python.exe' : join('bin', 'python3')
  const roots = []
  if (process.env.LOCALAPPDATA) {
    roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'Python'))
    roots.push(join(process.env.LOCALAPPDATA, 'uv', 'python'))
  }
  if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'Python'))
  if (process.platform !== 'win32') {
    roots.push('/usr/local/bin', '/usr/bin', join(homedir(), '.local', 'bin'))
  }
  const found = []
  for (const root of roots) {
    if (!root) continue
    try {
      for (const nm of readdirSync(root)) found.push(join(root, nm, exe))
    } catch { /* 目录不在就算了 */ }
    found.push(join(root, exe)) // ProgramFiles/Python/python.exe 这种
  }
  found.sort((a, b) => String(b).localeCompare(String(a), 'en', { numeric: true })) // 版本号大的排前面
  for (const c of found) if (existsSync(c)) return { path: c, note: '从本地 Python 安装目录里找到的（请确认装了 bilibili-api-python）' }
  return { path: process.platform === 'win32' ? 'py' : 'python', note: '系统 PATH 里的 python（不一定装了 bilibili-api）' }
}

function runPy(python, args, { timeoutMs = 200_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const full = []
    if (process.platform === 'win32' && (python === 'py' || python.endsWith('py.exe'))) full.push('-3')
    full.push(PY_SCRIPT, ...args)
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(python, full, {
        cwd: HERE,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', BILI_TRIPLE_HOME: STATE_DIR, ...env },
      })
    } catch (e) {
      resolve({ ok: false, error: `起不来 python（${python}）：${e?.message ?? e}` })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退了 */ }
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `起不来 python（${python}）：${e?.message ?? e}` })
    })
    child.on('close', () => {
      clearTimeout(timer)
      // 只认最后一行能解析的 JSON（bilibili_api 偶尔往 stdout 漏东西）
      const lines = out.split(/\r?\n/).filter((l) => l.trim())
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i].replace(/^\uFEFF/, ''))
          if (j && typeof j === 'object' && 'ok' in j) { resolve(j); return }
        } catch { /* 不是 JSON，接着往前找 */ }
      }
      resolve({ ok: false, error: err.trim().slice(-800) || 'python 没给出结果', raw: out.slice(-800) })
    })
  })
}

/* ── 历史记录 / 今日额度 ────────────────────────────────────────────────── */

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function nowIso() {
  return new Date().toISOString()
}

function appendHistory(rec) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(HISTORY_FILE, JSON.stringify(rec) + '\n', { encoding: 'utf8', flag: 'a' })
  } catch { /* 记不住就算了 */ }
}

function readHistory(limit = 200) {
  const raw = (() => { try { return readFileSync(HISTORY_FILE, 'utf8') } catch { return '' } })()
  const rows = raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  return { rows, tail: rows.slice(-limit).reverse() }
}

function todayCount() {
  const day = today()
  return readHistory(10_000).rows.filter((r) => r && r.day === day && r.ok).length
}

/* ── 三连：一条视频 ─────────────────────────────────────────────────────── */

async function tripleOne(python, bvid, rule, cfg, defaultFavId) {
  const opt = {
    doLike: rule.doLike !== false,
    doCoin: rule.doCoin !== false,
    coin: Number(rule.coinNum) >= 2 ? 2 : 1,
    doFav: rule.doFav !== false,
    favMediaId: Number(rule.favMediaId) || Number(defaultFavId) || 0,
    allowCoinWhenLiked: true,
  }
  return runPy(python, ['triple', String(bvid), '--json', JSON.stringify(opt)])
}

async function fetchDefaultFavId(python) {
  const cached = readJson(FAV_IDS_FILE, null)
  if (cached && Array.isArray(cached.lists) && cached.lists.length && Date.now() - (cached.at || 0) < 6 * 3600e3) {
    return cached.lists[0].id
  }
  const r = await runPy(python, ['fav-lists'])
  if (r.ok && r.data && Array.isArray(r.data.lists)) {
    writeJson(FAV_IDS_FILE, { at: Date.now(), lists: r.data.lists })
    return r.data.lists[0]?.id || 0
  }
  return 0
}

/* ── 一轮巡查：先 UP 主，再「其他视频」 ─────────────────────────────────── */

let running = null
let lastRun = { at: 0, kind: 'idle', summary: '', results: [] }

async function runOnce(kind = 'manual', opts = {}) {
  if (running) return { ok: false, error: '上一轮还在跑', busy: true }
  const cfg = loadConfig()
  const { path: python, note } = resolvePython(cfg.pythonPath)
  running = { at: Date.now(), kind }
  const startedAt = Date.now()
  const results = []
  const log = (m) => { results.push({ t: Date.now(), msg: m }) }
  try {
    const who = await runPy(python, ['whoami'])
    if (!who.ok || !who.data || !who.data.loggedIn) {
      return { ok: false, error: (who.data && who.data.error) || who.error || '还没登录', needLogin: true }
    }
    let defaults = 0
    const needFav = cfg.upRules.some((r) => r.doFav && !r.favMediaId) || (cfg.otherEnabled && cfg.otherPerRun > 0)
    if (needFav) defaults = await fetchDefaultFavId(python)

    let used = todayCount()
    const budget = () => Math.max(0, Number(cfg.dailyLimit || 0) - used)
    const pause = () => new Promise((r) => setTimeout(r, Math.max(300, Number(cfg.pauseMinMs) || 1200)))

    const doTriple = async (bvid, rule, tag) => {
      if (budget() <= 0) {
        log(`今天的额度（${cfg.dailyLimit} 条）用完了，剩下的明天再说`)
        return { bvid, ok: false, skipped: 'quota' }
      }
      if (opts.dryRun) {
        log(`（演习）${tag} 会三连 ${bvid}`)
        return { bvid, ok: true, dryRun: true }
      }
      const r = await tripleOne(python, bvid, rule, cfg, defaults)
      const ok = Boolean(r.ok && r.data && r.data.ok)
      used += ok ? 1 : 0
      const rec = {
        day: today(), at: nowIso(), bvid, tag, ok,
        title: (r.data && r.data.title) || '',
        steps: (r.data && r.data.steps) || [],
        error: r.ok ? '' : String(r.error || ''),
      }
      appendHistory(rec)
      const how = ok ? 'ok' : 'fail: ' + (rec.error || (rec.steps.find((s) => s && s.ok === false)?.message ?? '?'))
      log(`${tag} ${bvid} ${rec.title ? '『' + rec.title + '』' : ''} ${how}`)
      await pause()
      return { bvid, ok, title: rec.title, steps: rec.steps, error: rec.error }
    }

    /* ① 先按 UP 主 */
    const upResults = []
    for (const rule of cfg.upRules) {
      if (!rule.enabled) continue
      const mine = []
      if (rule.onlyNew && !opts.forceUp) {
        // 「只认新视频」：只看上次巡查之后发的（第一次巡查先把现有视频记成已看过）
        const first = await runPy(python, ['up-videos', rule.uid, '--json', JSON.stringify({ page: 1, ps: 30 })])
        if (!first.ok) { log(`拿不到 UP ${rule.uid} 的投稿：${first.error}`); continue }
        if (!rule.lastSyncAt) {
          rule.lastSyncAt = Math.floor(Date.now() / 1000)
          saveConfig(cfg)
          log(`UP ${rule.name || rule.uid}：第一次巡查，先记下现有的 ${first.data.total ?? (first.data.videos || []).length} 条，从现在起只给新的三连`)
        } else {
          // 上次到现在可能发了好几条，往下翻到「上一轮那会儿」为止
          const cut = Number(rule.lastSyncAt) / 1000
          const vids = []
          let page = 1
          let batch = first.data.videos || []
          while (page <= 5 && batch.length && vids.length < 200) {
            for (const v of batch) if (Number(v.pubdate) > cut) vids.push(v)
            const lastPub = Number(batch[batch.length - 1]?.pubdate || 0)
            if (lastPub <= cut || batch.length < 30) break
            page++
            const nxt = await runPy(python, ['up-videos', rule.uid, '--json', JSON.stringify({ page, ps: 30 })])
            if (!nxt.ok) break
            batch = nxt.data.videos || []
          }
          vids.sort((a, b) => Number(b.pubdate) - Number(a.pubdate))
          for (const v of vids.slice(0, rule.dailyLimit || 10)) {
            mine.push(await doTriple(v.bvid, rule, `[UP ${rule.name || rule.uid}]`))
          }
        }
      } else {
        // 「全都要」模式：把这个 UP 主的投稿翻一遍，没三连过的都补上
        const maxN = rule.dailyLimit || 20
        let page = 1
        let count = 0
        let stop = false
        while (page <= 10 && !stop) {
          const r = await runPy(python, ['up-videos', rule.uid, '--json', JSON.stringify({ page, ps: 30, order: 'pubdate' })])
          if (!r.ok) { log(`拿不到 UP ${rule.uid} 的投稿：${r.error}`); break }
          const vids = r.data.videos || []
          const total = r.data.total || vids.length
          for (const v of vids) {
            if (count >= maxN) { stop = true; break }
            if (rule.syncedBvids.includes(v.bvid)) continue
            const res = await doTriple(v.bvid, rule, `[UP ${rule.name || rule.uid}]`)
            if (res.skipped === 'quota') { stop = true; break }
            if (!res.skipped || res.dryRun) {
              rule.syncedBvids.push(v.bvid)
              if (rule.syncedBvids.length > 5000) rule.syncedBvids = rule.syncedBvids.slice(-5000)
            }
            count++
            mine.push(res)
          }
          if (page * 30 >= total) break
          page++
        }
        rule.lastSyncAt = Math.floor(Date.now() / 1000)
        saveConfig(cfg)
      }
      upResults.push(...mine)
    }

    /* ② 再「其他视频」：先挑你点名的那几个 UP 主的投稿，再（补充）关键词 / 排行榜 */
    const otherResults = []
    if (cfg.otherEnabled && Number(cfg.otherPerRun) > 0) {
      const upUids = new Set(cfg.upRules.map((r) => r.uid))
      const done = new Set(cfg.otherDoneBvids)
      const pool = []
      const wantN = Math.max(Number(cfg.otherPerRun) * 4, 20)
      const otherUids = cfg.otherUids.filter((u) => !upUids.has(u))
      for (const uid of otherUids) {
        const r = await runPy(python, ['up-videos', uid, '--json', JSON.stringify({ page: 1, ps: 30, order: cfg.otherOrder || 'pubdate' })])
        if (!r.ok) { log(`拿不到「其他」UP ${uid} 的投稿：${r.error}`); continue }
        for (const v of (r.data.videos || []).slice(0, wantN)) pool.push({ ...v, why: `UP ${v.author || uid}` })
      }
      // 没点名 UP 主时才用关键词 / 排行榜兜底，否则会变成「搜到谁都三连」
      if (!otherUids.length) {
        for (const kw of cfg.otherKeywords.slice(0, 10)) {
          const r = await runPy(python, ['search', kw, '--json', JSON.stringify({ num: 20, order: cfg.otherOrder || 'pubdate' })])
          if (!r.ok) { log(`搜索「${kw}」失败：${r.error}`); continue }
          for (const v of r.data.videos || []) pool.push({ ...v, why: `关键词「${kw}」` })
        }
        if (Number(cfg.otherRankTop) > 0) {
          const r = await runPy(python, ['rank', '--json', JSON.stringify({ num: Math.min(100, Number(cfg.otherRankTop)) })])
          if (r.ok) for (const v of r.data.videos || []) pool.push({ ...v, why: '排行榜' })
        }
        if (!pool.length) {
          const r = await runPy(python, ['hot', '--json', JSON.stringify({ num: 20 })])
          if (r.ok) for (const v of r.data.videos || []) pool.push({ ...v, why: '热门' })
          else log(`拿不到热门视频：${r.error}`)
        }
      }
      const seen = new Set()
      const picked = []
      for (const v of pool) {
        if (!v.bvid || seen.has(v.bvid)) continue
        seen.add(v.bvid)
        if (done.has(v.bvid)) continue
        if (upUids.has(String(v.mid))) continue            // UP 主规则自己管
        if (Number(v.play) < Number(cfg.otherSkipMinPlay || 0)) continue
        picked.push(v)
      }
      for (const v of picked.slice(0, Number(cfg.otherPerRun))) {
        const rule = { coinNum: 1, doLike: true, doCoin: true, doFav: true, favMediaId: 0 }
        const res = await doTriple(v.bvid, rule, `[其他·${v.why}]`)
        if (res.skipped === 'quota') break
        if (res.ok || res.dryRun) cfg.otherDoneBvids.push(v.bvid)
        otherResults.push(res)
      }
      cfg.otherDoneBvids = cfg.otherDoneBvids.slice(-3000)
      saveConfig(cfg)
    }

    const all = [...upResults, ...otherResults]
    const okN = all.filter((x) => x && x.ok).length
    const summary = all.length
      ? `这一轮三连 ${okN}/${all.length} 条（UP 主 ${upResults.filter((x) => x && x.ok).length}/${upResults.length}，其他 ${otherResults.filter((x) => x && x.ok).length}/${otherResults.length}）`
      : '这一轮没有要三连的新视频'
    lastRun = { at: Date.now(), kind, summary, results: results.slice(-200), python, pythonNote: note, ms: Date.now() - startedAt }
    return { ok: true, summary, up: upResults, other: otherResults, log: results, ms: Date.now() - startedAt, dryRun: Boolean(opts.dryRun) }
  } catch (e) {
    lastRun = { at: Date.now(), kind, summary: '出错了：' + (e?.message ?? String(e)), results: results.slice(-200) }
    return { ok: false, error: e?.message ?? String(e), log: results }
  } finally {
    running = null
  }
}

/* ── HTTP 路由 ──────────────────────────────────────────────────────────── */

function sendJson(res, status, body) {
  try {
    const txt = JSON.stringify(body)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(txt)
  } catch {
    try { res.end() } catch { /* 已经断了 */ }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > 2_000_000) { try { req.destroy() } catch { /* 已断 */ } resolve({}); return }
      buf += c.toString('utf8')
    })
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 第一道闸：宿主连接层的拒绝（和刷B站插件用的是同一套） */
function getConnection(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const c = ctx.get('connection')
      if (c) return c
    }
  } catch { /* 没有就算了 */ }
  const a = Reflect.get(ctx, 'connection')
  if (a) return a
  const root = Reflect.get(ctx, 'root')
  return root ? Reflect.get(root, 'connection') : undefined
}

function fenceReject(ctx, req, res) {
  const conn = getConnection(ctx)
  if (!conn || typeof conn.requestRejection !== 'function') return false
  let verdict
  try {
    verdict = conn.requestRejection({ headers: req.headers })
  } catch {
    verdict = 403
  }
  if (verdict === undefined || verdict === null || verdict === false) return false
  sendJson(res, typeof verdict === 'number' ? verdict : 403, { ok: false, error: '宿主连接层拒绝了这次请求' })
  return true
}

/** 第二道闸：只认本机 + 同源（防别的网页顺走登录态） */
function sameOriginOk(req) {
  const host = String(req.headers.host || '')
  const m = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.exec(host)
  if (!m) return false
  const ref = String(req.headers.origin || req.headers.referer || '')
  if (!ref) return true
  let u
  try { u = new URL(ref) } catch { return false }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  const hostPort = m[2] ? m[2].slice(1) : (u.protocol === 'https:' ? '443' : '80')
  return u.hostname === m[1].replace(/^\[|\]$/g, '') && port === hostPort
}

export const inject = ['webServer']

export function apply(ctx, _config) {
  const log = (m) => {
    try {
      if (ctx.logger?.info) ctx.logger.info(`[bili-triple] ${m}`)
      else console.log(`[bili-triple] ${m}`)
    } catch { /* 日志挂了不影响功能 */ }
  }
  mkdirSync(STATE_DIR, { recursive: true })

  const status = async () => {
    const cfg = loadConfig()
    const { path: python, note } = resolvePython(cfg.pythonPath)
    const who = await runPy(python, ['whoami'], { timeoutMs: 60_000 })
    const d = who.ok ? who.data : null
    const favCache = readJson(FAV_IDS_FILE, null)
    return {
      ok: true,
      home: STATE_DIR,
      python,
      pythonNote: note,
      pythonExists: /\.exe$|python3?$/.test(python) ? existsSync(python) : null,
      scriptExists: existsSync(PY_SCRIPT),
      login: d
        ? { loggedIn: Boolean(d.loggedIn), uid: d.uid || 0, name: d.name || '', face: d.face || '', level: d.level || 0, vip: d.vip || '', source: d.source || '', error: d.error || '' }
        : { loggedIn: false, error: who.error || 'python 跑不起来' },
      favLists: favCache && Array.isArray(favCache.lists) ? favCache.lists : [],
      todayCount: todayCount(),
      running: Boolean(running),
      lastRun,
      config: cfg,
      now: Date.now(),
    }
  }

  const handle = async (req, res, url) => {
    const path = url.pathname
    const cfg = loadConfig()
    const { path: python } = resolvePython(cfg.pythonPath)
    const browse = (cmd, args, opt) => runPy(python, [cmd, ...args, '--json', JSON.stringify(opt || {})])

    if (req.method === 'GET' && path === `${API_PREFIX}/status`) return sendJson(res, 200, await status())

    if (path === `${API_PREFIX}/config`) {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: cfg })
      if (req.method === 'POST') {
        const body = await readBody(req)
        const next = { ...cfg }
        for (const [k, v] of Object.entries(body || {})) {
          if (!(k in DEFAULT_CONFIG)) continue
          if (k === 'upRules' || k === 'otherUids' || k === 'otherKeywords' || k === 'otherDoneBvids') {
            if (Array.isArray(v)) next[k] = v
          } else if (typeof DEFAULT_CONFIG[k] === 'boolean') next[k] = Boolean(v)
          else if (typeof DEFAULT_CONFIG[k] === 'number') next[k] = Number(v) || 0
          else next[k] = String(v ?? '')
        }
        // 走一遍 loadConfig 的归一化：把坏的 uid、越界的币数挡在外面
        writeJson(CONFIG_FILE, next)
        return sendJson(res, 200, { ok: true, config: loadConfig() })
      }
    }

    if (req.method === 'POST' && path === `${API_PREFIX}/login/start`) {
      const r = await runPy(python, ['login-start'], { timeoutMs: 60_000 })
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error, stderr: r.stderr })
    }
    if (req.method === 'POST' && path === `${API_PREFIX}/login/poll`) {
      const body = await readBody(req)
      const r = await runPy(python, ['login-poll', '--json', JSON.stringify({ key: String(body.key || '') })], { timeoutMs: 60_000 })
      if (!r.ok) return sendJson(res, 200, { ok: false, state: 'unknown', error: r.error, stderr: r.stderr })
      if (r.data && r.data.state === 'ok') {
        // 换了个人登录，收藏夹缓存就不作数了
        try { writeJson(FAV_IDS_FILE, { at: 0, lists: [] }) } catch { /* 无所谓 */ }
      }
      return sendJson(res, 200, { ok: true, ...r.data })
    }
    if (req.method === 'POST' && path === `${API_PREFIX}/logout`) {
      // 只删自己家目录那份，刷B站的凭证不碰
      const own = join(STATE_DIR, 'bili_credential.json')
      try {
        if (existsSync(own)) rmSync(own, { force: true })
        writeJson(FAV_IDS_FILE, { at: 0, lists: [] })
        return sendJson(res, 200, { ok: true, removed: own })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: `删不掉：${e?.message ?? e}` })
      }
    }

    /* ── 浏览 ── */
    if (req.method === 'GET' && path === `${API_PREFIX}/up-videos`) {
      const uid = String(url.searchParams.get('uid') || '')
      const r = await browse('up-videos', [uid], {
        page: Number(url.searchParams.get('page') || 1),
        ps: Math.min(30, Number(url.searchParams.get('ps') || 20)),
        order: String(url.searchParams.get('order') || 'pubdate'),
      })
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error })
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/user-info`) {
      const r = await browse('user-info', [String(url.searchParams.get('uid') || '')], {})
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error })
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/convert-uid`) {
      const q = String(url.searchParams.get('q') || '')
      const r = await browse('convert-uid', [q], {})
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error })
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/search`) {
      const r = await browse('search', [String(url.searchParams.get('q') || '')], {
        num: Math.min(50, Number(url.searchParams.get('num') || 24)),
        order: String(url.searchParams.get('order') || 'pubdate'),
        page: Number(url.searchParams.get('page') || 1),
      })
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error })
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/rank`) {
      const r = await browse('rank', [], { num: Math.min(100, Number(url.searchParams.get('num') || 30)) })
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error })
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/fav-lists`) {
      const r = await runPy(python, ['fav-lists'])
      if (r.ok && r.data) writeJson(FAV_IDS_FILE, { at: Date.now(), lists: r.data.lists || [] })
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error })
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/fav-content`) {
      const r = await browse('fav-content', [String(url.searchParams.get('mediaId') || '')], {
        page: Number(url.searchParams.get('page') || 1),
      })
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error })
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/video-state`) {
      const r = await browse('video-state', [String(url.searchParams.get('bvid') || '')], {})
      return sendJson(res, 200, r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error })
    }

    /* ── 手动三连：挑好的那几条 ── */
    if (req.method === 'POST' && path === `${API_PREFIX}/triple`) {
      const body = await readBody(req)
      const dryRun = Boolean(body.dryRun)
      const items = (Array.isArray(body.items) ? body.items : [])
        .map((x) => (typeof x === 'string' ? { bvid: x } : x))
        .map((x) => ({ bvid: String(x?.bvid || '').trim() }))
        .filter((x) => /^BV[0-9A-Za-z]{10}$/.test(x.bvid))
      if (!items.length) return sendJson(res, 200, { ok: false, error: '没有解析出 BV 号' })
      const rule = {
        doLike: body.doLike !== false,
        doCoin: body.doCoin !== false,
        coinNum: Number(body.coinNum) >= 2 ? 2 : 1,
        doFav: body.doFav !== false,
        favMediaId: Number(body.favMediaId) || 0,
      }
      const defaults = (rule.doFav && !rule.favMediaId) || body.favMediaId === 'default' ? await fetchDefaultFavId(python) : 0
      const out = []
      const day = today()
      let used = todayCount()
      const cap = Number(cfg.dailyLimit || 0)
      for (const { bvid } of items) {
        if (cap > 0 && used >= cap) { out.push({ bvid, ok: false, error: `今天的额度（${cap} 条）用完了` }); continue }
        if (dryRun) { out.push({ bvid, ok: true, dryRun: true }); continue }
        const r = await tripleOne(python, bvid, rule, cfg, defaults)
        const ok = Boolean(r.ok && r.data && r.data.ok)
        if (ok) used++
        const rec = {
          day, at: nowIso(), bvid, tag: String(body.tag || '手动挑选'), ok,
          title: (r.data && r.data.title) || '',
          steps: (r.data && r.data.steps) || [],
          error: r.ok ? '' : String(r.error || ''),
        }
        appendHistory(rec)
        out.push({ bvid, ok, title: rec.title, steps: rec.steps, error: rec.error })
        await new Promise((r2) => setTimeout(r2, Math.max(300, Number(cfg.pauseMinMs) || 1200)))
      }
      const okN = out.filter((x) => x.ok).length
      return sendJson(res, 200, { ok: true, done: okN, total: out.length, results: out, dryRun })
    }

    /* ── 巡查 ── */
    if (req.method === 'POST' && path === `${API_PREFIX}/run`) {
      const body = await readBody(req)
      const r = await runOnce('manual', { dryRun: Boolean(body.dryRun), forceUp: Boolean(body.forceUp) })
      return sendJson(res, 200, r)
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/history`) {
      const { rows, tail } = readHistory(Number(url.searchParams.get('limit') || 200))
      return sendJson(res, 200, { ok: true, count: rows.length, today: todayCount(), items: tail })
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/last-run`) {
      return sendJson(res, 200, { ok: true, lastRun, running: Boolean(running) })
    }

    return sendJson(res, 404, { ok: false, error: `没有这个接口：${req.method} ${path}` })
  }

  /* ── 挂路由 ── */
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        if (fenceReject(ctx, req, res)) return
        if (!sameOriginOk(req)) {
          try { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }) } catch { /* 忽略 */ }
          return
        }
        try {
          await handle(req, res, new URL(req.url || '/', 'http://127.0.0.1'))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-triple: /api/bili-triple 路由')
  } catch (e) {
    log('HTTP 路由没挂上：' + (e?.message ?? e))
  }

  /* ── 定时巡查 ── */
  ctx.effect(() => {
    let timer = null
    let stopped = false
    const schedule = () => {
      if (stopped) return
      const c = loadConfig()
      const mins = Number(c.intervalMinutes) || 0
      if (!c.enabled || mins <= 0) { timer = null; return }
      timer = setTimeout(async () => {
        try { await runOnce('auto') } catch { /* 已经记在 lastRun 里了 */ }
        schedule()
      }, mins * 60_000)
      timer.unref?.()
    }
    // 起来先等一分钟（别和宿主抢启动），之后按配置排
    const kick = setTimeout(() => schedule(), 60_000)
    kick.unref?.()
    // 配置改了要重排：前端存配置时 POST /config，这里盯住文件 mtime
    let lastM = 0
    const watch = setInterval(() => {
      try {
        const m = statSync(CONFIG_FILE).mtimeMs
        if (m !== lastM) {
          lastM = m
          if (timer) { clearTimeout(timer); timer = null }
          schedule()
        }
      } catch { /* 还没文件 */ }
    }, 15_000)
    watch.unref?.()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      clearTimeout(kick)
      clearInterval(watch)
    }
  }, 'bili-triple: 定时巡查')

  log(`已挂载（家=${STATE_DIR}，python=${resolvePython(loadConfig().pythonPath).path}）`)
}
