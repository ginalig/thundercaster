import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 8787)
const strikesUrl = new URL('https://maps.blitzortung.org/en/GEOjson/strikes_00.json')
const strikeCacheMs = 5000
let strikeCache = {
    fetchedAt: 0,
    data: null,
}

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

const sendJson = (res, statusCode, payload) => {
    const text = JSON.stringify(payload)
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    })
    res.end(text)
}

const parseStrikeTimestamp = (value) => {
    if (typeof value !== 'string') {
        return 0
    }

    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/)
    if (!match) {
        const parsed = Date.parse(value)
        return Number.isNaN(parsed) ? 0 : parsed
    }

    const [, year, month, day, hour, minute, second, fraction = ''] = match
    const millisecond = Number(fraction.slice(0, 3).padEnd(3, '0'))
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millisecond)
}

const fetchUpstreamStrikes = () => new Promise((resolve, reject) => {
    const now = Date.now()
    if (strikeCache.data && now - strikeCache.fetchedAt < strikeCacheMs) {
        resolve(strikeCache.data)
        return
    }

    const upstream = request(strikesUrl, {
        headers: {
            'User-Agent': 'thundercaster4-local-proxy',
            Accept: 'application/json',
        },
    }, (upstreamRes) => {
        if (!upstreamRes.statusCode || upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
            upstreamRes.resume()
            reject(new Error(`Upstream returned ${upstreamRes.statusCode || 'no status'}`))
            return
        }

        let body = ''
        upstreamRes.setEncoding('utf8')
        upstreamRes.on('data', (chunk) => {
            body += chunk
        })
        upstreamRes.on('end', () => {
            try {
                const data = JSON.parse(body)
                if (!Array.isArray(data)) {
                    reject(new Error('Upstream returned non-array JSON'))
                    return
                }

                strikeCache = {
                    fetchedAt: Date.now(),
                    data,
                }
                resolve(data)
            } catch (error) {
                reject(new Error(`Could not parse strikes JSON: ${error.message}`))
            }
        })
    })

    upstream.on('error', (error) => {
        reject(error)
    })

    upstream.end()
})

const proxyStrikes = async (res, sinceValue, limitValue) => {
    const since = Math.max(0, Number(sinceValue) || 0)
    const limit = Math.max(0, Math.floor(Number(limitValue) || 0))

    try {
        const data = await fetchUpstreamStrikes()
        const latestTimestamp = data.reduce((latest, row) => {
            const timestamp = Array.isArray(row) ? parseStrikeTimestamp(row[2]) : 0
            return Math.max(latest, timestamp)
        }, 0)
        const strikes = since > 0
            ? data.filter((row) => Array.isArray(row) && parseStrikeTimestamp(row[2]) > since)
            : data
        const limitedStrikes = limit > 0
            ? strikes.slice(-limit)
            : strikes

        sendJson(res, 200, {
            strikes: limitedStrikes,
            total: data.length,
            matched: strikes.length,
            returned: limitedStrikes.length,
            since,
            limit,
            latestTimestamp,
            filtered: since > 0,
        })
    } catch (error) {
        sendText(res, 502, `Could not fetch strikes: ${error.message}`)
    }
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
        proxyStrikes(res, url.searchParams.get('since'), url.searchParams.get('limit'))
        return
    }

    serveStatic(req, res, url.pathname)
})

server.listen(port, '127.0.0.1', () => {
    console.log(`Thundercaster app: http://127.0.0.1:${port}/`)
})
