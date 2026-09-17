#!/usr/bin/env node
'use strict'
// Draws the Fleet mark straight into PNG files: a rounded tile in the terminal's
// background colour with the six-armed asterisk in its accent. No image library and
// no font, so `npm run icons` works offline. Run it after changing the Warp theme
// if you want the installed app icon to match.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { readTheme } = require('../theme.js')

const hex = value => {
  const h = value.replace('#', '')
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h.slice(0, 6)
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
// Coverage of a rounded rectangle, sampled as a signed distance for soft corners.
function tileAlpha(x, y, size, radius) {
  const half = size / 2, inner = half - radius
  const dx = Math.max(Math.abs(x - half) - inner, 0)
  const dy = Math.max(Math.abs(y - half) - inner, 0)
  return clamp(radius - Math.hypot(dx, dy) + 0.5, 0, 1)
}
// Distance from a point to a centred bar rotated by `angle`.
function barAlpha(x, y, size, angle, length, width) {
  const half = size / 2
  const px = x - half, py = y - half
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const along = Math.abs(px * cos + py * sin)
  const across = Math.abs(-px * sin + py * cos)
  if (along > length) return 0
  return clamp(width - across + 0.5, 0, 1)
}

function iconPixels(size, theme) {
  const bg = hex(theme.background), accent = hex(theme.accent)
  const data = Buffer.alloc(size * size * 4)
  const radius = size * 0.22, length = size * 0.30, width = size * 0.052
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const tile = tileAlpha(x + 0.5, y + 0.5, size, radius)
    let mark = 0
    for (const angle of [Math.PI / 2, Math.PI / 6, -Math.PI / 6]) {
      mark = Math.max(mark, barAlpha(x + 0.5, y + 0.5, size, angle, length, width))
    }
    const offset = (y * size + x) * 4
    for (let c = 0; c < 3; c++) data[offset + c] = Math.round(bg[c] * (1 - mark) + accent[c] * mark)
    data[offset + 3] = Math.round(tile * 255)
  }
  return data
}
function png(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length)
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload))
    return Buffer.concat([length, payload, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4)
  header[8] = 8; header[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const theme = readTheme()
const out = path.join(__dirname, '..', 'public', 'icons')
fs.mkdirSync(out, { recursive: true })
for (const size of [192, 512]) {
  const file = path.join(out, `fleet-${size}.png`)
  fs.writeFileSync(file, png(size, iconPixels(size, theme)))
  console.log(`  ${path.relative(process.cwd(), file)}  ${size}×${size}  from "${theme.name}"`)
}
