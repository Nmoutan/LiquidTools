'use strict'

/**
 * 内置工具：视频转码 / 压缩 / 网络优化
 *
 * 关键能力 faststart：
 * MP4 的 moov（索引）默认写在文件尾部，播放器必须下载完整文件才能开始播放。
 * 加 -movflags +faststart 会把 moov 挪到头部，实现边下边播。
 * 「仅优化播放」走 -c copy，不重新编码，几秒钟完成、画质零损失。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v', '.ts', '.mts']

let ffmpegPath = null
function getFfmpeg() {
  if (ffmpegPath) return ffmpegPath
  try {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
  } catch {
    ffmpegPath = 'ffmpeg'
  }
  return ffmpegPath
}

function isVideoFile(p) {
  return VIDEO_EXTS.includes(path.extname(p).toLowerCase())
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

function fmtDuration(sec) {
  if (!sec || sec < 0) return '--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 读时长：ffmpeg 没有 ffprobe，靠 -i 的输出解析 Duration */
function probeDuration(file) {
  return new Promise((resolve) => {
    let err = ''
    const p = spawn(getFfmpeg(), ['-hide_banner', '-i', file], { windowsHide: true })
    p.stderr.on('data', (d) => {
      err += d.toString()
    })
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (!m) return resolve(0)
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
    })
    p.on('error', () => resolve(0))
  })
}

function buildArgs(src, out, opts, target) {
  const args = ['-hide_banner', '-y', '-i', src]

  // 只做网络优化：直接复制码流，只重写 moov 位置
  if (opts.faststartOnly) {
    if (target === 'mp4' || target === 'mov') {
      args.push('-c', 'copy', '-movflags', '+faststart', out)
      return args
    }
    // 非 mp4 容器无法 copy 到 mp4 时，退回轻量重编码
  }

  if (target === 'gif') {
    args.push(
      '-vf',
      'fps=12,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=sierra2_4a',
      '-loop',
      '0',
      out
    )
    return args
  }

  const crf = Math.max(14, Math.min(40, Math.round(opts.quality)))
  const scale = opts.resolution && opts.resolution !== 'keep' ? `scale=-2:${opts.resolution}` : null
  if (scale) args.push('-vf', scale)

  if (target === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1')
    args.push('-c:a', 'libopus', '-b:a', '96k')
  } else {
    args.push('-c:v', 'libx264', '-crf', String(crf), '-preset', 'medium', '-pix_fmt', 'yuv420p')
    args.push('-c:a', 'aac', '-b:a', '128k')
  }

  args.push('-movflags', '+faststart')
  args.push('-progress', 'pipe:1', '-nostats')
  args.push(out)
  return args
}

function runFfmpeg(args, duration, ctx) {
  return new Promise((resolve, reject) => {
    const p = spawn(getFfmpeg(), args, { windowsHide: true })
    let errBuf = ''
    let progressBuf = ''

    p.stderr.on('data', (d) => {
      errBuf += d.toString()
      if (errBuf.length > 8000) errBuf = errBuf.slice(-4000)
    })

    p.stdout.on('data', (d) => {
      progressBuf += d.toString()
      const lines = progressBuf.split('\n')
      progressBuf = lines.pop() || ''
      for (const line of lines) {
        const [k, v] = line.split('=')
        if (k === 'out_time_us' && duration > 0) {
          const sec = Number(v) / 1e6
          if (Number.isFinite(sec)) {
            ctx.progress(Math.min(0.99, sec / duration), `已处理 ${fmtDuration(sec)}`)
          }
        }
      }
    })

    p.on('error', (e) => reject(new Error(`无法启动 ffmpeg：${e.message}`)))
    p.on('close', (code) => {
      if (code === 0) resolve()
      else {
        const tail = errBuf.split('\n').filter(Boolean).slice(-3).join(' ')
        reject(new Error(tail || `ffmpeg 退出码 ${code}`))
      }
    })

    // 支持中途取消
    ctx.onCancel(() => {
      try {
        p.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    })
  })
}

async function processOne(src, opts, ctx) {
  const stat = await fs.promises.stat(src)
  const ext = path.extname(src).toLowerCase()

  let target
  if (opts.faststartOnly) {
    target = ext === '.mp4' || ext === '.mov' ? ext.replace('.', '') : 'mp4'
  } else if (!opts.format || opts.format === 'keep') {
    if (ext === '.webm') target = 'webm'
    else if (ext === '.gif') target = 'gif'
    else target = 'mp4'
  } else {
    target = opts.format
  }

  const dir = opts.outputDir || path.dirname(src)
  const base = path.basename(src, path.extname(src))
  const suffix = opts.faststartOnly ? '_web' : '_min'
  const out = uniquePath(path.join(dir, `${base}${suffix}.${target}`))

  const duration = opts.faststartOnly ? 0 : await probeDuration(src)
  const args = buildArgs(src, out, opts, target)

  await runFfmpeg(args, duration, ctx)

  if (!fs.existsSync(out)) throw new Error('未生成输出文件')
  const after = (await fs.promises.stat(out)).size

  const savedPct = stat.size > 0 ? Math.round((1 - after / stat.size) * 100) : 0
  return {
    src,
    out,
    before: stat.size,
    after,
    note: opts.faststartOnly
      ? `${formatBytes(after)} · 已优化为边下边播`
      : `${formatBytes(stat.size)} → ${formatBytes(after)}（省 ${savedPct}%）`
  }
}

module.exports = {
  id: 'video',
  name: '视频处理',
  hint: '转码 / 压缩 / 网络优化',
  icon: 'video',
  order: 30,

  match(payload) {
    if (payload.kind === 'files') {
      return payload.paths.length > 0 && payload.paths.every(isVideoFile)
    }
    return false
  },

  options: [
    {
      key: 'faststartOnly',
      type: 'toggle',
      label: '仅优化网络播放',
      hint: '不重新编码，几秒完成，画质无损',
      default: false
    },
    {
      key: 'format',
      type: 'segmented',
      label: '输出格式',
      default: 'keep',
      choices: [
        { value: 'keep', label: 'MP4' },
        { value: 'webm', label: 'WebM' },
        { value: 'gif', label: 'GIF' }
      ]
    },
    {
      key: 'quality',
      type: 'slider',
      label: '质量（CRF 越小越清晰）',
      min: 16,
      max: 34,
      step: 1,
      default: 24,
      inverse: true
    },
    {
      key: 'resolution',
      type: 'segmented',
      label: '分辨率',
      default: 'keep',
      choices: [
        { value: 'keep', label: '原始' },
        { value: '1080', label: '1080p' },
        { value: '720', label: '720p' },
        { value: '480', label: '480p' }
      ]
    }
  ],

  defaultOptions: {
    faststartOnly: false,
    format: 'keep',
    quality: 24,
    resolution: 'keep'
  },

  async run(payload, ctx) {
    const opts = {
      ...this.defaultOptions,
      ...(ctx.options || {}),
      // 用户在岛上指定过产物目录时，视频也写那里；否则留在源文件旁边
      outputDir: payload.outputDir || null
    }
    const paths = payload.files ? payload.files.map((f) => f.path) : payload.paths
    const results = []

    for (let i = 0; i < paths.length; i += 1) {
      if (ctx.isCancelled()) break
      const p = paths[i]
      const baseProgress = i / paths.length
      const slice = 1 / paths.length

      ctx.progress(baseProgress, path.basename(p))

      try {
        const r = await processOne(p, opts, {
          ...ctx,
          progress: (ratio, msg) => ctx.progress(baseProgress + ratio * slice, msg)
        })
        results.push(r)
      } catch (err) {
        results.push({ src: p, error: err.message })
      }
      ctx.progress((i + 1) / paths.length, path.basename(p))
    }

    const ok = results.filter((r) => r.out)
    return {
      summary:
        ok.length > 0
          ? opts.faststartOnly
            ? `${ok.length} 个视频已优化为边下边播`
            : `${ok.length} 个视频完成`
          : '没有处理成功的视频',
      items: results.map((r) => ({
        name: path.basename(r.src),
        note: r.error ? r.error : r.note,
        ok: Boolean(r.out),
        out: r.out
      }))
    }
  }
}
