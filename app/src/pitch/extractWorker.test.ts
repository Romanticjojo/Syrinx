import { Worker as NodeWorker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractPitchTrack, extractPitchTrackAsync } from './compare'

const tsModuleUrl = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href
// Transpile in the worker loader instead of relying on Node 22+ native TS support.
const loaderSource = `
  import { readFile } from 'node:fs/promises';
  import ts from ${JSON.stringify(tsModuleUrl)};
  export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error;
      return nextResolve(specifier + '.ts', context);
    }
  }
  export async function load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    const source = await readFile(new URL(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: ts.transpile(source, {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
    }) };
  }
`

/** Node supplies a real background thread; this adapter only translates browser Worker events. */
class BrowserWorker {
  static launched: BrowserWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly exited: Promise<number>
  readonly errors: unknown[] = []
  private readonly thread: NodeWorker

  constructor(url: URL, _options?: WorkerOptions, beforeImport = '') {
    // Vite rewrites worker URLs to its HTTP origin even in the Node test runner.
    const sourceUrl = url.protocol === 'file:' ? url : pathToFileURL(resolve(process.cwd(), `.${url.pathname}`))
    this.thread = new NodeWorker(`
      const { parentPort } = require('node:worker_threads');
      const { register } = require('node:module');
      register(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(loaderSource).toString('base64')}`)});
      globalThis.postMessage = message => parentPort.postMessage(message);
      ${beforeImport}
      import(${JSON.stringify(sourceUrl.href)}).then(() => {
        parentPort.on('message', data => globalThis.onmessage({ data }));
      });
    `, { eval: true })
    this.thread.on('message', data => this.onmessage?.({ data } as MessageEvent))
    this.thread.on('error', error => {
      this.errors.push(error)
      this.onerror?.({ error, preventDefault() {} } as ErrorEvent)
    })
    this.thread.on('messageerror', () => this.onmessageerror?.())
    this.exited = new Promise(resolve => this.thread.once('exit', resolve))
    BrowserWorker.launched.push(this)
  }

  postMessage(message: unknown, transfer: ArrayBuffer[]) { this.thread.postMessage(message, transfer) }
  terminate() { void this.thread.terminate() }
}

function bufferOf(sampleRate = 44100, seconds = 0.5) {
  const data = new Float32Array(Math.round(sampleRate * seconds))
  for (let i = 0; i < data.length; i++) {
    const phase = 2 * Math.PI * 523.25113 * i / sampleRate
    data[i] = 0.4 * Math.sin(phase) + 0.12 * Math.sin(phase * 2)
  }
  return { sampleRate, getChannelData: () => data }
}

afterEach(async () => {
  for (const worker of BrowserWorker.launched) worker.terminate()
  await Promise.all(BrowserWorker.launched.map(worker => worker.exited))
  BrowserWorker.launched = []
  vi.unstubAllGlobals()
})

describe('background pitch analysis lifecycle', () => {
  it.each([16000, 44100, 48000])('uses the real worker at %i Hz, preserves audio, and releases the thread', async sampleRate => {
    vi.stubGlobal('Worker', BrowserWorker)
    const buffer = bufferOf(sampleRate)
    const options = { frameSec: 0.04, hopSec: 0.01, offsetSec: 3.25, clarityMin: 0.8 }
    const progress: number[] = []
    const result = await extractPitchTrackAsync(buffer, {
      ...options, onProgress: fraction => progress.push(fraction),
    })
    expect(BrowserWorker.launched[0].errors).toEqual([])
    expect(result).toEqual(extractPitchTrack(buffer, options))
    expect(result).toHaveLength(47)
    expect(result![0].time).toBe(3.25)
    expect(result!.every(point => Math.abs(1200 * Math.log2(point.hz / 523.25113)) < 3)).toBe(true)
    expect(buffer.getChannelData().length).toBe(sampleRate / 2)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(1)
    expect(progress.some(fraction => fraction > 0 && fraction < 1)).toBe(true)
    expect(await BrowserWorker.launched[0].exited).toBeTypeOf('number')
  })

  it('aborts ongoing worker analysis and suppresses late progress/results', async () => {
    vi.stubGlobal('Worker', BrowserWorker)
    const controller = new AbortController()
    const progress: number[] = []
    const result = await extractPitchTrackAsync(bufferOf(44100, 3), {
      signal: controller.signal,
      onProgress: fraction => {
        progress.push(fraction)
        if (fraction > 0) controller.abort()
      },
    })
    expect(result).toBeNull()
    expect(progress.at(-1)).toBeLessThan(1)
    const progressCount = progress.length
    expect(await BrowserWorker.launched[0].exited).toBeTypeOf('number')
    expect(progress).toHaveLength(progressCount)
  })

  it('still cancels through the legacy shouldContinue callback', async () => {
    vi.stubGlobal('Worker', BrowserWorker)
    let active = true
    expect(await extractPitchTrackAsync(bufferOf(), {
      shouldContinue: () => active,
      onProgress: fraction => { if (fraction > 0) active = false },
    })).toBeNull()
    expect(await BrowserWorker.launched[0].exited).toBeTypeOf('number')
  })

  it('falls back when constructing a worker is blocked', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('Worker is blocked') } })
    const buffer = bufferOf()
    expect(await extractPitchTrackAsync(buffer)).toEqual(extractPitchTrack(buffer))
  })

  it('releases a failed worker and finishes through fallback without reversing progress', async () => {
    vi.stubGlobal('Worker', class extends BrowserWorker {
      constructor(url: URL) {
        super(url, undefined, "parentPort.postMessage({ type: 'progress', fraction: 0.75 }); throw new Error('Worker load failed');")
      }
    })
    const buffer = bufferOf()
    const progress: number[] = []
    expect(await extractPitchTrackAsync(buffer, {
      sliceMs: 0,
      onProgress: fraction => progress.push(fraction),
    })).toEqual(extractPitchTrack(buffer))
    expect(progress.every((fraction, i) => !i || fraction >= progress[i - 1])).toBe(true)
    expect(progress.at(-1)).toBe(1)
    expect(await BrowserWorker.launched[0].exited).toBeTypeOf('number')
  })
})
