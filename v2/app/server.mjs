import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 8787)
const strikesUrl = new URL('https://maps.blitzortung.org/en/GEOjson/strikes_00.json')

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml; charset=utf-8',
}

const sendText = (res, statusCode, text, contentType = 'text/plain; charset=utf-8') => {
    res.writeHead(statusCode, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
    })
    res.end(text)
}

const proxyStrikes = (res) => {
    const upstream = request(strikesUrl, {
        headers: {
            'User-Agent': 'thundercaster4-local-proxy',
            Accept: 'application/json',
        },
    }, (upstreamRes) => {
        if (!upstreamRes.statusCode || upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
            sendText(res, 502, `Upstream returned ${upstreamRes.statusCode || 'no status'}`)
            upstreamRes.resume()
            return
        }

        res.writeHead(200, {
            'Content-Type': upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
        })
        upstreamRes.pipe(res)
    })

    upstream.on('error', (error) => {
        sendText(res, 502, `Could not fetch strikes: ${error.message}`)
    })

    upstream.end()
}

const staticPathFor = (pathname) => {
    const decoded = decodeURIComponent(pathname)
    const requested = decoded === '/' ? '/index.html' : decoded
    const normalized = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '')
    const filePath = join(root, normalized)

    if (!filePath.startsWith(root + sep) && filePath !== root) {
        return null
    }

    return filePath
}

const serveStatic = (req, res, pathname) => {
    const filePath = staticPathFor(pathname)
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
        sendText(res, 404, 'Not found')
        return
    }

    res.writeHead(200, {
        'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
    })
    createReadStream(filePath).pipe(res)
}

const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (url.pathname === '/strikes-proxy') {
        proxyStrikes(res)
        return
    }

    serveStatic(req, res, url.pathname)
})

server.listen(port, '127.0.0.1', () => {
    console.log(`Thundercaster app: http://127.0.0.1:${port}/`)
})
