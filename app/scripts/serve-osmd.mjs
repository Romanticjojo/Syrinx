// Static server for osmd render test, stays up briefly
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = 'D:/Syrinx/resources/luv-letter/score/omr-work'
const OSMD_JS = 'D:/Syrinx/app/node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js'
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.xml': 'application/xml' }
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/render.html'
  if (p === '/osmd.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(readFileSync(OSMD_JS))
    return
  }
  const file = join(ROOT, p)
  if (existsSync(file)) {
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  } else { res.writeHead(404); res.end('nope') }
})
server.listen(8791, () => console.log('up'))
setTimeout(() => process.exit(0), 120000)
