// session-zstd.mjs —— 读 DSH 会话日志（zstd 多帧）的唯一实现。
//
// 为什么单独一个文件：这段逻辑原先在 memq.mjs 和 memindex.mjs 里各有一份，
// 逐字对比只差一个返回值（memindex 要帧数，memq 不要）。一份逻辑两个副本，
// 改一处忘另一处就会两边读出不同结果 —— 2026-10-26 自查时发现的。
//
// ★ 三个不能省的细节（都是摔出来的）：
//   1. carry 不能省。一行 JSON 可能跨帧，按帧 split 会截断并**静默丢记录**。
//   2. 单行封顶 8 MB。超长行对检索没价值，留着只会拖慢。
//   3. 逐帧 try/catch。坏帧跳过，不让一个坏帧毁掉整份日志。
//
// ★ 刻意没合并的：echo-doctor.mjs 里那份同名函数。
//   它多做了两件事 —— 解压总量封顶 192MB、从**尾部**往前解，
//   起因是它自己撞上过单会话日志 155 MB / 解压过 1 GB 把体检器撑爆。
//   体检要看整份日志的统计，和这里「拿最近几条」不是一个需求，所以留着两份。

import fs from 'node:fs'
import zlib from 'node:zlib'

/** zstd 帧头魔数。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解一份多帧 zstd 会话日志。
 *
 * @param {string} file
 * @returns {{ recs: object[], frames: number, failedFrames: number }}
 *   recs   逐行 JSON.parse 成功的记录（按出现顺序）
 *   frames 帧数（统计用）
 *   failedFrames 解码失败的帧数（不是 JSON 失败的，是 zstd 解不开的）
 */
export function decodeSessionZstd(file) {
  const buf = fs.readFileSync(file)
  const frames = []
  let s = buf.indexOf(ZSTD_MAGIC, 0)
  while (s >= 0) {
    let e = buf.indexOf(ZSTD_MAGIC, s + 4)
    if (e < 0) e = buf.length
    frames.push(buf.subarray(s, e))
    s = buf.indexOf(ZSTD_MAGIC, e)
  }

  const recs = []
  const MAX_LINE = 8 * 1024 * 1024 // 单行上限 8 MB
  let failedFrames = 0
  let carry = ''

  const take = (line) => {
    if (line.length > MAX_LINE) return
    const t = line.trim()
    if (!t) return
    try { recs.push(JSON.parse(t)) } catch { /* 非 JSON 行：跳过，不吵 */ }
  }

  for (const f of frames) {
    let out
    try { out = zlib.zstdDecompressSync(f) } catch { failedFrames += 1; continue }
    let str
    try { str = out.toString('utf8') } catch { failedFrames += 1; continue }
    const parts = (carry + str).split('\n')
    carry = parts.pop() || ''
    for (const line of parts) take(line)
    if (carry.length > MAX_LINE) carry = ''
  }
  if (carry) take(carry)

  return { recs, frames: frames.length, failedFrames }
}
