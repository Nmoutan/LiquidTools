'use strict'

/**
 * 内置工具：压缩图片
 *
 * 参数由工具自己声明（options），UI 通用渲染，不写死任何控件。
 * 格式支持「保持原格式」和显式转换到 png / jpg / webp。
 */

const fs = require('fs')
const path = require('path')

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.tiff']

let sharp = null
function getSharp() {
  // 走 image-engine：它关掉了 libvips 的文件缓存，
  // 否则读过的图片会被本进程映射住，用户删不掉（Windows 上删文件报占用）
  if (!sharp) sharp = require('../image-engine')
  return sharp
}

function isImageFile(p) {
  return IMAGE_EXTS.includes(path.extname(p).toLowerCase())
}

function uniquePath(target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  let i = 1
  let candidate = path.join(dir, `${base}-${i}${ext}`)
  while (fs.existsSync(candidate)) {
    i += 1
    candidate = path.join(dir, `${base}-${i}${ext}`)
  }
  return candidate
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 规范化目标格式，返回扩展名（不含点） */
function resolveFormat(srcExt, wanted) {
  if (!wanted || wanted === 'keep') {
    const e = srcExt.replace('.', '')
    if (e === 'jpeg') return 'jpg'
    if (e === 'tiff') return 'png'
    return e
  }
  return wanted
}

/**
 * 把「源文件 + 参数」翻译成一条 sharp 管线。
 *
 * 真正压缩（compressOne）和仅估算大小（estimate）必须共用这一段，
 * 否则界面上预估的数字和最后产出的文件会对不上。
 *
 * preview=true 时 png 的 effort 会调低：effort 8 在大图上要好几秒，
 * 而它对体积的影响通常在 2% 以内，预估值不需要那么精确。
 */
async function prepare(src, opts, preview = false) {
  const s = getSharp()
  const stat = await fs.promises.stat(src)
  const srcExt = path.extname(src).toLowerCase()
  const meta = await s(src, { failOn: 'none' }).metadata()

  const target = resolveFormat(srcExt, opts.format)
  const quality = Math.max(1, Math.min(100, Math.round(opts.quality)))
  const formatChanged = `.${target}` !== srcExt

  let pipeline = s(src, { failOn: 'none' })

  // 转 JPG 时透明通道需要先铺白底，否则透明区域会变黑
  const needsFlatten =
    target === 'jpg' && (meta.hasAlpha || srcExt === '.png' || srcExt === '.webp' || srcExt === '.avif')
  if (needsFlatten) {
    pipeline = pipeline.flatten({ background: '#ffffff' })
  }

  if (target === 'jpg') {
    pipeline = pipeline.jpeg({
      quality,
      mozjpeg: true,
      progressive: true,
      chromaSubsampling: '4:2:0'
    })
  } else if (target === 'png') {
    pipeline = pipeline.png({
      compressionLevel: 9,
      palette: quality < 95,
      quality,
      effort: preview ? 3 : 8
    })
  } else if (target === 'webp') {
    pipeline = pipeline.webp({ quality, effort: 5, smartSubsample: true })
  } else if (target === 'avif') {
    pipeline = pipeline.avif({ quality: Math.max(28, quality - 18), effort: 4 })
  } else {
    return { unsupported: target, before: stat.size, srcExt, meta }
  }

  return { pipeline, target, srcExt, meta, before: stat.size, formatChanged }
}

async function compressOne(src, opts) {
  const prep = await prepare(src, opts)
  const { target, srcExt, meta, before, formatChanged } = prep

  if (prep.unsupported) {
    return { src, out: null, before, after: before, skipped: `不支持输出 ${prep.unsupported}` }
  }

  const dir = opts.outputDir || path.dirname(src)
  const base = path.basename(src, path.extname(src))
  const outPath = uniquePath(path.join(dir, `${base}_min.${target}`))

  await prep.pipeline.toFile(outPath)
  const after = (await fs.promises.stat(outPath)).size

  // 同格式且没变小 → 没意义，删掉；跨格式转换即使变大也保留
  if (!formatChanged && after >= before) {
    await fs.promises.unlink(outPath).catch(() => {})
    return { src, out: null, before, after: before, skipped: '已是最优' }
  }

  return {
    src,
    out: outPath,
    before,
    after,
    width: meta.width,
    height: meta.height,
    converted: formatChanged ? `${srcExt.replace('.', '')} → ${target}` : ''
  }
}

// ---------------- 预估（只编码，不落盘） ----------------

// 每次估算递增，用来丢弃已经过期的请求：
// 用户连续拖滑块时会产生多个估算，只让最后一个的结果回到界面。
let estimateToken = 0

// 一次估算最多编码这么多张，再多就按平均值外推，避免等太久
const ESTIMATE_SAMPLE = 6

async function estimate(payload, options) {
  const paths = payload.files ? payload.files.map((f) => f.path) : payload.paths || []
  if (!paths.length) return { ok: false }

  const opts = { ...module.exports.defaultOptions, ...(options || {}) }
  const token = (estimateToken += 1)
  const sample = paths.slice(0, ESTIMATE_SAMPLE)

  let before = 0
  let after = 0
  let alreadyOptimal = 0
  let failed = 0

  for (const p of sample) {
    if (token !== estimateToken) return null
    try {
      const prep = await prepare(p, opts, true)
      if (prep.unsupported) {
        failed += 1
        continue
      }
      const buf = await prep.pipeline.toBuffer()
      before += prep.before
      // 同格式压不动时 run() 会直接保留原文件，预览也不能显示成“变大”
      if (!prep.formatChanged && buf.length >= prep.before) {
        after += prep.before
        alreadyOptimal += 1
      } else {
        after += buf.length
      }
    } catch {
      failed += 1
    }
  }

  if (token !== estimateToken) return null
  if (before === 0) return { ok: false, error: '无法读取这张图' }

  const scale = paths.length / sample.length
  return {
    ok: true,
    before: Math.round(before * scale),
    after: Math.round(after * scale),
    count: paths.length,
    exact: paths.length <= ESTIMATE_SAMPLE,
    alreadyOptimal,
    failed
  }
}

module.exports = {
  id: 'image-compress',
  name: '图片压缩',
  hint: '可转格式，可调质量',
  icon: 'image',
  order: 10,

  match(payload) {
    if (payload.kind === 'files') {
      return payload.paths.length > 0 && payload.paths.every(isImageFile)
    }
    return false
  },

  options: [
    {
      key: 'format',
      type: 'segmented',
      label: '格式',
      default: 'keep',
      choices: [
        { value: 'keep', label: '原格式' },
        { value: 'webp', label: 'WebP' },
        { value: 'jpg', label: 'JPG' },
        { value: 'png', label: 'PNG' }
      ]
    },
    {
      key: 'quality',
      type: 'slider',
      label: '质量',
      min: 1,
      max: 100,
      step: 1,
      default: 82
    }
  ],

  defaultOptions: { format: 'keep', quality: 82 },

  // 界面在用户改格式 / 质量时调用，返回压缩后的预估字节数
  estimate,

  async run(payload, ctx) {
    const opts = {
      ...this.defaultOptions,
      ...(ctx.options || {}),
      // 剪贴板截图落在临时目录，产物要指到桌面这类真实位置
      outputDir: payload.outputDir || null
    }
    const paths = payload.files ? payload.files.map((f) => f.path) : payload.paths
    const results = []

    for (let i = 0; i < paths.length; i += 1) {
      if (ctx.isCancelled()) break
      const p = paths[i]
      ctx.progress(i / paths.length, path.basename(p))
      try {
        results.push(await compressOne(p, opts))
      } catch (err) {
        results.push({ src: p, error: err.message })
      }
      ctx.progress((i + 1) / paths.length, path.basename(p))
    }

    const ok = results.filter((r) => r.out)
    const totalBefore = ok.reduce((s, r) => s + r.before, 0)
    const totalAfter = ok.reduce((s, r) => s + r.after, 0)
    const savedPct = totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0

    return {
      summary:
        ok.length > 0
          ? `${ok.length} 张完成 · ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)}（省 ${savedPct}%）`
          : '没有可压缩的文件',
      items: results.map((r) => ({
        name: path.basename(r.src),
        note: r.error
          ? r.error
          : r.out
            ? `${formatBytes(r.before)} → ${formatBytes(r.after)}${r.converted ? ` · ${r.converted}` : ''}`
            : r.skipped || '跳过',
        ok: Boolean(r.out),
        out: r.out
      }))
    }
  }
}
