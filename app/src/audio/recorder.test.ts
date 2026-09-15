import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  buildRecordingWav: vi.fn((chunks: Float32Array[]) => ({
    blob: new Blob([chunks.map((chunk) => chunk[0]).join(',')]),
    silent: false,
  })),
}))

vi.mock('./pcm', () => ({ buildRecordingWav: mocked.buildRecordingWav }))

interface PortMessage { type?: string; on?: boolean; id: number; pcm?: Float32Array }

class FakePort {
  onmessage: ((event: MessageEvent<PortMessage>) => void) | null = null
  sent: PortMessage[] = []
  acknowledged = new Set<PortMessage>()
  postMessage(message: PortMessage) { this.sent.push(message) }
  close = vi.fn()
  ack(message: PortMessage) {
    this.acknowledged.add(message)
    this.onmessage?.({ data: { type: 'gate-ack', on: message.on, id: message.id } } as MessageEvent<PortMessage>)
  }
  chunk(id: number, value: number) {
    this.onmessage?.({ data: { id, pcm: new Float32Array([value]) } } as MessageEvent<PortMessage>)
  }
}

class FakeWorkletNode {
  static current: FakeWorkletNode
  port = new FakePort()
  disconnect = vi.fn()
  constructor() { FakeWorkletNode.current = this }
}

function context() {
  const track = { stop: vi.fn() }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  return {
    track,
    ctx: {
      sampleRate: 48_000,
      destination: {},
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => ({ fftSize: 0, getFloatTimeDomainData: vi.fn() })),
    } as unknown as AudioContext,
    stream: { getTracks: () => [track] },
  }
}

async function acknowledgeLatest() {
  const port = FakeWorkletNode.current.port
  let message: PortMessage | undefined
  for (let attempt = 0; attempt < 8 && !message; attempt += 1) {
    await Promise.resolve()
    message = port.sent.find((item) => !port.acknowledged.has(item))
  }
  if (!message) throw new Error('没有待确认的 gate 消息')
  port.ack(message)
  await Promise.resolve()
}

beforeEach(() => {
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:segment')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocked.buildRecordingWav.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

describe('分段麦克风采集', () => {
  it('封段等待 worklet gate/flush 确认，保留最终分片且不关闭麦克风', async () => {
    const fixture = context()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => fixture.stream) } })
    const { openMic } = await import('./recorder')
    const mic = await openMic(fixture.ctx)

    const starting = mic.restartCapture()
    await acknowledgeLatest()
    await starting
    const startGate = FakeWorkletNode.current.port.sent.at(-1)!
    FakeWorkletNode.current.port.chunk(startGate.id, 1)

    const sealing = mic.finishCapture()
    await Promise.resolve()
    FakeWorkletNode.current.port.chunk(startGate.id, 2)
    expect(fixture.track.stop).not.toHaveBeenCalled()
    await acknowledgeLatest()
    const result = await sealing

    expect(await result?.blob.text()).toBe('1,2')
    expect(fixture.track.stop).not.toHaveBeenCalled()
  })

  it('段编号单调递增，上一段迟到分片不会泄漏到新段；结束才释放音轨', async () => {
    const fixture = context()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => fixture.stream) } })
    const { openMic } = await import('./recorder')
    const mic = await openMic(fixture.ctx)

    const firstStart = mic.restartCapture(); await acknowledgeLatest(); await firstStart
    const firstId = FakeWorkletNode.current.port.sent.at(-1)!.id
    const firstSeal = mic.finishCapture(); await acknowledgeLatest(); await firstSeal
    const secondStart = mic.restartCapture(); await acknowledgeLatest(); await secondStart
    const secondId = FakeWorkletNode.current.port.sent.at(-1)!.id
    expect(secondId).toBeGreaterThan(firstId)
    FakeWorkletNode.current.port.chunk(firstId, 9)
    FakeWorkletNode.current.port.chunk(secondId, 3)
    const secondSeal = mic.finishCapture(); await acknowledgeLatest()
    expect(await (await secondSeal)?.blob.text()).toBe('3')

    expect(await mic.stop()).toBeNull()
    expect(fixture.track.stop).toHaveBeenCalledOnce()
  })

  it('封段确认到达前请求新段，不会提前清空旧段或改写旧段编号', async () => {
    const fixture = context()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => fixture.stream) } })
    const { openMic } = await import('./recorder')
    const mic = await openMic(fixture.ctx)
    const starting = mic.restartCapture(); await acknowledgeLatest(); await starting
    const port = FakeWorkletNode.current.port
    const firstId = port.sent.at(-1)!.id
    port.chunk(firstId, 1)

    const sealing = mic.finishCapture()
    const restarting = mic.restartCapture()
    await Promise.resolve()
    port.chunk(firstId, 2)
    port.ack(port.sent.at(-1)!)
    expect(await sealing.then((result) => result?.blob.text())).toBe('1,2')
    await acknowledgeLatest()
    await restarting
    await mic.release()
  })

  it('worklet 不确认关门时限时失败，stop 仍在 finally 释放音轨', async () => {
    vi.useFakeTimers()
    const fixture = context()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => fixture.stream) } })
    const { openMic } = await import('./recorder')
    const mic = await openMic(fixture.ctx)
    const starting = mic.restartCapture()
    await acknowledgeLatest()
    await starting

    const stopping = mic.stop()
    const rejected = expect(stopping).rejects.toThrow(/确认|超时/)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(3_000)
    await rejected
    expect(fixture.track.stop).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('AudioWorklet 不可用时 ScriptProcessor fallback 仍可逐段封存', async () => {
    const fixture = context()
    const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as ((event: unknown) => void) | null }
    const mute = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
    Object.assign(fixture.ctx, {
      audioWorklet: { addModule: vi.fn(async () => { throw new Error('unsupported') }) },
      createScriptProcessor: vi.fn(() => processor),
      createGain: vi.fn(() => mute),
    })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => fixture.stream) } })
    const { openMic } = await import('./recorder')
    const mic = await openMic(fixture.ctx)

    await mic.restartCapture()
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array([7]) } })
    const result = await mic.finishCapture()

    expect(await result?.blob.text()).toBe('7')
    expect(fixture.track.stop).not.toHaveBeenCalled()
    await mic.stop()
    expect(fixture.track.stop).toHaveBeenCalledOnce()
  })
})
