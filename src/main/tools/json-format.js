'use strict'

/**
 * 内置工具：JSON 格式化
 *
 * P0 阶段只做文件级美化 / 压缩，验证注册表的扩展性。
 * 后续会升级成带编辑器的独立窗口（输入框需要焦点，不能放在 focusable:false 的岛上）。
 */

const fs = require('fs')
const path = require('path')

function isJsonFile(p) {
  return path.extname(p).toLowerCase() === '.json'
}

function byteSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

module.exports = {
  id: 'json-format',
  name: 'JSON 工具',
  hint: '查看 · 格式化 · 格式互转',
  icon: 'braces',
  order: 20,
  // 需要键盘输入，必须开独立窗口（岛是 focusable:false，收不到输入）
  ui: 'json-editor',

  match(payload) {
    if (payload.kind === 'files') {
      return payload.paths.length > 0 && payload.paths.every(isJsonFile)
    }
    return payload.kind === 'text' && typeof payload.text === 'string'
  },

  defaultOptions: { indent: 2, minify: false },

  async run(payload, ctx) {
    const opts = { ...this.defaultOptions, ...(ctx.options || {}) }

    // 纯文本：直接返回处理结果，不落盘
    if (payload.kind === 'text') {
      const parsed = JSON.parse(payload.text)
      const text = opts.minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, opts.indent)
      return { summary: `已解析 · 输出 ${byteSize(Buffer.byteLength(text))}`, text, items: [] }
    }

    const paths = payload.files ? payload.files.map((f) => f.path) : payload.paths
    const items = []

    for (let i = 0; i < paths.length; i += 1) {
      if (ctx.isCancelled()) break
      const src = paths[i]
      ctx.progress(i / paths.length, path.basename(src))
      try {
        const raw = await fs.promises.readFile(src, 'utf8')
        const parsed = JSON.parse(raw)
        const text = opts.minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, opts.indent)

        const dir = path.dirname(src)
        const base = path.basename(src, '.json')
        const out = path.join(dir, `${base}_fmt.json`)
        await fs.promises.writeFile(out, text, 'utf8')

        items.push({
          name: path.basename(src),
          note: `${byteSize(Buffer.byteLength(raw))} → ${byteSize(Buffer.byteLength(text))}`,
          ok: true,
          out
        })
      } catch (err) {
        items.push({ name: path.basename(src), note: `解析失败：${err.message}`, ok: false })
      }
      ctx.progress((i + 1) / paths.length, path.basename(src))
    }

    const okCount = items.filter((i) => i.ok).length
    return {
      summary: okCount > 0 ? `${okCount} 个文件已格式化` : '没有成功处理的文件',
      items
    }
  }
}
