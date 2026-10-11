// Downloads the pinned uv release for Windows into resources/bin/uv.exe (cached).
// Runs before `npm run dist`. uv installs Python + the backend's dependencies on the user's machine.
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const UV_VERSION = '0.9.5'
const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'resources', 'bin')
const exe = join(outDir, 'uv.exe')
const stamp = join(outDir, 'uv.version')

if (existsSync(exe) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === UV_VERSION) {
  console.log(`uv ${UV_VERSION} already present`)
  process.exit(0)
}
mkdirSync(outDir, { recursive: true })
const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`
const zip = join(outDir, 'uv.zip')
console.log(`downloading ${url}`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok) throw new Error(`download failed: ${res.status}`)
await new Promise((resolve, reject) => {
  const ws = createWriteStream(zip)
  res.body.pipeTo(
    new WritableStream({
      write(chunk) {
        ws.write(chunk)
      },
      close() {
        ws.end(resolve)
      },
      abort: reject
    })
  )
})
execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zip}' -DestinationPath '${outDir}'`], { stdio: 'inherit' })
rmSync(zip)
if (!existsSync(exe)) throw new Error('uv.exe not found after extraction')
import('fs').then((fs) => fs.writeFileSync(stamp, UV_VERSION))
console.log(`uv.exe ready (${(statSync(exe).size / 1e6).toFixed(1)} MB)`)
