import type { ObsarApi } from '../electron/preload'

declare global {
  interface Window {
    obsar: ObsarApi
  }
}

export {}
