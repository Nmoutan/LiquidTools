'use strict'

// 生成压缩测试素材：噪点图 compressibility 差，适合验证极限；渐变图适合验证画质
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const dir = path.join(__dirname, '..', 'test-assets')
fs.mkdirSync(dir, { recursive: true })

async function main() {
  const w = 1600
  const h = 1200

  const noise = Buffer.alloc(w * h * 3)
  for (let i = 0; i < noise.length; i += 1) noise[i] = (Math.random() * 255) | 0

  await sharp(noise, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(path.join(dir, 'noise.png'))

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a3a6b"/><stop offset="1" stop-color="#e8b04b"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="800" cy="600" r="420" fill="rgba(255,255,255,0.16)"/>
  </svg>`

  await sharp(Buffer.from(svg)).jpeg({ quality: 98 }).toFile(path.join(dir, 'gradient.jpg'))

  const doc = { title: 'demo', items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item-${i}`, tags: ['a', 'b'] })) }
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(doc))

  for (const f of fs.readdirSync(dir)) {
    const size = fs.statSync(path.join(dir, f)).size
    console.log(f, (size / 1024).toFixed(1) + ' KB')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
