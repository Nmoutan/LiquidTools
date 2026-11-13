'use strict'

// 不能写成 const api = window.api —— contextBridge 注入的 window.api 已在全局
// 环境记录中存在，const 同名声明会抛 SyntaxError 让整个脚本失效（且静默无提示）
const bridge = window.api

const island = document.getElementById('island')
const dropzone = document.getElementById('dropzone')
const setupEl = document.getElementById('setup')
const jobsEl = document.getElementById('jobs')
const labelEl = document.getElementById('label')
const dotEl = document.getElementById('dot')
const meterEl = document.getElementById('meter')
const hintEl = document.getElementById('hint')
const offerEl = document.getElementById('offer')
const offerTitle = document.getElementById('offerTitle')
const offerSub = document.getElementById('offerSub')
const jobsTools = document.getElementById('jobsTools')
const jobsCount = document.getElementById('jobsCount')
const btnCutAll = document.getElementById('btnCutAll')

/**
 * 岛的几何尺寸，必须与 styles.css 保持一致。
 * 关键：上报给主进程的可交互矩形用这里的「目标尺寸」，
 * 绝不能用 getBoundingClientRect()——那会在展开动画期间返回中间值，
 * 导致主进程的 inside 判断跟着抖动，进而反复切换鼠标穿透，
 * 表现为反复 hover 之后岛消失 / 抽搐。
 */
const GEO = {
  idle: { x: 134, y: 8, w: 152, h: 38 },
  expanded: { x: 32, y: 8, w: 356, h: 430 }
}

let expanded = false
let dropActive = false
/** 自动化截图时钉住展开态，避免光标不在岛上就自动收起 */
let pinned = false
let expandTimer = null
let collapseTimer = null
let pillResetTimer = null
let lockUntil = 0

let pending = null
const jobValues = {}

/** 当前面板里的「压缩后大小」节点，null 表示该工具没有预估能力 */
let estimateEl = null
let estimateTimer = null
/** 估算请求序号：只有最后一次的结果允许写回界面 */
let estimateSeq = 0
/** 参数组合 → 结果。来回切换格式/质量时不必重复编码同一张图 */
const estimateCache = new Map()

/** 剪贴板被动检测到的内容（还没落成 payload，用户点了才取） */
let clipboardOffer = null

const EXPAND_DELAY = 150
const COLLAPSE_DELAY = 700
const STATE_LOCK = 220

const jobsById = new Map()
const jobEls = new Map()

// ---------------- 状态机 ----------------

function syncState() {
  const next = expanded ? 'expanded' : dropActive ? 'drop' : 'idle'
  if (island.dataset.state !== next) island.dataset.state = next
  reportHitRect()
}

function scheduleExpand() {
  if (expanded) return
  if (Date.now() < lockUntil) return
  clearTimeout(collapseTimer)
  collapseTimer = null
  if (expandTimer) return
  expandTimer = setTimeout(() => {
    expandTimer = null
    expanded = true
    lockUntil = Date.now() + STATE_LOCK
    syncState()
  }, EXPAND_DELAY)
}

function scheduleCollapse() {
  if (!expanded) return
  if (pinned) return
  if (Date.now() < lockUntil) return
  clearTimeout(expandTimer)
  expandTimer = null
  clearTimeout(collapseTimer)
  collapseTimer = setTimeout(() => {
    collapseTimer = null
    expanded = false
    lockUntil = Date.now() + STATE_LOCK
    syncState()
  }, COLLAPSE_DELAY)
}

function collapseNow() {
  clearTimeout(expandTimer)
  clearTimeout(collapseTimer)
  expandTimer = null
  collapseTimer = null
  expanded = false
  lockUntil = Date.now() + STATE_LOCK
  syncState()
}

function expandNow() {
  clearTimeout(expandTimer)
  clearTimeout(collapseTimer)
  expandTimer = null
  collapseTimer = null
  expanded = true
  lockUntil = Date.now() + STATE_LOCK
  syncState()
}

// ---------------- 点击穿透 ----------------

let lastRectKey = ''

function reportHitRect() {
  const g = expanded ? GEO.expanded : GEO.idle
  const pad = expanded ? 4 : 16
  const rect = {
    x: Math.max(0, g.x - pad),
    y: Math.max(0, g.y - pad),
    w: g.w + pad * 2,
    h: g.h + pad * 2
  }
  const key = `${rect.x},${rect.y},${rect.w},${rect.h}`
  if (key === lastRectKey) return
  lastRectKey = key
  bridge.setHitRect([rect])
}

bridge.onPointerRegion(({ inside }) => {
  if (inside) scheduleExpand()
  else scheduleCollapse()
})

let lastProbeAt = 0

document.addEventListener('mousemove', (e) => {
  const r = island.getBoundingClientRect()

  // 液态玻璃高光跟随光标
  if (r.width > 0) {
    island.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`)
    island.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`)
  }

  const inside =
    e.clientX >= r.left - 16 &&
    e.clientX <= r.right + 16 &&
    e.clientY >= r.top - 16 &&
    e.clientY <= r.bottom + 16

  if (inside) {
    scheduleExpand()

    // 光标已经在窗口范围内 → 立刻让主进程收起穿透，别等它下一次轮询。
    // 穿透窗口带 forward:true，这些 mousemove 本来就是 Windows 转发过来的，
    // 所以「移入即响应」是事件驱动的，只有文件拖放才需要主进程兜底。
    const now = performance.now()
    if (now - lastProbeAt > 80) {
      lastProbeAt = now
      bridge.pointerProbe()
    }
  } else {
    scheduleCollapse()
  }
})

island.addEventListener('click', (e) => {
  if (e.target.closest('button, input, .seg, .toggle-row')) return
  if (expanded || dropActive) return
  // 收起态点一下：有剪贴板候选就直接取，否则单纯展开
  if (clipboardOffer) {
    takeClipboard()
    return
  }
  expandNow()
})

document.getElementById('btnCollapse').addEventListener('click', (e) => {
  e.stopPropagation()
  collapseNow()
})

document.getElementById('btnQuit').addEventListener('click', () => bridge.quit())

// 产物目录：左键打开，右键换成别的盘（剪贴板截图默认落在 图片\waterTool）
const outputBtn = document.getElementById('btnOutput')

function paintOutputTip(dir) {
  if (!dir) return
  outputBtn.title = `产物目录：${dir}\n左键打开 · 右键更换位置`
}

bridge.getOutputDir().then((res) => {
  if (res && res.dir) paintOutputTip(res.dir)
}).catch(() => {})

outputBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  bridge.openOutputDir()
})

outputBtn.addEventListener('contextmenu', async (e) => {
  e.preventDefault()
  e.stopPropagation()
  const res = await bridge.pickOutputDir()
  if (res && res.ok) {
    paintOutputTip(res.dir)
    // hint 空间很小，只报末级目录名，完整路径在按钮的 title 里
    const tail = res.dir.split(/[\\/]/).filter(Boolean).pop() || res.dir
    flashHint(`产物将保存到 ${tail}`)
  }
})

document.getElementById('btnClear').addEventListener('click', () => {
  for (const el of jobEls.values()) el.remove()
  jobEls.clear()
  jobsById.clear()
  bridge.clearFinished()
  refreshJobsTools()
  updatePill()
})

// ---------------- 产物批量操作 ----------------

/** 当前所有已完成任务的成功产物（去重后按加入顺序） */
function collectOutputs() {
  const outs = []
  for (const job of jobsById.values()) {
    if (job.status !== 'done') continue
    for (const it of job.items || []) {
      if (it.ok && it.out) outs.push(it.out)
    }
  }
  return Array.from(new Set(outs))
}

function refreshJobsTools() {
  const n = collectOutputs().length
  jobsTools.hidden = n === 0
  jobsCount.textContent = n > 0 ? `${n} 个产物` : ''
}

btnCutAll.addEventListener('click', async (e) => {
  e.stopPropagation()
  const outs = collectOutputs()
  if (outs.length === 0) return

  btnCutAll.dataset.state = 'busy'
  btnCutAll.textContent = '正在剪切…'
  const res = await bridge.cutPaths(outs)
  clearTimeout(btnCutAll._t)

  if (res && res.ok) {
    btnCutAll.dataset.state = 'done'
    btnCutAll.textContent = `已剪切 ${res.count} 个`
    flashHint('去目标文件夹 Ctrl+V 就移过去了')
  } else {
    btnCutAll.dataset.state = 'err'
    btnCutAll.textContent = '剪切失败'
    flashHint((res && res.reason) || '剪贴板被其他程序占用')
  }

  btnCutAll._t = setTimeout(() => {
    btnCutAll.dataset.state = ''
    btnCutAll.textContent = '剪切全部'
  }, 2600)
})

// ---------------- 拖放 ----------------

let dragDepth = 0

function setDropActive(v) {
  dropActive = v
  dropzone.dataset.active = v ? '1' : '0'
  if (v) {
    clearTimeout(collapseTimer)
    expanded = true
  }
  syncState()
}

window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth += 1
  if (dragDepth === 1) setDropActive(true)
})

window.addEventListener('dragleave', (e) => {
  e.preventDefault()
  dragDepth -= 1
  if (dragDepth <= 0) {
    dragDepth = 0
    setDropActive(false)
  }
})

window.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
})

window.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  setDropActive(false)

  const files = Array.from(e.dataTransfer?.files || [])
  const paths = files.map((f) => bridge.getPathForFile(f)).filter(Boolean)
  if (paths.length === 0) return
  await handlePaths(paths)
})

async function handlePaths(paths) {
  const res = await bridge.inspect(paths)
  if (!res.ok) {
    flashHint('读不到这些文件')
    return
  }
  if (!res.tools || res.tools.length === 0) {
    flashHint('没有能处理这些文件的工具')
    return
  }
  pending = res
  expandNow()
  renderSetup()
}

// ---------------- 剪贴板 ----------------

function renderOffer() {
  if (!clipboardOffer) {
    offerEl.hidden = true
    return
  }
  offerEl.hidden = false
  if (clipboardOffer.kind === 'image') {
    offerTitle.textContent = '剪贴板里有截图'
    offerSub.textContent = `${clipboardOffer.width}×${clipboardOffer.height} · 处理后可存到桌面`
  } else if (clipboardOffer.kind === 'files') {
    offerTitle.textContent =
      clipboardOffer.count === 1 ? '剪贴板里有文件' : `剪贴板里有 ${clipboardOffer.count} 个文件`
    offerSub.textContent = clipboardOffer.name || '可直接选工具处理'
  } else {
    offerTitle.textContent = '剪贴板里是 JSON'
    offerSub.textContent = `${clipboardOffer.chars} 个字符 · 格式化 / 转格式`
  }
}

/** 取剪贴板 → 匹配工具 → 展示参数面板 */
async function takeClipboard() {
  clearTimeout(collapseTimer)
  collapseTimer = null
  const res = await bridge.grabClipboard()
  if (!res || !res.ok) {
    clipboardOffer = null
    renderOffer()
    flashHint((res && res.reason) || '剪贴板里没有可处理的内容')
    // 面板可能还没展开，出错信息也要能在胶囊上看到
    dotEl.dataset.tone = 'err'
    labelEl.textContent = '剪贴板为空'
    clearTimeout(pillResetTimer)
    pillResetTimer = setTimeout(() => updatePill(), 2600)
    return
  }
  clipboardOffer = null
  renderOffer()
  pending = res
  expandNow()
  renderSetup()
  updatePill()
}

document.getElementById('btnOfferTake').addEventListener('click', takeClipboard)
document.getElementById('btnPaste').addEventListener('click', takeClipboard)

document.getElementById('btnOfferSkip').addEventListener('click', () => {
  clipboardOffer = null
  renderOffer()
  updatePill()
})

// 主进程轮询发现剪贴板有新内容（null 表示当前内容没有工具能处理）
bridge.onClipboardOffer((offer) => {
  clipboardOffer = offer || null
  renderOffer()
  updatePill()
})

// 热键 Ctrl+Alt+V 取到的结果
bridge.onClipboardResult((res) => {
  if (!res || !res.ok) {
    flashHint((res && res.reason) || '剪贴板里没有可处理的内容')
    dotEl.dataset.tone = 'err'
    labelEl.textContent = '剪贴板为空'
    clearTimeout(pillResetTimer)
    pillResetTimer = setTimeout(() => updatePill(), 2600)
    return
  }
  clipboardOffer = null
  renderOffer()
  pending = res
  expandNow()
  renderSetup()
  updatePill()
})

// ---------------- 参数面板 ----------------

function totalSize(payload) {
  const files = payload.files || []
  const sum = files.reduce((s, f) => s + (f.size || 0), 0)
  if (sum < 1024) return `${sum} B`
  if (sum < 1024 * 1024) return `${(sum / 1024).toFixed(1)} KB`
  return `${(sum / 1024 / 1024).toFixed(2)} MB`
}

function currentTool() {
  return pending && pending.tools && pending.tools[0]
}

function valuesFor(tool) {
  if (!jobValues[tool.id]) {
    const v = {}
    for (const o of tool.options || []) v[o.key] = o.default
    jobValues[tool.id] = v
  }
  return jobValues[tool.id]
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}

function renderSetup() {
  const tool = currentTool()
  if (!tool) {
    setupEl.hidden = true
    setupEl.innerHTML = ''
    estimateEl = null
    return
  }

  const values = valuesFor(tool)
  const files = pending.payload.files || []
  const origin = pending.payload.origin || null

  setupEl.hidden = false
  setupEl.innerHTML = ''
  // 面板重建后旧的预估节点就没了，先断开引用，避免结果写进已经移除的元素
  estimateEl = null

  const title = document.createElement('div')
  title.className = 'setup-title'
  const nameEl = document.createElement('span')
  nameEl.className = 'setup-name'
  const sizeEl = document.createElement('span')
  sizeEl.className = 'setup-size'

  if (origin && origin.type === 'image') {
    nameEl.textContent = '剪贴板截图'
    sizeEl.textContent = `${origin.width}×${origin.height}`
  } else if (origin && origin.type === 'text') {
    nameEl.textContent = '剪贴板 JSON'
    sizeEl.textContent = `${origin.chars} 字符`
  } else {
    // 来自剪贴板的文件与拖进来的走同一套展示
    nameEl.textContent = files.length === 1 ? files[0].name : `${files.length} 个文件`
    sizeEl.textContent = totalSize(pending.payload)
  }

  title.appendChild(nameEl)
  title.appendChild(sizeEl)
  // 来源和产物位置先说清楚，免得找不到文件
  if (origin && origin.type === 'image') {
    const tag = document.createElement('span')
    tag.className = 'setup-tag'
    tag.textContent = '存到桌面'
    title.appendChild(tag)
  } else if (origin && origin.type === 'files') {
    const tag = document.createElement('span')
    tag.className = 'setup-tag'
    tag.textContent = '来自剪贴板'
    title.appendChild(tag)
  }
  setupEl.appendChild(title)

  // JSON 需要键盘输入，岛是 focusable:false 收不到，只能开独立窗口
  if (tool.ui === 'json-editor') {
    const btn = document.createElement('button')
    btn.className = 'primary'
    btn.textContent = '在编辑器中打开'
    btn.addEventListener('click', () => {
      if (pending.payload.kind === 'text') {
        bridge.openJson({ text: pending.payload.text, name: '来自剪贴板' })
      } else {
        bridge.openJson(files[0] ? files[0].path : null)
      }
      pending = null
      setupEl.hidden = true
      setupEl.innerHTML = ''
      collapseNow()
    })
    setupEl.appendChild(btn)
    return
  }

  // 「仅优化播放」开启时，其余转码参数都没意义，直接隐藏
  const hiddenBy = values.faststartOnly === true

  for (const opt of tool.options || []) {
    if (hiddenBy && opt.key !== 'faststartOnly') continue
    setupEl.appendChild(renderOption(opt, values))
  }

  // 「压缩后多大」——只有实现了 estimate() 的工具才有（目前是图片压缩）
  if (tool.estimable) {
    const est = document.createElement('div')
    est.className = 'estimate'
    setupEl.appendChild(est)
    estimateEl = est
    refreshEstimate(est, tool, values, 160)
  }

  const start = document.createElement('button')
  start.className = 'primary'
  start.textContent = startLabel(tool, values)
  start.addEventListener('click', () => {
    bridge.startJob({
      toolId: tool.id,
      payload: pending.payload,
      options: { ...values }
    })
    pending = null
    setupEl.hidden = true
    setupEl.innerHTML = ''
  })
  setupEl.appendChild(start)
}

function startLabel(tool, values) {
  if (tool.id === 'image-compress') {
    const f = values.format && values.format !== 'keep' ? String(values.format).toUpperCase() : ''
    return f ? `开始压缩并转为 ${f}` : '开始压缩'
  }
  if (tool.id === 'video') {
    return values.faststartOnly ? '优化播放' : '开始处理'
  }
  return '开始'
}

// ---------------- 压缩后大小预估 ----------------

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 同一个「文件 + 参数」组合才算同一个键，换图或换参数都要重算 */
function estimateKey(tool, values) {
  const files = (pending && pending.payload && pending.payload.files) || []
  const sig = files.map((f) => `${f.path}:${f.size}`).join('|')
  return `${tool.id}|${JSON.stringify(values)}|${sig}`
}

/**
 * 估算产物大小。
 * 主进程是真的按当前参数编码一遍再量字节数（不落盘），所以这个数字和
 * 最终文件基本一致；代价是每张图几十到几百毫秒，所以延后触发 + 结果缓存。
 */
function refreshEstimate(el, tool, values, delay = 0, keep = false) {
  if (!el || !tool || !pending) return
  const seq = (estimateSeq += 1)
  clearTimeout(estimateTimer)

  const key = estimateKey(tool, values)
  if (estimateCache.has(key)) {
    paintEstimate(el, estimateCache.get(key))
    return
  }

  // 拖滑块时保留上一次的数字，不要一路跳「计算中」
  if (!keep) {
    el.dataset.state = 'busy'
    el.textContent = '计算压缩后大小…'
  }

  const payload = pending.payload
  estimateTimer = setTimeout(async () => {
    let res = null
    try {
      res = await bridge.estimate({ toolId: tool.id, payload, options: { ...values } })
    } catch {
      res = null
    }
    if (seq !== estimateSeq) return
    if (res) {
      estimateCache.set(key, res)
      if (estimateCache.size > 40) estimateCache.delete(estimateCache.keys().next().value)
    }
    if (el.isConnected) paintEstimate(el, res)
  }, delay)
}

function paintEstimate(el, res) {
  el.innerHTML = ''

  if (!res || res.ok !== true) {
    el.dataset.state = 'idle'
    el.textContent = '算不出压缩后大小'
    return
  }
  el.dataset.state = 'done'

  const main = document.createElement('span')
  main.className = 'est-main'
  main.appendChild(document.createTextNode('压缩后约 '))
  const num = document.createElement('b')
  num.textContent = fmtSize(res.after)
  main.appendChild(num)
  if (!res.exact) {
    const note = document.createElement('i')
    note.className = 'est-note'
    note.textContent = `（${res.count} 张估算）`
    main.appendChild(note)
  }
  el.appendChild(main)

  const pct = res.before > 0 ? Math.round((1 - res.after / res.before) * 100) : 0
  const badge = document.createElement('span')
  badge.className = 'est-badge'

  if (res.alreadyOptimal >= res.count) {
    badge.dataset.tone = 'flat'
    badge.textContent = '已是最优'
  } else if (pct > 0) {
    badge.dataset.tone = 'down'
    badge.textContent = `省 ${pct}%`
  } else if (pct < 0) {
    badge.dataset.tone = 'up'
    badge.textContent = `大 ${Math.abs(pct)}%`
  } else {
    badge.dataset.tone = 'flat'
    badge.textContent = '几乎不变'
  }
  el.appendChild(badge)
}

function renderOption(opt, values) {
  const wrap = document.createElement('div')
  wrap.dataset.key = opt.key

  if (opt.type === 'segmented') {
    wrap.className = 'field'
    const label = document.createElement('span')
    label.className = 'field-label'
    label.textContent = opt.label
    wrap.appendChild(label)

    const group = document.createElement('div')
    group.className = 'segmented'
    for (const c of opt.choices) {
      const b = document.createElement('button')
      b.className = 'seg'
      b.textContent = c.label
      b.dataset.on = values[opt.key] === c.value ? '1' : '0'
      b.addEventListener('click', () => {
        values[opt.key] = c.value
        renderSetup()
      })
      group.appendChild(b)
    }
    wrap.appendChild(group)
    return wrap
  }

  if (opt.type === 'slider') {
    wrap.className = 'field'
    const head = document.createElement('div')
    head.className = 'field-head'
    const label = document.createElement('span')
    label.className = 'field-label'
    label.textContent = opt.label
    const val = document.createElement('span')
    val.className = 'field-value'
    val.textContent = String(values[opt.key])
    head.appendChild(label)
    head.appendChild(val)

    const input = document.createElement('input')
    input.type = 'range'
    input.className = 'slider'
    input.min = String(opt.min)
    input.max = String(opt.max)
    input.step = String(opt.step || 1)
    input.value = String(values[opt.key])

    const paintFill = () => {
      const min = Number(opt.min)
      const max = Number(opt.max)
      const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0
      input.style.setProperty('--fill', `${pct}%`)
    }
    paintFill()

    // 拖动时只更新值不重渲染，否则会打断拖动
    input.addEventListener('input', () => {
      values[opt.key] = Number(input.value)
      val.textContent = input.value
      paintFill()
      // 松手前先不算，拖停 300ms 再估一次；keep 住旧数字避免一路闪「计算中」
      if (estimateEl) refreshEstimate(estimateEl, currentTool(), values, 300, true)
    })

    wrap.appendChild(head)
    wrap.appendChild(input)
    return wrap
  }

  // toggle
  wrap.className = 'toggle-row'
  const text = document.createElement('div')
  text.className = 'toggle-text'
  const l = document.createElement('span')
  l.className = 'toggle-label'
  l.textContent = opt.label
  text.appendChild(l)
  if (opt.hint) {
    const h = document.createElement('span')
    h.className = 'toggle-hint'
    h.textContent = opt.hint
    text.appendChild(h)
  }

  const sw = document.createElement('span')
  sw.className = 'switch'
  sw.dataset.on = values[opt.key] ? '1' : '0'

  wrap.appendChild(text)
  wrap.appendChild(sw)

  wrap.addEventListener('click', () => {
    values[opt.key] = !values[opt.key]
    renderSetup()
  })

  return wrap
}

function flashHint(text) {
  hintEl.textContent = text
  clearTimeout(flashHint._t)
  flashHint._t = setTimeout(() => {
    hintEl.textContent = 'Ctrl+Alt+V 取剪贴板'
  }, 2600)
}

// ---------------- 任务 ----------------

bridge.onJobUpdate((job) => {
  jobsById.set(job.id, job)
  renderJob(job)
  updatePill()
})

bridge.onJobsReplaced((list) => {
  jobsById.clear()
  for (const el of jobEls.values()) el.remove()
  jobEls.clear()
  for (const job of list) {
    jobsById.set(job.id, job)
    renderJob(job)
  }
  refreshJobsTools()
  updatePill()
})

function createJobEl(job) {
  const el = document.createElement('div')
  el.className = 'job'
  el.dataset.status = job.status
  el.innerHTML = `
    <div class="job-top">
      <span class="job-name"></span>
      <span class="job-state"></span>
    </div>
    <div class="job-bar"><i></i></div>
    <div class="job-foot">
      <span class="job-note"></span>
      <button class="job-copy" hidden>复制</button>
    </div>
  `
  el.querySelector('.job-name').textContent = job.title

  // 点卡片打开输出文件所在目录
  el.addEventListener('click', () => {
    const current = jobsById.get(job.id)
    const hit = current && current.items && current.items.find((i) => i.ok && i.out)
    if (hit && hit.out) bridge.reveal(hit.out)
  })

  // 「复制」：图片进剪贴板当位图，视频当文件（资源管理器里可粘贴）
  const copyBtn = el.querySelector('.job-copy')
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const current = jobsById.get(job.id)
    const outs = current && current.items ? current.items.filter((i) => i.ok && i.out).map((i) => i.out) : []
    if (outs.length === 0) return
    copyBtn.dataset.state = 'busy'
    copyBtn.textContent = '复制中'
    const res = await bridge.copyPaths(outs)
    if (res && res.ok) {
      copyBtn.dataset.state = 'done'
      copyBtn.textContent = '已复制'
      clearTimeout(copyBtn._t)
      copyBtn._t = setTimeout(() => {
        copyBtn.dataset.state = ''
        copyBtn.textContent = '复制'
      }, 2200)
    } else {
      copyBtn.dataset.state = 'err'
      copyBtn.textContent = '复制失败'
      clearTimeout(copyBtn._t)
      copyBtn._t = setTimeout(() => {
        copyBtn.dataset.state = ''
        copyBtn.textContent = '复制'
      }, 2600)
    }
  })

  return el
}

function renderJob(job) {
  let el = jobEls.get(job.id)
  if (!el) {
    el = createJobEl(job)
    jobEls.set(job.id, el)
    jobsEl.appendChild(el)
  }

  el.dataset.status = job.status
  const state = el.querySelector('.job-state')
  const bar = el.querySelector('.job-bar i')
  const note = el.querySelector('.job-note')

  if (job.status === 'running') {
    const pct = Math.round((job.progress || 0) * 100)
    state.textContent = `${pct}%`
    bar.style.width = `${pct}%`
    note.textContent = job.message || job.toolName
  } else if (job.status === 'queued') {
    state.textContent = '排队'
    bar.style.width = '0%'
    note.textContent = job.toolName
  } else if (job.status === 'done') {
    state.textContent = '完成'
    bar.style.width = '100%'
    note.textContent = job.summary || ''
    const hasOut = Boolean(job.items && job.items.some((i) => i.ok && i.out))
    el.dataset.clickable = hasOut ? '1' : '0'

    const copyBtn = el.querySelector('.job-copy')
    copyBtn.hidden = !hasOut
    // 任务完成时主进程已经把唯一产物自动放进剪贴板了，这里把它标出来
    if (job.copied && copyBtn.dataset.state !== 'done') {
      copyBtn.dataset.state = 'done'
      copyBtn.textContent = '已复制'
    }
  } else if (job.status === 'error') {
    state.textContent = '失败'
    bar.style.width = '100%'
    note.textContent = job.error || ''
  } else {
    state.textContent = '已取消'
    bar.style.width = '0%'
    note.textContent = ''
  }

  refreshJobsTools()
}

function updatePill() {
  const all = Array.from(jobsById.values())
  const running = all.find((j) => j.status === 'running')
  const queued = all.filter((j) => j.status === 'queued').length
  const last = all[all.length - 1]
  const done = all.filter((j) => j.status === 'done').length

  clearTimeout(pillResetTimer)

  if (running) {
    const pct = Math.round((running.progress || 0) * 100)
    dotEl.dataset.tone = 'busy'
    labelEl.textContent = `${running.toolName} ${pct}%${queued > 0 ? ` (+${queued})` : ''}`
    meterEl.dataset.active = '1'
    meterEl.querySelector('i').style.width = `${pct}%`
    return
  }

  meterEl.dataset.active = '0'
  meterEl.querySelector('i').style.width = '0%'

  if (last && last.status === 'error') {
    dotEl.dataset.tone = 'err'
    labelEl.textContent = '处理失败'
  } else if (done > 0) {
    dotEl.dataset.tone = 'ok'
    labelEl.textContent = `完成 ${done} 项`
    pillResetTimer = setTimeout(() => {
      paintIdleLabel()
    }, 5000)
  } else {
    paintIdleLabel()
  }
}

/** 空闲时的胶囊文案：有剪贴板候选就提示，否则是普通引导 */
function paintIdleLabel() {
  if (clipboardOffer) {
    dotEl.dataset.tone = 'offer'
    if (clipboardOffer.kind === 'image') labelEl.textContent = '剪贴板有截图'
    else if (clipboardOffer.kind === 'files') labelEl.textContent = '剪贴板有文件'
    else labelEl.textContent = '剪贴板有 JSON'
    return
  }
  dotEl.dataset.tone = ''
  labelEl.textContent = '拖文件进来'
}

// ---------------- 启动 ----------------

// 心跳只给看门狗用（阈值 8 秒），2 秒一次足够；原来 600ms 纯属浪费 IPC
setInterval(() => {
  bridge.reportBeat({ state: island.dataset.state })
}, 2000)

// --shot 自动化截图用
window.__demoExpand = () => expandNow()
window.__demoOffer = (paths) => handlePaths(paths)
window.__demoClipboard = (offer) => {
  clipboardOffer = offer
  renderOffer()
  updatePill()
}
window.__demoPin = (v) => {
  pinned = Boolean(v)
}

// ---------------- 玻璃浓度自适应 ----------------
//
// 主进程定期采样岛周围桌面的平均亮度，这里把它翻译成玻璃的不透明度：
// 背景越暗，玻璃越实（否则浅色玻璃在深色壁纸上会变成灰雾，次要文字直接看不清）；
// 背景越亮，玻璃越透（否则白底上就是一张白纸）。
// 玻璃浓度现在是固定值，不再跟着桌面亮度变。
//
// 之前是主进程每 12 秒截一次整屏、把 1080p 的图解码 3 次算平均亮度，
// 单次 200ms 上下的同步 CPU 会把主进程的事件循环占住 ——
// 鼠标轮询停摆，表现就是指针突然卡住半秒再瞬移。
// 而玻璃已经做到 0.94 以上，亮/暗桌面的差异肉眼几乎看不出，
// 这点收益不值得每次采样卡一下，所以直接写死。
//
// 想整体调浓/调淡，改这三个数；想验证深色壁纸下的文字，用 --shot 的诊断钩子。
const GLASS = { a: 0.955, b: 0.94, c: 0.965 }

function applyBackdrop(data) {
  const root = document.documentElement.style
  root.setProperty('--ga', GLASS.a.toFixed(3))
  root.setProperty('--gb', GLASS.b.toFixed(3))
  root.setProperty('--gc', GLASS.c.toFixed(3))

  // data 只在 --shot 里由 __demoBackdrop 传入，用来切深色文字档做截图对照
  const lum = data && typeof data.lum === 'number' ? data.lum : 0.82
  document.body.dataset.backdrop = lum < 0.5 ? 'dark' : 'light'
}

bridge.getBackdrop().then(applyBackdrop).catch(() => {})
bridge.onBackdrop(applyBackdrop)
// --shot 截图时手动指定亮度，用来对比浅色/深色桌面下的浓度
window.__demoBackdrop = (lum) => applyBackdrop({ lum })

syncState()
updatePill()
