// Draws the plugin icon (an original, simple mark: an upward chevron, a
// climb, on a rounded square) as a 512 x 512 PNG with no
// dependency: pixels computed here, compressed with Node's zlib.
//   node scripts/icon.mjs <out.png> <background hex> <mark hex>
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const [out = '.claude-plugin/icon.png', bgHex = '3b3fb6', fgHex = 'ffffff'] = process.argv.slice(2)
const N = 512
const rgb = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
const bg = rgb(bgHex)
const fg = rgb(fgHex)

// Signed distance helpers (in pixels).
const roundedBox = (x, y, half, r) => {
  const qx = Math.abs(x) - half + r
  const qy = Math.abs(y) - half + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const segment = (x, y, ax, ay, bx, by) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - dx * t, py - dy * t)
}

const raw = Buffer.alloc((N * 4 + 1) * N)
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0
  for (let x = 0; x < N; x++) {
    const cx = x + 0.5 - N / 2
    const cy = y + 0.5 - N / 2
    const box = roundedBox(cx, cy, 240, 96)
    const alpha = Math.max(0, Math.min(1, 0.5 - box))
    // Two chevrons: a strong one and a lighter one below it.
    const w = 34
    const c1 = Math.min(segment(cx, cy, -120, 40, 0, -80), segment(cx, cy, 0, -80, 120, 40)) - w
    const c2 = Math.min(segment(cx, cy, -120, 140, 0, 20), segment(cx, cy, 0, 20, 120, 140)) - w
    const m1 = Math.max(0, Math.min(1, 0.5 - c1))
    const m2 = Math.max(0, Math.min(1, 0.5 - c2)) * 0.45
    const m = Math.max(m1, m2)
    const i = y * (N * 4 + 1) + 1 + x * 4
    for (let k = 0; k < 3; k++) raw[i + k] = Math.round(bg[k] * (1 - m) + fg[k] * m)
    raw[i + 3] = Math.round(alpha * 255)
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = buf => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0)
ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
writeFileSync(out, png)
console.log(`${out}: ${png.length} bytes`)
