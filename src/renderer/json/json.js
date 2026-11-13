'use strict'

const api = window.jsonApi
const { toYaml, toCsv, toXml } = window.converters

const inputEl = document.getElementById('input')
const hlEl = document.getElementById('hl')
const outEl = document.getElementById('out')
const statusEl = document.getElementById('status')
const inMeta = document.getElementById('inMeta')
const outMeta = document.getElementById('outMeta')
const fileNameEl = document.getElementById('fileName')

let format = 'json'
let indent = '2'
let currentPath = null
let lastValid = null

// ---------- 语法高亮 ----------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightJson(text) {
  const escaped = escapeHtml(text)
  return escaped.replace(
    /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'tok-num'
      if (match.startsWith('"')) {
        cls = /:\s*$/.test(match) ? 'tok-key' : 'tok-str'
      } else if (/^(true|false|null)$/.test(match)) {
        cls = 'tok-lit'
      }
      return `<span class="${cls}">${match}</span>`
    }
  )
}

function syncHighlight() {
  hlEl.innerHTML = highlightJson(inputEl.value) + '\n'
}

function syncScroll() {
  hlEl.scrollTop = inputEl.scrollTop
  hlEl.scrollLeft = inputEl.scrollLeft
}

inputEl.addEventListener('scroll', syncScroll)

// ---------- 转换 ----------

function byteLen(s) {
  return new Blob([s]).size
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function setStatus(text, tone) {
  statusEl.textContent = text
  statusEl.dataset.tone = tone || ''
}

function buildOutput() {
  const raw = inputEl.value.trim()

  if (raw === '') {
    outEl.textContent = ''
    outMeta.textContent = ''
    inMeta.textContent = ''
    setStatus('就绪')
    return
  }

  inMeta.textContent = fmtBytes(byteLen(inputEl.value))

  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    outEl.innerHTML = ''
    outMeta.textContent = ''
    setStatus(`解析失败：${err.message}`, 'err')
    return
  }

  lastValid = data

  try {
    let text
    if (format === 'json') {
      text = indent === 'min' ? JSON.stringify(data) : JSON.stringify(data, null, Number(indent))
    } else if (format === 'yaml') {
      text = toYaml(data, 0)
    } else if (format === 'csv') {
      text = toCsv(data)
    } else {
      text = toXml(data)
    }

    outEl.textContent = text
    outMeta.textContent = fmtBytes(byteLen(text))
    const nodes = countNodes(data)
    setStatus(`解析成功 · ${nodes} 个节点 · 输出 ${format.toUpperCase()}`, 'ok')
  } catch (err) {
    outEl.textContent = ''
    outMeta.textContent = ''
    setStatus(err.message, 'err')
  }
}

function countNodes(v) {
  if (v === null || typeof v !== 'object') return 1
  if (Array.isArray(v)) return 1 + v.reduce((s, x) => s + countNodes(x), 0)
  return 1 + Object.keys(v).reduce((s, k) => s + countNodes(v[k]), 0)
}

let timer = null
function schedule() {
  syncHighlight()
  clearTimeout(timer)
  timer = setTimeout(buildOutput, 160)
}

inputEl.addEventListener('input', schedule)

// ---------- 工具栏 ----------

document.getElementById('fmtSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-fmt]')
  if (!btn) return
  format = btn.dataset.fmt
  for (const b of document.querySelectorAll('#fmtSeg button')) {
    b.dataset.on = b === btn ? '1' : '0'
  }
  buildOutput()
})

document.getElementById('indentSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-indent]')
  if (!btn) return
  indent = btn.dataset.indent
  for (const b of document.querySelectorAll('#indentSeg button')) {
    b.dataset.on = b === btn ? '1' : '0'
  }
  buildOutput()
})

document.getElementById('btnClear').addEventListener('click', () => {
  inputEl.value = ''
  currentPath = null
  fileNameEl.textContent = ''
  syncHighlight()
  buildOutput()
  inputEl.focus()
})

document.getElementById('btnCopy').addEventListener('click', async () => {
  const text = outEl.textContent || ''
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    setStatus('已复制到剪贴板', 'ok')
  } catch {
    setStatus('复制失败', 'err')
  }
})

document.getElementById('btnSave').addEventListener('click', async () => {
  const text = outEl.textContent || ''
  if (!text) {
    setStatus('没有可保存的内容', 'err')
    return
  }
  let target = currentPath
  if (!target) {
    target = await api.pickSavePath()
    if (!target) return
  }
  const res = await api.save(target, text)
  if (res.ok) {
    currentPath = target
    fileNameEl.textContent = target.split(/[\\/]/).pop()
    setStatus(`已保存到 ${target}`, 'ok')
  } else {
    setStatus(`保存失败：${res.error}`, 'err')
  }
})

document.getElementById('btnMin').addEventListener('click', () => api.minimize())
document.getElementById('btnClose').addEventListener('click', () => api.close())

// ---------- 从岛里带文件进来 ----------

async function loadFile(filePath) {
  const res = await api.read(filePath)
  if (!res.ok) {
    setStatus(`读取失败：${res.error}`, 'err')
    return
  }
  currentPath = filePath
  fileNameEl.textContent = res.name
  inputEl.value = res.text
  syncHighlight()
  buildOutput()
  inputEl.focus()
}

/** 剪贴板来源：没有磁盘文件，只能另存为 */
function loadText(text, name) {
  currentPath = null
  fileNameEl.textContent = name || '来自剪贴板'
  inputEl.value = text
  syncHighlight()
  buildOutput()
  inputEl.focus()
  setStatus('已从剪贴板导入 · 保存时需要选择位置')
}

api.onLoad((target) => {
  if (!target) return
  if (typeof target === 'string') loadFile(target)
  else if (target.text) loadText(target.text, target.name)
})

// 支持把 json 文件直接拖进这个窗口
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  const text = await file.text()
  currentPath = null
  fileNameEl.textContent = file.name
  inputEl.value = text
  syncHighlight()
  buildOutput()
})

// 支持粘贴时自动带上剪贴板内容（Ctrl+V 原生即可，这里只做首次聚焦）
window.addEventListener('focus', () => inputEl.focus())

inputEl.focus()
setStatus('粘贴 JSON 开始 · Ctrl+Enter 无操作')
