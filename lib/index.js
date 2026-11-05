/**
 * dsh-session-archive — 会话闲置归档（宿主内插件，路线甲）。
 * 架构参考 dsh-session-pruner 0.3.3 (Apache-2.0, mrzhangkris)，代码自写。
 * 与 pruner 的差异（熙枫 2026-11-05 拍板）：
 *   1. 判型：闲置 idleDays 天 = 全类型归档（main/one-shot/continuable 一视同仁），
 *      「完成了任务」的判据就是闲置本身。只保留 live + pin + 脑 fail-closed 三层保护。
 *   2. 解 zstd 用自带 lib/zstd.mjs（node zlib 多帧，带 carry/坏帧跳过），
 *      不依赖系统 zstd 命令。
 *   3. 无容量保底、无归档到期自动删除（保留期 policy 永不自动删）。
 *   4. pin 三层：账本 lead（实时重读，含裸 UUID 形态）+ pin-sessions.txt + 面板白名单。
 *   5. 三根布局：只扫 sessions/；sessions-roots（退位脑）与 sessions-archive 不碰。
 */
import { readdir, readFile, rename, mkdir, stat, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { decodeSessionZstd } from './zstd.mjs'

export const name = 'dsh-session-archive'
export const inject = ['timer', 'storageDomain']

const NS = 'dsh-session-archive'

/** 设置面板 schema（Host 侧声明）。 */
const Config = z.object({
  /** 闲置归档阈值（天）：日志 mtime 超过 N 天即归档 */
  idleDays: z.number().min(1).max(365).default(2),
  /** 对账扫描间隔（分钟）：事件驱动为主路径时这是兜底周期 */
  intervalMinutes: z.number().min(1).max(1440).default(60),
  /** one-shot 完成归档宽限（分钟）：事件驱动热路径的复查延迟 */
  oneShotMinAgeMinutes: z.number().min(0).max(60).default(3),
  /** Pin 白名单（面板每行一个）：完整 id 或短 id 都认 */
  pinnedIds: z.array(z.string()).default([]),
  /** 容量保底（会话数）：超限按最旧回收，0 = 关闭 */
  maxSessions: z.number().min(0).max(100000).default(0),
  /** 归档保留期（天）：到期只在状态行提醒，绝不自动删除 */
  retentionDays: z.number().min(0).max(36500).default(0),
})

const DSH_HOME = process.env.DSH_HOME ?? (process.env.USERPROFILE ?? process.env.HOME ?? '') + '/.dsh'
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const ARCHIVE_ROOT = join(DSH_HOME, 'sessions-archive')
const ECHO_HUB = 'D:/echo/memory/hub'
const LEDGER = 'D:/echo/soul/02-痕.jsonl'
const PIN_FILE = ECHO_HUB + '/pin-sessions.txt'

const runtime = {
  idleMs: 2 * 86400000,
  intervalMs: 60 * 60000,
  oneShotMinAgeMs: 3 * 60000,
  maxSessions: 0,
  retentionDays: 0,
  disposeTimer: null,
}

/** 账本 lead 短 id 集合（实时重读——新一代接手自动受保护）。 */
function ledgerPins() {
  const pins = new Set()
  try {
    for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (r.type === 'lead' && r.by) pins.add(String(r.by))
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 账本读不到：警告但不挡 */ }
  return pins
}

/** 人工 pin 文件（hub/pin-sessions.txt）。 */
function filePins() {
  const pins = new Set()
  try {
    for (const line of readFileSync(PIN_FILE, 'utf8').split('\n')) {
      const s = line.trim()
      if (s && !s.startsWith('#')) pins.add(s.replace(/^session-/, ''))
    }
  } catch { /* 无文件正常 */ }
  return pins
}

/** pin 总集合：账本 lead + 人工文件 + 面板白名单。匹配裸 UUID 与 session- 两种形态。 */
function computePins(panelIds) {
  const pins = new Set()
  for (const s of [...ledgerPins(), ...filePins(), ...(panelIds || [])]) {
    pins.add(s.replace(/^session-/, ''))
  }
  return pins
}

/** pin 匹配：sid 目录名（session-xxx 或裸 uuid）对短 id 前缀。 */
function isPinned(pins, sid) {
  const bare = sid.replace(/^session-/, '')
  for (const p of pins) {
    if (bare === p || bare.startsWith(p + '-')) return true
  }
  return false
}

/** fail-closed：《痕》最后一条 lead 的短 id（脑）。 */
function lastLeadShort() {
  try {
    const rows = readFileSync(LEDGER, 'utf8').split('\n').filter(l => l.trim())
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(rows[i])
        if (r.type === 'lead' && r.by) return String(r.by)
      } catch {}
    }
  } catch {}
  return null
}

/** live 判定（照搬 pruner，fail-closed：store 查不到/异常都当 live）。 */
function isLive(ctx, sid) {
  try {
    const sessions = typeof ctx.get === 'function' && ctx.get('sessions')
    if (!sessions || typeof sessions.get !== 'function') return true
    return !!sessions.get(sid)
  } catch {
    return true
  }
}

/** 解一份会话日志（自带多帧 zstd，node zlib）。返回 { origin, mode, ended }。 */
function decodeSession(logPath) {
  const info = { origin: 'main', mode: null, ended: false }
  try {
    const { recs } = decodeSessionZstd(logPath)
    for (const r of recs) {
      if (r.type === 'session' && r.origin === 'subagent') info.origin = 'subagent'
      else if (r.type === 'subagent/descriptor') {
        const m = r.data?.mode
        if (m === 'one-shot' || m === 'continuable') info.mode = m
      } else if (r.type === 'session/end-seed') info.ended = true
    }
  } catch { /* 解码失败：仍按 main 处理（main 只有 live/pin 保护，无 ended 门槛） */ }
  return info
}

/** 扫描 sessions/ 全部会话（版本无感认 session.v<N>.jsonl.zstd）。 */
async function scanSessions() {
  const found = []
  let wsNames = []
  try { wsNames = await readdir(SESSIONS_ROOT) } catch { return found }
  for (const ws of wsNames) {
    const wp = join(SESSIONS_ROOT, ws)
    let sids = []
    try { sids = await readdir(wp) } catch { continue }
    for (const sid of sids) {
      const dir = join(wp, sid)
      let logName = null
      try {
        for (const n of await readdir(dir)) {
          if (/^session\.v\d+\.jsonl\.zstd$/.test(n)) { logName = n; break }
        }
      } catch { continue }
      if (!logName) continue
      const logPath = join(dir, logName)
      let mtime = 0
      try { mtime = (await stat(logPath)).mtimeMs } catch { continue }
      if (mtime === 0) continue
      found.push({ ws, sid, dir, logPath, mtime, ...decodeSession(logPath) })
    }
  }
  return found
}

/** 归档一个会话：mv 到 archive 根（保结构）→ 官方 API 清 projcache 行 + workspace 记账。 */
async function archiveSession(ctx, entry, reason) {
  const sid = entry.sid
  try {
    const destWs = join(ARCHIVE_ROOT, entry.ws)
    await mkdir(destWs, { recursive: true })
    await rm(join(destWs, sid), { recursive: true, force: true }) // 幂等
    await rename(entry.dir, join(destWs, sid))
  } catch (e) {
    console.error('[dsh-session-archive] archive failed', sid, e)
    return false
  }
  let cache = false
  try {
    const domain = ctx.storageDomain?.get('session_projcache')
    const table = domain && (typeof domain.table === 'function' ? domain.table('sessions') : domain.tables?.get?.('sessions'))
    if (table && typeof table.delete === 'function') { await table.delete(sid); cache = true }
  } catch (e) { console.error('[dsh-session-archive] projcache purge failed', sid, e) }
  try {
    const wsDomain = ctx.storageDomain?.get('workspace')
    const wsTable = wsDomain?.tables?.workspaces
    if (wsTable && typeof wsTable.entries === 'function' && typeof wsTable.update === 'function') {
      for (const [wsId, rec] of wsTable.entries()) {
        if (Array.isArray(rec?.sessionIds) && rec.sessionIds.includes(sid)) {
          await wsTable.update(wsId, (record) =>
            record.sessionIds.includes(sid)
              ? { ...record, sessionIds: record.sessionIds.filter((id) => id !== sid) }
              : record)
          // 归档进 archivedSessionIds（与脚本行为一致）
          try {
            const g = wsDomain?.tables?.global
            if (g && typeof g.update === 'function') {
              await g.update('global', (record) => {
                const list = Array.isArray(record?.archivedSessionIds) ? record.archivedSessionIds : []
                if (!list.includes(sid)) return { ...record, archivedSessionIds: [...list, sid] }
                return record
              })
            }
          } catch { /* 记账失败不挡 */ }
          break
        }
      }
    }
  } catch (e) { console.error('[dsh-session-archive] workspace detach failed', sid, e) }
  recordArchive(sid, reason)
  console.log('[dsh-session-archive] archived', sid.slice(0, 12), '(' + entry.origin + '/' + (entry.mode ?? '-') + ')', reason, 'cache=' + cache)
  return true
}

/** 归档变更日志（dirty-flag 数据源，client 轮询）。 */
const archiveLog = []
let archiveSeq = 0
function recordArchive(sid, reason) {
  archiveSeq += 1
  archiveLog.push({ seq: archiveSeq, sid, reason, at: Date.now() })
  if (archiveLog.length > 200) archiveLog.shift()
}

/** 主扫描：闲置即归档（全类型），脑 fail-closed，pin 三层。 */
async function runOnce(ctx, opts = {}) {
  const pins = computePins(opts.panelIds ?? [])
  const brain = lastLeadShort()
  const all = await scanSessions()
  const now = Date.now()
  let removed = 0
  const archivedThisRun = []
  const survivors = []
  for (const s of all) {
    if (isLive(ctx, s.sid)) { survivors.push(s); continue }
    if (isPinned(pins, s.sid)) { survivors.push(s); continue }
    // fail-closed：脑不能被归档
    if (brain && s.sid.replace(/^session-/, '').startsWith(brain)) {
      console.warn('[dsh-session-archive] brain refuse', s.sid.slice(0, 12))
      survivors.push(s); continue
    }
    if (now - s.mtime > runtime.idleMs) {
      const reason = 'idle > ' + Math.round(runtime.idleMs / 86400000) + 'd (' + s.origin + '/' + (s.mode ?? '-') + ')'
      if (await archiveSession(ctx, s, reason)) {
        archivedThisRun.push({ sid: s.sid, origin: s.origin, mode: s.mode, reason })
        removed++
        continue
      }
    }
    survivors.push(s)
  }
  // 容量保底（默认 0=关；照搬 pruner 优先级）
  if (runtime.maxSessions > 0 && survivors.length > runtime.maxSessions) {
    const excess = survivors.length - runtime.maxSessions
    const sorted = [...survivors].sort((a, b) => {
      const pa = a.origin !== 'subagent' ? 2 : (a.mode === 'one-shot' ? 0 : 1)
      const pb = b.origin !== 'subagent' ? 2 : (b.mode === 'one-shot' ? 0 : 1)
      return pa !== pb ? pa - pb : a.mtime - b.mtime
    })
    let trimmed = 0
    for (const s of sorted) {
      if (trimmed >= excess) break
      if (isLive(ctx, s.sid) || isPinned(pins, s.sid)) continue
      if (brain && s.sid.replace(/^session-/, '').startsWith(brain)) continue
      if (await archiveSession(ctx, s, 'capacity cap')) { trimmed++; removed++ }
    }
  }
  lastScanStatus = { generatedAt: now, total: all.length, archivedCount: removed, archived: archivedThisRun.slice(0, 50) }
  console.log('[dsh-session-archive] scan done:', all.length, 'total, archived', removed)
  return lastScanStatus
}

let lastScanStatus = { generatedAt: 0, total: 0, archivedCount: 0, archived: [] }

/** 状态快照（client 轮询用）。 */
function buildStatusSnapshot(panelIds) {
  const expired = []
  if (runtime.retentionDays > 0) {
    const cut = Date.now() - runtime.retentionDays * 86400000
    try {
      for (const ws of readdirSyncSafe(ARCHIVE_ROOT)) {
        for (const sid of readdirSyncSafe(join(ARCHIVE_ROOT, ws))) {
          const dir = join(ARCHIVE_ROOT, ws, sid)
          let m = 0
          try { m = (statSyncSafe(dir)).mtimeMs } catch { continue }
          if (m && m < cut) expired.push(sid)
        }
      }
    } catch { /* 归档根不存在正常 */ }
  }
  return { ...lastScanStatus, archiveCount: archiveLog.length, retentionDays: runtime.retentionDays, expiredList: expired.slice(0, 50), idleDays: runtime.idleMs / 86400000 }
}

function readdirSyncSafe(d) { try { return existsSync(d) ? require('node:fs').readdirSync(d) : [] } catch { return [] } }
function statSyncSafe(d) { return require('node:fs').statSync(d) }

/** 事件驱动候选队列（照搬 pruner 双轨）。 */
const candidates = new Map()
let flushTimer = null
function enqueueCandidate(ctx, id, panelIds) {
  candidates.set(id, { at: Date.now() })
  if (flushTimer) return
  flushTimer = ctx.timer.setTimeout(async () => {
    flushTimer = null
    const due = []
    for (const [sid, c] of candidates) {
      if (Date.now() - c.at >= runtime.oneShotMinAgeMs) { due.push(sid); candidates.delete(sid) }
    }
    for (const sid of due) {
      if (isLive(ctx, sid)) continue
      // 宽限后从磁盘判定：单会话解压
      const pins = computePins(panelIds)
      if (isPinned(pins, sid)) continue
      const brain = lastLeadShort()
      if (brain && sid.replace(/^session-/, '').startsWith(brain)) continue
      // 定位目录
      let hit = null
      try {
        for (const ws of await readdir(SESSIONS_ROOT)) {
          const dir = join(SESSIONS_ROOT, ws, sid)
          if (existsSync(dir)) { hit = { ws, sid, dir }; break }
        }
      } catch {}
      if (!hit) continue
      let mtime = 0
      let logPath = null
      try {
        for (const n of await readdir(hit.dir)) if (/^session\.v\d+\.jsonl\.zstd$/.test(n)) { logPath = join(hit.dir, n); break }
        if (logPath) mtime = (await stat(logPath)).mtimeMs
      } catch {}
      if (!logPath || !mtime) continue
      const oneShotAge = Date.now() - mtime
      if (oneShotAge > runtime.oneShotMinAgeMs) {
        await archiveSession(ctx, { ...hit, mtime, origin: 'subagent', mode: 'one-shot' }, 'one-shot idle (event)')
      }
    }
  }, 500)
}

/** Web 路由：/plugins/dsh-session-archive/status 与 /archived（dirty-flag）。 */
const WEB_SERVER_KEYS = ['webServer', 'httpServer']
function registerRoutes(ctx) {
  // 形状对齐 pruner：webServer.register({ kind:'exact', path, handler(req,res) }) 原生注册。
  // 之前写 router.get() 是发明的 API，路由从未挂上（01:48 定位）。
  for (const key of WEB_SERVER_KEYS) {
    const webServer = ctx.get?.(key)
    if (!webServer || typeof webServer.register !== 'function') continue
    try {
      webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-session-archive/status',
        handler: (req, res) => {
          buildStatusSnapshot()
            .then((snap) => {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(snap))
            })
            .catch((e) => {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: String(e) }))
            })
        },
      })
      webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-session-archive/archived',
        handler: (req, res) => {
          let since = 0
          try { since = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('since')) || 0 } catch { /* 非法 since 视为 0 */ }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ seq: archiveSeq, archived: archiveLog.filter((x) => x.seq > since) }))
        },
      })
      webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-session-archive/run-once',
        handler: (req, res) => {
          runOnce(ctx)
            .then((snap) => {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(snap))
            })
            .catch((e) => {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: String(e) }))
            })
        },
      })
      return true
    } catch (e) {
      console.error('[dsh-session-archive] route register failed:', e)
      return false
    }
  }
  return false
}

export function apply(ctx, config) {
  const applyCfg = (c) => {
    if (!c) return
    runtime.idleMs = (c.idleDays ?? 2) * 86400000
    runtime.intervalMs = (c.intervalMinutes ?? 60) * 60000
    runtime.oneShotMinAgeMs = (c.oneShotMinAgeMinutes ?? 3) * 60000
    runtime.maxSessions = c.maxSessions ?? 0
    runtime.retentionDays = c.retentionDays ?? 0
  }
  applyCfg(config)

  // 事件驱动热路径（one-shot 完成即入队）
  const onEnd = (id) => {
    try {
      const session = ctx.get?.('sessions')?.get?.(id)
      if (session) {
        if (session.header?.origin !== 'subagent') return
        let mode
        for (const e of session.events ?? []) {
          if (e?.type === 'subagent/descriptor') { mode = e.data?.mode; break }
        }
        if (mode !== 'one-shot') return
      }
      enqueueCandidate(ctx, id, config?.pinnedIds)
    } catch (e) { console.error('[dsh-session-archive] event handler error:', e) }
  }
  ctx.on?.('subagent/end', ({ id }) => onEnd(id))
  ctx.on?.('agent/disposed', ({ agent }) => onEnd(agent?.id))

  if (!registerRoutes(ctx)) {
    ctx.on?.('internal/service', (name) => { if (WEB_SERVER_KEYS.includes(name)) registerRoutes(ctx) })
  }

  const safeRun = () => runOnce(ctx).catch((e) => console.error('[dsh-session-archive] scan error:', e))
  try {
    ctx.inject?.(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, NS, Config, config, {
        setSource: (current) => { config = current },
        onChange: () => {
          try {
            applyCfg(config)
            if (runtime.disposeTimer) runtime.disposeTimer()
            runtime.disposeTimer = ctx.timer.interval(safeRun, runtime.intervalMs)
            console.log('[dsh-session-archive] hot-reloaded: idle=' + (runtime.idleMs / 86400000) + 'd interval=' + (runtime.intervalMs / 60000) + 'min')
          } catch (e) { console.error('[dsh-session-archive] onChange error:', e) }
        },
      })
    })
  } catch (e) { console.error('[dsh-session-archive] settings section unavailable:', e) }

  ctx.timer.setTimeout(safeRun, 5000)
  runtime.disposeTimer = ctx.timer.interval(safeRun, runtime.intervalMs)
  console.log('[dsh-session-archive] armed: idle=' + (runtime.idleMs / 86400000) + 'd interval=' + (runtime.intervalMs / 60000) + 'min')
}

export { runOnce, archiveSession, scanSessions, decodeSession, isLive, buildStatusSnapshot, computePins, isPinned }
