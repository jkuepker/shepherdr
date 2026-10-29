// Which terminal runtime Shepherdr's agents run in: herdr (the default, Shepherdr's herdr plugin home), or herdr-core
// (`hc`, the runtime the Herdr desktop app shows; hc.ts). SHEPHERDR_BACKEND=hc picks hc, or {"backend": "hc"} in
// ~/.shepherdr/backend.json (the main machine's, which every machine's worker reads too).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME } from '../store.ts'

function picked(): 'herdr' | 'hc' {
  const env = process.env.SHEPHERDR_BACKEND
  if (env) return env === 'hc' ? 'hc' : 'herdr'
  try {
    const f = join(process.env.SHEPHERDR_MAIN_HOME ?? HOME, 'backend.json')
    return existsSync(f) && (JSON.parse(readFileSync(f, 'utf8')) as { backend?: string }).backend === 'hc' ? 'hc' : 'herdr'
  } catch {
    return 'herdr'
  }
}

export const BACKEND = picked()

/** what herdr (or hc, in herdr's words) refused or failed at: its error code and message */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HerdrError'
  }
}
