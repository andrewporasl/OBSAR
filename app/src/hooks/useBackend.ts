import { useCallback, useEffect, useRef, useState } from 'react'
import { api, Library, setBase, Status, Storage } from '../api'
import type { BackendInfo } from '../../electron/preload'

/** Boots the backend connection and polls status; libraries/storage refresh on demand or on change. */
export function useBackend() {
  const [info, setInfo] = useState<BackendInfo | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [libraries, setLibraries] = useState<Library[]>([])
  const [storage, setStorage] = useState<Storage | null>(null)
  const [down, setDown] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const lastSig = useRef('')

  const refreshInfo = useCallback(async () => {
    const i = await window.obsar.backendInfo()
    setBase(i.url)
    setLog(i.log)
    setInfo(i)
    return i
  }, [])

  const refreshLibraries = useCallback(async () => {
    try {
      setLibraries((await api.libraries()).items)
    } catch {}
  }, [])
  const refreshStorage = useCallback(async () => {
    try {
      setStorage(await api.storage())
    } catch {}
  }, [])

  useEffect(() => {
    refreshInfo()
    const offs = [
      window.obsar.onBackendLog((l) => setLog((p) => [...p.slice(-399), l])),
      window.obsar.onBackendExit(() => setDown(true)),
      window.obsar.onBackendStarted(() => {
        // new process, possibly new port: re-read the connection info and resume polling
        setTimeout(() => refreshInfo().then(() => setDown(false)), 500)
      })
    ]
    return () => offs.forEach((f) => f())
  }, [refreshInfo])

  useEffect(() => {
    if (!info || info.needsSetup) return
    let alive = true
    const tick = async () => {
      try {
        const s = await api.status()
        if (!alive) return
        setStatus(s)
        setDown(false)
        // refresh the library list whenever counts change
        const sig = JSON.stringify([s.library_count, s.done, s.total, s.error, Object.values(s.libraries).map((l) => l.paused)])
        if (sig !== lastSig.current) {
          lastSig.current = sig
          refreshLibraries()
        }
      } catch {
        if (alive) setStatus(null)
      }
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [info, refreshLibraries])

  return { info, status, libraries, storage, down, log, refreshInfo, refreshLibraries, refreshStorage }
}
