/**
 * First-run setup for the packaged app: install a Python runtime and the backend's
 * dependencies with the bundled `uv`, then download models through the backend.
 * Streams progress events to the renderer. Nothing here runs in `npm run dev`.
 */
import { spawn, ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { SetupEvent } from './preload'

export interface SetupPaths {
  uv: string
  backendDir: string // folder containing pyproject.toml + obsar/
  dataDir: string
  modelsDir: string
}

export class SetupCancelled extends Error {}

export class SetupRunner {
  private current: ChildProcess | null = null
  private cancelled = false

  constructor(
    private paths: SetupPaths,
    private emit: (ev: SetupEvent) => void
  ) {}

  cancel() {
    this.cancelled = true
    const p = this.current
    if (p?.pid) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/f', '/t'], { windowsHide: true })
      else p.kill('SIGTERM')
    }
  }

  pythonPath(): string {
    return join(this.paths.dataDir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  }

  /** Steps 1 and 2. Step 3 (models) is driven by the backend once it is running. */
  async installRuntime(): Promise<void> {
    mkdirSync(this.paths.dataDir, { recursive: true })
    mkdirSync(this.paths.modelsDir, { recursive: true })
    const env = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: join(this.paths.dataDir, 'python'),
      UV_PROJECT_ENVIRONMENT: join(this.paths.dataDir, 'venv'),
      UV_CACHE_DIR: join(this.paths.dataDir, 'uv-cache'),
      UV_NO_PROGRESS: '1',
      PYTHONIOENCODING: 'utf-8'
    }

    this.emit({ step: 'python', state: 'running' })
    await this.run([this.paths.uv, 'python', 'install', '3.12'], env, 'python')
    this.emit({ step: 'python', state: 'done', percent: 100 })

    this.emit({ step: 'deps', state: 'running' })
    if (existsSync(this.pythonPath()) && existsSync(join(this.paths.dataDir, 'venv', '.obsar-ok'))) {
      this.emit({ step: 'deps', state: 'skipped', line: 'already installed' })
    } else {
      // uv prints one line per package while downloading; ~87 packages in the lock
      let seen = 0
      await this.run(
        [this.paths.uv, 'sync', '--frozen', '--no-dev', '--python', '3.12', '--project', this.paths.backendDir],
        env,
        'deps',
        (line) => {
          if (/^\s*[+~-] /.test(line) || /Downloading|Prepared|Installed/.test(line)) seen++
          return Math.min(99, (seen / 90) * 100)
        }
      )
      const fs = await import('fs')
      fs.writeFileSync(join(this.paths.dataDir, 'venv', '.obsar-ok'), new Date().toISOString())
      this.emit({ step: 'deps', state: 'done', percent: 100 })
    }
  }

  private run(cmd: string[], env: NodeJS.ProcessEnv, step: SetupEvent['step'], progress?: (line: string) => number | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new SetupCancelled())
      this.emit({ step, state: 'running', line: `> ${cmd.join(' ')}` })
      const p = spawn(cmd[0], cmd.slice(1), { env, windowsHide: true })
      this.current = p
      const onData = (d: Buffer) => {
        for (const raw of d.toString().split(/\r?\n/)) {
          const line = raw.trim()
          if (!line) continue
          const percent = progress?.(line)
          this.emit({ step, state: 'running', line, percent })
        }
      }
      p.stdout?.on('data', onData)
      p.stderr?.on('data', onData)
      p.on('error', (e) => {
        this.current = null
        this.emit({ step, state: 'error', error: e.message })
        reject(e)
      })
      p.on('exit', (code) => {
        this.current = null
        if (this.cancelled) return reject(new SetupCancelled())
        if (code === 0) resolve()
        else {
          const msg = `${cmd[0].split(/[\\/]/).pop()} exited with code ${code}`
          this.emit({ step, state: 'error', error: msg })
          reject(new Error(msg))
        }
      })
    })
  }
}
