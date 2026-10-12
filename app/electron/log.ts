/** Size-rotated text log at <dir>/logs/obsar.log so users can send something when things break. */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

const MAX = 2_000_000
const KEEP = 2

let dir: string | null = null
let file: string | null = null

export function initLog(baseDir: string) {
  dir = join(baseDir, 'logs')
  try {
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'obsar.log')
    rotate()
    write(`---- OBSAR start ${new Date().toISOString()} ----`)
  } catch {
    file = null
  }
}

export function logDir(): string | null {
  return dir
}

function rotate() {
  if (!file || !existsSync(file)) return
  try {
    if (statSync(file).size < MAX) return
    for (let i = KEEP; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      if (existsSync(to)) unlinkSync(to)
      if (existsSync(from)) renameSync(from, to)
    }
  } catch {}
}

let sinceCheck = 0
export function write(line: string) {
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    if (++sinceCheck > 200) {
      sinceCheck = 0
      rotate()
    }
  } catch {}
}
