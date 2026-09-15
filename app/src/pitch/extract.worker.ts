import { PitchExtraction } from './extract'
import type { ExtractWorkerRequest, ExtractWorkerResponse } from './extractAsync'

const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<ExtractWorkerRequest>) => void
  postMessage: (message: ExtractWorkerResponse) => void
}

workerScope.onmessage = ({ data: { data, sampleRate, options } }) => {
  const extraction = new PitchExtraction(data, sampleRate, options)
  let nextProgress = 0.05
  while (!extraction.done) {
    extraction.advance()
    if (extraction.progress >= nextProgress && !extraction.done) {
      workerScope.postMessage({ type: 'progress', fraction: extraction.progress })
      nextProgress = extraction.progress + 0.05
    }
  }
  workerScope.postMessage({ type: 'complete', points: extraction.points })
}
