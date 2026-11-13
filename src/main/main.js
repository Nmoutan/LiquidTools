'use strict'

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
  shell,
  Tray,
  Menu,
  clipboard,
  ClipboardItem,
  nativeImage,
  dialog
} = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
// 统一走 image-engine（内部关掉了 libvips 的文件缓存，避免产物被本进程占住）
const sharp = require('./image-engine')

const registry = require('./tools/registry')
const { JobQueue, createJob } = require('./jobs')
const settings = require('./settings')

// 窗口永远是这个尺寸，从不 resize。
// 视觉上的展开/收起全部由渲染进程在窗口内部完成，
// 避免 Windows 上窗口尺寸动画带来的撕裂和闪烁。
const WIN_W = 420
const WIN_H = 470

/** @type {BrowserWindow | null} */
let win = null
/** @type {BrowserWindow | null} */
let jsonWin = null
let tray = null
let queue = null

/** 渲染进程上报的可交互区域（相对窗口的 CSS 像素） */
let hitRects = []
let ignoring = true
let pollTimer = null
let watchdog = null

/** 渲染进程心跳，用于检测白屏 / 卡死 */
let beat = null
let beatAt = 0
let lastReloadAt = 0
let expandEvents = 0

/** 仿真光标（--sim 时替代真实光标） */
let simCursor = null
/** 渲染进程控制台，仅诊断用 */
const consoleLogs = []

// ---------------- 单实例 ----------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const files = extractFileArgs(argv)
    if (files.length > 0) {
      dispatchFiles(files).then((res) => {
        if (win && !win.isDestroyed()) {
          revealWindow()
          win.webContents.send('payload:offer', res)
        }
      })
    } else if (win && !win.isDestroyed()) {
      revealWindow()
    }
  })
}

function extractFileArgs(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && fs.existsSync(a))
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isVisible() && !win.isMinimized()) {
    hiddenByUser = true
    win.hide()
  } else {
    hiddenByUser = false
    win.showInactive()
    assertTop()
  }
}

/** 其它地方要「把岛叫出来」时统一走这里，顺带解除隐藏标记 */
function revealWindow() {
  if (!win || win.isDestroyed()) return
  hiddenByUser = false
  if (win.isMinimized()) win.restore()
  win.showInactive()
  assertTop()
}

// ---------------- 主窗口 ----------------

// ---------------- 玻璃浓度：固定值，不再采样桌面 ----------------
//
// 这里原来每 12 秒截一次整屏、再把 1080p 的 PNG 解码 3 次算平均亮度。
// 单次要 200ms 上下的同步 CPU，主进程的事件循环被占住，
// 表现就是光标轮询停摆 —— 鼠标会有半秒左右卡在原地然后瞬移。
// 而玻璃现在已经是 0.94~0.985 的实心白，亮度自适应能带来的差异肉眼根本看不出来，
// 收益远小于代价，所以整块采样逻辑直接删掉，浓度写死在 styles.css 里。

function pushBackdrop() {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('theme:backdrop', { lum: 0.82 })
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const x = Math.round(workArea.x + (workArea.width - WIN_W) / 2)
  const y = workArea.y + 6

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.argv.includes('--shot') || process.argv.includes('--diag')) {
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      consoleLogs.push(`[renderer/${level}] ${message} (${sourceId}:${line})`)
    })
  }

  // 渲染进程崩溃 → 自动重载，避免出现「窗口还在但一片空白」
  win.webContents.on('render-process-gone', () => {
    if (!win || win.isDestroyed()) return
    lastReloadAt = Date.now()
    win.reload()
  })

  win.once('ready-to-show', () => {
    win.showInactive()
    win.setIgnoreMouseEvents(true, { forward: true })
    ignoring = true
    beatAt = Date.now()
    startCursorPolling()
    startWatchdog()
    startZOrderKeeper()
    if (process.argv.includes('--shot')) captureShots()
    if (process.argv.includes('--grab')) captureGrab()
  })

  win.on('closed', () => {
    win = null
    stopCursorPolling()
    stopWatchdog()
    stopZOrderKeeper()
  })

  // 系统/其它程序把窗口最小化（Win+D 的其中一种实现）→ 立刻回来
  win.on('minimize', () => {
    if (hiddenByUser || !win || win.isDestroyed()) return
    win.restore()
    win.showInactive()
    assertTop()
  })

  return win
}

/**
 * 心跳看门狗：窗口可见但渲染层 8 秒没有心跳，说明已经卡死或白屏，直接重载。
 * 带 15 秒冷却，避免连续崩溃时反复 reload。
 */
function startWatchdog() {
  stopWatchdog()
  watchdog = setInterval(() => {
    if (!win || win.isDestroyed()) return
    if (Date.now() - beatAt < 8000) return
    if (Date.now() - lastReloadAt < 15000) return
    lastReloadAt = Date.now()
    beatAt = Date.now()
    win.reload()
  }, 3000)
}

function stopWatchdog() {
  if (watchdog) clearInterval(watchdog)
  watchdog = null
}

// ---------------- 层级守护 ----------------
//
// alwaysOnTop 只在创建窗口时设了一次，而 Windows 会在下面这些时机把它压下去：
//   · Win+D / 显示桌面：所有窗口（含置顶窗口）被收起，之后不会自己回来
//   · 打开资源管理器、切换前台应用时，个别显卡驱动/多显示器场景会丢 WS_EX_TOPMOST
// 表现就是「岛被文件夹盖住，关掉一个还有下一个」「回桌面后岛整个不见了但托盘图标还在」。
//
// 所以加一个很轻的守护：每 1.3 秒把窗口重新提到最前。
// setAlwaysOnTop / moveTop 都是微秒级的 SetWindowPos 调用，1 秒一次对 CPU 可以忽略，
// 但足以让窗口在任何抢占之后 1 秒内回到原位。
// 用户主动隐藏（热键 / 托盘）时不做任何事，不能跟用户的操作对着干。
let hiddenByUser = false
let zTimer = null
let zTicks = 0

function assertTop() {
  if (!win || win.isDestroyed()) return
  // isAlwaysOnTop() 读的是 Electron 自己记的标记，可能和系统实际状态不一致，
  // 所以每 4 个周期（约 5 秒）无条件重设一次；其余时候只在标记丢了时才设。
  // 真正把窗口提上去的是 moveTop，那个每次都调。
  if (!win.isAlwaysOnTop() || zTicks % 4 === 0) {
    win.setAlwaysOnTop(true, 'screen-saver')
  }
  // moveTop 才是真正改 z 序的那一步，必须每次都调
  win.moveTop()
}

function startZOrderKeeper() {
  stopZOrderKeeper()
  zTicks = 0
  zTimer = setInterval(() => {
    if (!win || win.isDestroyed() || hiddenByUser) return
    zTicks += 1

    // 被系统收起（Win+D）或最小化 → 拉回来再置顶
    if (win.isMinimized()) {
      win.restore()
      win.showInactive()
      assertTop()
      return
    }
    if (!win.isVisible()) {
      win.showInactive()
      assertTop()
      return
    }
    assertTop()
  }, 1300)
}

function stopZOrderKeeper() {
  if (zTimer) clearInterval(zTimer)
  zTimer = null
}

/**
 * 点击穿透（setIgnoreMouseEvents）的开关。
 *
 * 这里其实是三件不同的事，混在一起看很容易误以为「一切都靠轮询」：
 *
 * 1) 悬停展开 —— 完全事件驱动，不靠轮询。
 *    窗口虽然设了穿透，但带 forward:true，Chromium 仍然会把 WM_MOUSEMOVE
 *    转发给渲染进程，DOM 的 mousemove 就能算出光标在不在岛上。
 *    实测：把轮询整个关掉，用真实鼠标移到岛上，渲染层照样收到事件，岛正常展开。
 *
 * 2) 光标离开 —— 必须轮询。
 *    穿透窗口只有光标在窗口范围内时才会收到鼠标消息，一旦移出去就彻底安静了；
 *    Windows 的 WM_MOUSELEAVE 需要先 TrackMouseEvent，而它同样依赖窗口能收到消息。
 *    实测：关掉轮询后把鼠标移开，状态会永远停在「可交互」，那块 420×470 的窗口
 *    就一直挡在桌面上吞点击。所以离开只能靠自己定时去问光标在哪。
 *
 * 3) 拖放文件 —— 也必须轮询。
 *    OLE 拖拽期间鼠标被拖拽源 SetCapture 抓走，点击穿透的窗口收不到任何鼠标消息；
 *    Windows 也没有「有东西拖进这个窗口了」的通知（只有真正成为 drop target 之后
 *    才会有 DragEnter），而点击穿透窗口在系统眼里根本不是一个可投放目标。
 *    如果 drop 那一刻窗口还没上膛，Windows 会把文件丢给下面的窗口（桌面/资源管理器），
 *    所以只能在光标靠近时提前把窗口打开。
 *
 * 频率按「光标离窗口多远」自适应：贴边 55ms（拖放随时可能落地），远处 240ms。
 * 用 setTimeout 链而不是 setInterval，是为了每次都能换间隔。
 */
const CURSOR_NEAR = 140
const POLL_NEAR_MS = 55
const POLL_FAR_MS = 240

function cursorDistance(lx, ly, w, h) {
  const dx = lx < 0 ? -lx : lx > w ? lx - w : 0
  const dy = ly < 0 ? -ly : ly > h ? ly - h : 0
  return Math.hypot(dx, dy)
}

/**
 * 用给定光标位置判定一次，必要时切换穿透状态。
 * 返回光标到窗口的距离（窗口不可用时返回 Infinity）。
 */
function applyPointer(p) {
  if (!win || win.isDestroyed()) return Infinity

  const b = win.getBounds()
  const lx = p.x - b.x
  const ly = p.y - b.y

  const inside = hitRects.some(
    (r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h
  )

  const shouldIgnore = !inside
  if (shouldIgnore !== ignoring) {
    ignoring = shouldIgnore
    if (!shouldIgnore) expandEvents += 1
    win.setIgnoreMouseEvents(ignoring, { forward: true })
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('pointer:region', { inside: !shouldIgnore })
    }
  }

  return cursorDistance(lx, ly, b.width, b.height)
}

function startCursorPolling() {
  stopCursorPolling()
  const tick = () => {
    if (!win || win.isDestroyed()) return
    let next = POLL_FAR_MS

    // 窗口被隐藏时没什么可判定，慢速空转即可
    if (win.isVisible()) {
      const d = applyPointer(simCursor || screen.getCursorScreenPoint())
      next = d <= CURSOR_NEAR ? POLL_NEAR_MS : POLL_FAR_MS
    }

    pollTimer = setTimeout(tick, next)
  }
  pollTimer = setTimeout(tick, POLL_FAR_MS)
}

function stopCursorPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

// ---------------- 剪贴板输入 ----------------

/**
 * Windows 没有「剪贴板变化」事件，只能轮询。
 *
 * 注意 Electron 45 起主进程的 clipboard 换成了标准的异步 Clipboard API：
 * read() 返回 ClipboardItem[]，内容要通过 item.getType(type) 拿 Blob，
 * 老的 readImage / writeImage / availableFormats 全部没有了。
 *
 * 三个约束：
 * 1. 图片用「采样哈希」（每 4KB 取 1 字节）判断是否变了，避免整块 sha1。
 * 2. PNG 的宽高直接从 IHDR 头解析，不做解码，省掉每轮的图片解码开销。
 * 3. 只把「图片」和「能解析成 JSON 的文本」当输入源，
 *    否则复制任何一段文字都会弹提示，岛会变成噪音源。
 */
const CLIP_DIR = path.join(app.getPath('temp'), 'waterTool-clip')
let clipTimer = null
let lastClipKey = ''

/**
 * 判断剪贴板图片有没有变：只采样前 32KB。
 * PNG 的 IHDR/IDAT 开头就包含尺寸和第一行像素，换一张图几乎不可能撞上；
 * 之前对 5MB 的图按全量步进取样，每次轮询要多做一千多次小 Buffer 分配。
 */
function sampleHash(buf) {
  const limit = Math.min(buf.length, 32768)
  const stride = Math.max(1, Math.floor(limit / 512))
  const h = crypto.createHash('sha1')
  for (let i = 0; i < limit; i += stride) h.update(buf.subarray(i, i + 1))
  return h.digest('hex').slice(0, 12)
}

/** 不解码也能拿 PNG 尺寸：IHDR 从第 16 字节开始是 width/height */
function pngSize(buf) {
  if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  return null
}

async function readClipboardSignal() {
  let items = []
  try {
    items = await clipboard.read()
  } catch {
    return null
  }
  if (!Array.isArray(items) || items.length === 0) return null

  // 图片优先：截图通常只有图，没有文本
  for (const item of items) {
    const types = (item && item.types) || []
    const imgType = types.find((t) => t && t.startsWith('image/'))
    if (!imgType) continue

    let buf = null
    try {
      const blob = await item.getType(imgType)
      buf = Buffer.from(await blob.arrayBuffer())
    } catch {
      continue
    }
    if (!buf || buf.length === 0) continue

    const size = pngSize(buf) || nativeImage.createFromBuffer(buf).getSize()
    return {
      kind: 'image',
      width: size.width || 0,
      height: size.height || 0,
      png: buf,
      key: `img:${size.width}x${size.height}:${buf.length}:${sampleHash(buf)}`
    }
  }

  // 资源管理器里 Ctrl+C 一个文件（含视频），剪贴板里是 text/uri-list
  for (const item of items) {
    const types = (item && item.types) || []
    if (!types.includes('text/uri-list')) continue

    let raw = ''
    try {
      raw = await (await item.getType('text/uri-list')).text()
    } catch {
      continue
    }
    const paths = parseUriList(raw)
    if (paths.length === 0) continue
    return { kind: 'files', paths, key: `files:${paths.join('|')}` }
  }

  let text = ''
  try {
    text = await clipboard.readText()
  } catch {
    text = ''
  }
  if (text && text.trim()) {
    const trimmed = text.trim()
    let isJson = false
    if (/^[[{]/.test(trimmed)) {
      try {
        JSON.parse(trimmed)
        isJson = true
      } catch {
        isJson = false
      }
    }
    if (isJson) {
      return {
        kind: 'text',
        text,
        chars: text.length,
        key: `txt:${text.length}:${sampleHash(Buffer.from(trimmed, 'utf8'))}`
      }
    }
  }

  return null
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** text/uri-list → 真实磁盘路径（Windows 只有 file:// URI 这一种可靠形态） */
function parseUriList(raw) {
  const out = []
  for (const line of String(raw).split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#') || !/^file:\/\//i.test(s)) continue
    try {
      const p = decodeURIComponent(new URL(s).pathname)
      const win = p.replace(/^\//, '').replace(/\//g, '\\')
      if (fs.existsSync(win)) out.push(win)
    } catch {
      /* 跳过坏行 */
    }
  }
  return out
}

/** 把剪贴板内容落成 Payload（工具层只认文件 / 文本） */
async function materializeClipboard(sig) {
  if (sig.kind === 'image') {
    fs.mkdirSync(CLIP_DIR, { recursive: true })
    const file = path.join(CLIP_DIR, `截图-${stamp()}.png`)
    fs.writeFileSync(file, sig.png)
    const st = fs.statSync(file)
    return {
      kind: 'files',
      files: [{ path: file, name: path.basename(file), size: st.size }],
      paths: [file],
      // 临时目录里的产物没有意义，压缩结果落到「产物目录」
      // （默认 图片\waterTool，可在岛底部右键改到别的盘；--shot 时写进 test-assets）
      outputDir: process.argv.includes('--shot')
        ? path.join(app.getAppPath(), 'test-assets')
        : settings.ensureOutputDir(),
      origin: { kind: 'clipboard', type: 'image', width: sig.width, height: sig.height }
    }
  }

  if (sig.kind === 'files') {
    return buildFilesPayload(sig.paths, {
      kind: 'clipboard',
      type: 'files',
      count: sig.paths.length
    })
  }

  return {
    kind: 'text',
    text: sig.text,
    files: [],
    paths: [],
    origin: { kind: 'clipboard', type: 'text', chars: sig.chars }
  }
}

/** 读当前剪贴板并匹配工具，返回给渲染层 */
async function grabClipboard() {
  let sig = null
  try {
    sig = await readClipboardSignal()
  } catch {
    return { ok: false, reason: '读不到剪贴板' }
  }
  if (!sig) return { ok: false, reason: '剪贴板里没有图片 / 文件 / JSON' }

  lastClipKey = sig.key
  const payload = await materializeClipboard(sig)
  if (!payload) return { ok: false, reason: '这些文件读不到' }

  const tools = registry.describe(payload)
  if (tools.length === 0) return { ok: false, reason: '剪贴板内容没有匹配的工具' }

  return { ok: true, payload, tools }
}

/**
 * 轮询节奏是自适应的：read() / readText() 几乎不要钱（实测 0.1ms），
 * 但拿到图片 blob 需要 Windows 把 DIB 转成 PNG，1080p 截图实测约 22ms。
 * 所以慢的时候自动把间隔拉到 1.2s，避免为了一个后台提示持续占 CPU。
 */
let clipAlive = false
let clipCostMs = 0
/** 连续多少轮内容没变，用来做退避 */
let clipIdlePolls = 0

async function clipTick() {
  if (!win || win.isDestroyed()) return
  const t0 = Date.now()
  const sig = await readClipboardSignal()
  clipCostMs = sig && sig.kind === 'image' ? Date.now() - t0 : 0

  if (!sig) {
    clipIdlePolls += 1
    return
  }
  if (sig.key === lastClipKey) {
    clipIdlePolls += 1
    return
  }
  clipIdlePolls = 0
  lastClipKey = sig.key

  // 复制了没有工具能处理的文件（压缩包、文档…）就安静一点，不要弹提示
  if (sig.kind === 'files') {
    const payload = await buildFilesPayload(sig.paths)
    if (!payload || registry.match(payload).length === 0) {
      if (!win.webContents.isDestroyed()) win.webContents.send('clipboard:offer', null)
      return
    }
  }

  if (win.webContents.isDestroyed()) return
  win.webContents.send('clipboard:offer', {
    kind: sig.kind,
    width: sig.width || 0,
    height: sig.height || 0,
    chars: sig.chars || 0,
    count: sig.paths ? sig.paths.length : 0,
    name: sig.paths && sig.paths.length === 1 ? path.basename(sig.paths[0]) : ''
  })
}

function clipLoop() {
  if (!clipAlive) return
  // 剪贴板里是大图时，每次读取都要让 Windows 把 DIB 编码成 PNG（20ms 上下），
  // 这种时候把间隔拉长到 2 秒 —— 提示晚 1 秒无感，省下的是持续的后台开销。
  //
  // 再加一层退避：连续 8 轮内容都没变（也就是快 10 秒没人动剪贴板），
  // 间隔再翻倍，最长 4.5 秒。剪贴板里的东西常年不动，大部分时间都停在这一档；
  // 一旦内容变化立刻回到正常频率，不会影响「刚截完图就想用」的体感。
  let delay = clipCostMs > 12 ? 2000 : 700
  if (clipIdlePolls > 8) delay = Math.min(delay * 2.2, 4500)

  clipTimer = setTimeout(async () => {
    try {
      await clipTick()
    } catch {
      /* 剪贴板被别的程序占着时读会失败，下一轮再来 */
    }
    clipLoop()
  }, delay)
}

function startClipboardWatch() {
  stopClipboardWatch()
  clipAlive = true

  // 启动时先记下当前内容，避免一开机就把上次复制的东西弹出来
  ;(async () => {
    try {
      const first = await readClipboardSignal()
      lastClipKey = first ? first.key : ''
    } catch {
      lastClipKey = ''
    }
    clipLoop()
  })()
}

function stopClipboardWatch() {
  clipAlive = false
  if (clipTimer) clearTimeout(clipTimer)
  clipTimer = null
}

/** 顺手清掉一天前的剪贴板临时截图，避免 %TEMP% 里越攒越多 */
function cleanClipDir() {
  try {
    if (!fs.existsSync(CLIP_DIR)) return
    const now = Date.now()
    for (const name of fs.readdirSync(CLIP_DIR)) {
      const p = path.join(CLIP_DIR, name)
      try {
        if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p)
      } catch {
        /* 单个文件失败无所谓 */
      }
    }
  } catch {
    /* 忽略 */
  }
}


// ---------------- JSON 独立窗口 ----------------

function openJsonWindow(target) {
  if (jsonWin && !jsonWin.isDestroyed()) {
    jsonWin.show()
    jsonWin.focus()
    if (target) jsonWin.webContents.send('json:load', target)
    return
  }

  jsonWin = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#f6f4f1',
    show: false,
    title: 'JSON',
    webPreferences: {
      preload: path.join(__dirname, '..', 'json-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  jsonWin.loadFile(path.join(__dirname, '..', 'renderer', 'json', 'index.html'))

  jsonWin.once('ready-to-show', () => {
    jsonWin.show()
    jsonWin.focus()
    if (target) jsonWin.webContents.send('json:load', target)
  })

  jsonWin.on('closed', () => {
    jsonWin = null
  })
}

// ---------------- 托盘 ----------------

/** 托盘 / 热键共用：取剪贴板并把结果推给渲染层 */
async function grabFromTray() {
  if (!win || win.isDestroyed()) return
  revealWindow()
  const res = await grabClipboard()
  if (!win.webContents.isDestroyed()) win.webContents.send('clipboard:result', res)
}

async function createTray() {
  try {
    const sharp = require('./image-engine')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <path d="M16 5v14" stroke="#4C8DFF" stroke-width="3.2" stroke-linecap="round"/>
      <path d="M10 13.5L16 19.5L22 13.5" stroke="#4C8DFF" stroke-width="3.2"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <rect x="8" y="24.5" width="16" height="2.8" rx="1.4" fill="#4C8DFF"/>
    </svg>`
    const png = await sharp(Buffer.from(svg)).png().toBuffer()
    tray = new Tray(nativeImage.createFromBuffer(png))
    tray.setToolTip('waterTool')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 / 隐藏', click: toggleWindow },
        { label: '从剪贴板处理', click: grabFromTray },
        {
          label: 'JSON 编辑器',
          click: () => openJsonWindow(null)
        },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() }
      ])
    )
    tray.on('click', toggleWindow)
  } catch {
    tray = null
  }
}

// ---------------- 任务分发 ----------------

async function dispatchFiles(paths) {
  const payload = await buildFilesPayload(paths)
  if (!payload) return { ok: false, reason: paths && paths.length ? 'empty' : 'no files' }
  return { ok: true, payload, tools: registry.describe(payload) }
}

/** 文件路径 → 标准 Payload（拖放、右键菜单、剪贴板文件共用） */
async function buildFilesPayload(paths, origin) {
  if (!paths || paths.length === 0) return null

  const files = []
  for (const p of paths) {
    try {
      const st = await fs.promises.stat(p)
      if (st.isDirectory()) continue
      files.push({ path: p, name: path.basename(p), size: st.size })
    } catch {
      /* 忽略不可读文件 */
    }
  }
  if (files.length === 0) return null

  const payload = { kind: 'files', files, paths: files.map((f) => f.path) }
  if (origin) payload.origin = origin
  return payload
}

function startJob({ toolId, payload, options }) {
  const tool = registry.get(toolId)
  if (!tool) return { ok: false, reason: 'unknown tool' }

  const normalized = { ...payload }
  if (normalized.kind === 'files' && !normalized.paths) {
    normalized.paths = (normalized.files || []).map((f) => f.path)
  }

  // 用户点过「更换产物位置」就集中到那里，连拖进来的文件也一样 ——
  // 这样把目录设到 D 盘之后，C 盘就真的不再落产物。
  if (!normalized.outputDir && settings.isCustom() && !process.argv.includes('--shot')) {
    normalized.outputDir = settings.ensureOutputDir()
  }

  const title =
    normalized.kind === 'files' && normalized.files?.length === 1
      ? normalized.files[0].name
      : `${normalized.files?.length || 0} 个文件`

  const job = createJob({ tool, payload: normalized, options, title })
  queue.push(job)
  return { ok: true, jobId: job.id }
}

// ---------------- 把产物放回剪贴板 ----------------

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.gif', '.tiff'])

/**
 * 我们刚写过剪贴板，轮询会立刻发现「新内容」并弹提示 —— 那就变成自己提醒自己了。
 * 写完主动读一次并记下 key，轮询就认为内容没变过。
 */
async function noteSelfClipboard() {
  try {
    const sig = await readClipboardSignal()
    if (sig) lastClipKey = sig.key
  } catch {
    /* 读不到就算了，最多多弹一次提示 */
  }
}

/**
 * 把产物放进剪贴板：
 *   图片 → 真正的位图（任何地方 Ctrl+V 都能贴）
 *   其他 → Windows 的 FileNameW，资源管理器里 Ctrl+V 相当于粘贴这个文件
 */
async function copyPathsToClipboard(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => p && fs.existsSync(p))
  if (list.length === 0) return { ok: false, reason: '文件已经不在了' }

  const first = list[0]
  const ext = path.extname(first).toLowerCase()

  try {
    if (IMAGE_EXTS.has(ext)) {
      // 一次性读成字节再解码：任何「按路径」的解码都可能让文件被句柄/映射占住，
      // 而这里读的正是用户马上想删掉的产物，绝对不能留占用。
      const raw = await fs.promises.readFile(first)
      // png 直接丢原始字节，省一次解码 + 重编码
      let payload = ext === '.png' ? raw : null

      // nativeImage 只保证能解 png / jpg；webp / avif 解出来常常是空的，
      // 这时候交给 sharp 转一次，否则「复制」会静默失败
      if (!payload) {
        const img = nativeImage.createFromBuffer(raw)
        if (!img.isEmpty()) payload = img.toPNG()
      }
      if (!payload) payload = await sharp(raw).png().toBuffer()

      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([payload], { type: 'image/png' }) })])
      await noteSelfClipboard()
      return { ok: true, kind: 'image', path: first, count: list.length }
    }

    await clipboard.writeBuffer('FileNameW', Buffer.from(`${first}\u0000`, 'ucs2'))
    await noteSelfClipboard()
    return { ok: true, kind: 'file', path: first, count: list.length }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

/**
 * 把文件以「剪切」形式放进剪贴板：粘贴到别处时源文件会被移走，等于帮用户搬家。
 *
 * Electron 没有暴露 CF_HDROP 的写入，只能自己拼 Windows 剪贴板的两份数据：
 *   CF_HDROP             → 文件列表
 *   Preferred DropEffect → 2 (DROPEFFECT_MOVE)，资源管理器看到它就按「剪切」处理
 * 借 PowerShell 的 WinForms Clipboard 构造最省事；
 * 命令走 -EncodedCommand（UTF-16LE），中文路径不会被引号转义坑到。
 */
function cutFilesToClipboard(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => p && fs.existsSync(p))
  if (list.length === 0) return Promise.resolve({ ok: false, reason: '文件已经不在了' })

  const b64 = Buffer.from(JSON.stringify(list), 'utf8').toString('base64')
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$paths = @($json | ConvertFrom-Json)
$sc = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) { [void]$sc.Add([string]$p) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($sc)
$ms = New-Object System.IO.MemoryStream
$ms.Write([BitConverter]::GetBytes([int]2), 0, 4)
$ms.Position = 0
$data.SetData('Preferred DropEffect', $ms)
for ($i = 0; $i -lt 3; $i++) {
  try {
    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
    Write-Output 'OK'
    break
  } catch {
    Start-Sleep -Milliseconds 90
  }
}
`

  return new Promise((resolve) => {
    let done = false
    const finish = (res) => {
      if (!done) {
        done = true
        resolve(res)
      }
    }

    let out = ''
    let err = ''
    let p
    try {
      p = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ])
    } catch (e) {
      return finish({ ok: false, reason: e.message })
    }

    p.stdout.on('data', (d) => {
      out += d.toString()
    })
    p.stderr.on('data', (d) => {
      err += d.toString()
    })
    p.on('error', (e) => finish({ ok: false, reason: e.message }))
    p.on('close', () => {
      if (out.includes('OK')) {
        // 剪贴板换了内容，同步一下 key，别让自己的轮询弹「剪贴板有文件」
        noteSelfClipboard().then(() => finish({ ok: true, count: list.length }))
      } else {
        const tail = err.trim().split(/\r?\n/).filter(Boolean).pop()
        console.log('[cut] failed:', tail || '(no stderr)', 'stdout=', JSON.stringify(out.slice(0, 300)))
        finish({ ok: false, reason: tail || '剪贴板被其他程序占用' })
      }
    })
    setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
    }, 6000)
  })
}

/** 任务完成时自动把「唯一产物」放进剪贴板；多文件时不打扰 */
const autoCopied = new Set()

function autoCopyJob(job) {
  if (autoCopied.has(job.id)) return
  const outs = (job.items || []).filter((i) => i.ok && i.out).map((i) => i.out)
  if (outs.length !== 1) return
  autoCopied.add(job.id)
  copyPathsToClipboard(outs).then((res) => {
    if (!res || !res.ok || !win || win.isDestroyed()) return
    // 只是给界面一个「已进剪贴板」的标记，不改变队列里的任务状态
    win.webContents.send('jobs:update', { ...job, copied: true })
  })
}

// ---------------- IPC ----------------

function bindIpc() {
  queue = new JobQueue((job) => {
    if (!win || win.isDestroyed()) return
    if (job === null) {
      win.webContents.send('jobs:replaced', queue.snapshot())
      return
    }
    win.webContents.send('jobs:update', job)
    if (job.status === 'done') autoCopyJob(job)
  })

  ipcMain.handle('payload:inspect', (_e, paths) => dispatchFiles(paths))
  ipcMain.handle('job:start', (_e, arg) => startJob(arg))

  // 参数面板里的「压缩后大概多大」：工具自己实现 estimate()，这里只做转发。
  // 没有 estimate 的工具返回 null，界面就不显示这一行。
  ipcMain.handle('tool:estimate', async (_e, arg) => {
    if (!arg || !arg.toolId || !arg.payload) return null
    const tool = registry.get(arg.toolId)
    if (!tool || typeof tool.estimate !== 'function') return null
    try {
      return await tool.estimate(arg.payload, arg.options || {})
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('jobs:snapshot', () => queue.snapshot())

  // 把产物放回剪贴板（任务卡上的「复制」按钮 / 结果卡自动复制失败时手动补一次）
  ipcMain.handle('clip:copy', (_e, paths) => copyPathsToClipboard(paths))
  // 剪切形式：粘贴时源文件会被移走，适合「压完随手挪到别处」
  ipcMain.handle('clip:cut', (_e, paths) => cutFilesToClipboard(paths))

  // 产物目录：读当前值 / 改到别的盘 / 打开
  ipcMain.handle('settings:output', () => ({
    dir: settings.outputDir(),
    exists: fs.existsSync(settings.outputDir())
  }))
  ipcMain.handle('settings:pick-output', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择产物保存位置',
      defaultPath: settings.outputDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false }
    settings.write({ outputDir: res.filePaths[0] })
    return { ok: true, dir: res.filePaths[0] }
  })
  ipcMain.on('shell:open-output', () => {
    shell.openPath(settings.ensureOutputDir())
  })
  ipcMain.handle('theme:backdrop', () => ({ lum: 0.82 }))

  // 剪贴板：显式读取（按钮 / 热键），与轮询提示共用同一套归一化逻辑
  ipcMain.handle('clipboard:grab', () => grabClipboard())

  ipcMain.on('job:cancel', (_e, jobId) => queue.cancel(jobId))
  ipcMain.on('jobs:clear', () => queue.clearFinished())

  ipcMain.on('hit-rect', (_e, rects) => {
    if (Array.isArray(rects)) hitRects = rects
  })

  // 渲染层收到转发来的 mousemove：光标已经在窗口范围内，立刻上膛，
  // 不必等下一次轮询判定。已经是可交互状态时直接返回，几乎没有开销。
  ipcMain.on('pointer:probe', () => {
    if (!win || win.isDestroyed() || !ignoring) return
    applyPointer(simCursor || screen.getCursorScreenPoint())
  })

  ipcMain.on('pointer:set-ignore', (_e, ignore) => {
    if (!win || win.isDestroyed()) return
    const next = Boolean(ignore)
    if (next === ignoring) return
    ignoring = next
    win.setIgnoreMouseEvents(ignoring, { forward: true })
  })

  ipcMain.on('app:quit', () => app.quit())

  ipcMain.on('shell:reveal', (_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
  })

  ipcMain.on('json:open', (_e, target) => openJsonWindow(target || null))

  ipcMain.on('diag:beat', (_e, data) => {
    beat = data
    beatAt = Date.now()
  })

  // --- JSON 窗口 ---
  ipcMain.handle('json:read', async (_e, filePath) => {
    try {
      const text = await fs.promises.readFile(filePath, 'utf8')
      return { ok: true, text, name: path.basename(filePath) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('json:save', async (_e, { filePath, text }) => {
    try {
      await fs.promises.writeFile(filePath, text, 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('json:pick', async () => {
    const { dialog } = require('electron')
    const r = await dialog.showSaveDialog(jsonWin, {
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.on('win:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })

  ipcMain.on('win:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
}

// ---------------- 诊断 ----------------

const DIAG = process.argv.includes('--diag')
const SIM = process.argv.includes('--sim')

function startSim() {
  let phase = 0
  const place = () => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    phase += 1
    simCursor =
      phase % 2 === 1
        ? { x: b.x + Math.round(WIN_W / 2), y: b.y + 25 }
        : { x: b.x - 400, y: b.y + 600 }
  }
  place()
  setInterval(place, 900)
}

function startDiag() {
  const lines = []
  const t0 = Date.now()
  setInterval(() => {
    try {
      if (!win || win.isDestroyed()) {
        lines.push(`${Date.now() - t0}ms window destroyed`)
        return
      }
      const alive = Date.now() - beatAt < 1500
      lines.push(
        [
          `${String(Date.now() - t0).padStart(6)}ms`,
          `vis=${win.isVisible() ? 1 : 0}`,
          `ign=${ignoring ? 1 : 0}`,
          `alive=${alive ? 1 : 0}`,
          `enters=${expandEvents}`,
          `state=${beat ? beat.state : '-'}`,
          `rects=${JSON.stringify(hitRects)}`
        ].join(' ')
      )
    } catch (e) {
      lines.push(`${String(Date.now() - t0).padStart(6)}ms ERR ${e && e.message}`)
    }
  }, 400)

  setInterval(() => {
    fs.writeFileSync(path.join(app.getAppPath(), 'diag.log'), lines.slice(-300).join('\n'), 'utf8')
  }, 800)
}

// ---------------- 开发辅助：--grab 直接吃当前剪贴板 ----------------

/**
 * 用真实的剪贴板内容跑一遍 grabClipboard，验证「资源管理器复制文件」
 * 这条路径（text/uri-list → 路径 → 工具匹配）。
 */
async function captureGrab() {
  const dir = app.getAppPath()
  const lines = []
  try {
    await wait(700)
    const res = await grabClipboard()
    lines.push(
      `ok=${res.ok} reason=${res.reason || '-'} tools=${(res.tools || []).map((t) => t.id).join(',') || '-'}`
    )
    if (res.payload) lines.push('origin=' + JSON.stringify(res.payload.origin || null))
    if (res.payload && res.payload.paths) lines.push('paths=' + JSON.stringify(res.payload.paths))
    if (res.ok) {
      await win.webContents.executeJavaScript(`window.__demoPin(true); null`)
      win.webContents.send('clipboard:result', res)
      await wait(1000)
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(dir, 'shot-clip-files.png'), img.toPNG())
      lines.push('setup: ' + (await win.webContents.executeJavaScript(`document.getElementById('setup').innerText`)))
    }
  } catch (err) {
    lines.push('ERROR ' + (err && err.stack ? err.stack : String(err)))
  } finally {
    fs.writeFileSync(path.join(dir, 'grab-log.txt'), lines.join('\n'), 'utf8')
    app.quit()
  }
}

// ---------------- 开发辅助：--shot 自动截图 ----------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function captureShots() {
  const dir = app.getAppPath()
  const log = []
  const L = (m) => log.push(m)

  const shot = async (name) => {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(dir, name), img.toPNG())
  }

  // 截图时给 stage 铺一层「假桌面壁纸」，否则白玻璃压在白底上看不出通透度。
  // 三种背景用来分别验证：彩色照片型、纯浅色、纯深色（深色下可读性最容易出问题）
  const backdrops = {
    photo: [
      'radial-gradient(58% 46% at 16% 18%, rgba(112, 146, 196, 0.55), rgba(112, 146, 196, 0) 62%)',
      'radial-gradient(52% 44% at 84% 72%, rgba(212, 158, 112, 0.5), rgba(212, 158, 112, 0) 64%)',
      'radial-gradient(48% 40% at 52% 44%, rgba(126, 176, 148, 0.42), rgba(126, 176, 148, 0) 62%)',
      'linear-gradient(158deg, #dfe3e9 0%, #f3ece3 100%)'
    ].join(', '),
    light: 'linear-gradient(158deg, #eef1f5 0%, #f7f7f8 100%)',
    dark: 'linear-gradient(158deg, #1b1f26 0%, #2b2f36 52%, #14171b 100%)'
  }

  const setBackdrop = async (name) => {
    const css = name ? backdrops[name] : 'none'
    await win.webContents.executeJavaScript(
      `(() => { document.querySelector('.stage').style.backgroundImage = ${JSON.stringify(css)}; return 1 })()`
    )
  }

  const shotWin = async (target, file) => {
    if (!target || target.isDestroyed()) return
    const img = await target.webContents.capturePage()
    fs.writeFileSync(file, img.toPNG())
  }

  let prevClipText = ''
  try {
    await wait(900)
    await shot('shot-collapsed.png')
    await setBackdrop('photo')
    await win.webContents.executeJavaScript(`window.__demoBackdrop(0.88); null`)
    await wait(220)
    await shot('shot-collapsed-glass.png')

    await win.webContents.executeJavaScript(`window.__demoExpand && window.__demoExpand(); null`)
    await wait(800)
    await shot('shot-expanded-glass.png')
    await setBackdrop('dark')
    await win.webContents.executeJavaScript(`window.__demoBackdrop(0.12); null`)
    await wait(260)
    await shot('shot-expanded-dark.png')
    await setBackdrop(null)
    await win.webContents.executeJavaScript(`window.__demoBackdrop(0.88); null`)
    await wait(220)
    await shot('shot-expanded.png')

    // ---- 剪贴板：真实写入剪贴板，走「轮询 → 提示 → 取用 → 执行」全链路 ----
    const clipImg = path.join(dir, 'test-assets', 'screen1080.png')
    prevClipText = await clipboard.readText()
    if (fs.existsSync(clipImg)) {
      await win.webContents.executeJavaScript(`document.getElementById('btnCollapse').click(); null`)
      await wait(400)

      const clipT0 = Date.now()
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([fs.readFileSync(clipImg)], { type: 'image/png' })
        })
      ])
      await wait(1800) // 轮询 700ms + 渲染余量
      L(`clip detect after ${Date.now() - clipT0}ms`)
      await shot('shot-clip-pill.png')

      await win.webContents.executeJavaScript(`window.__demoExpand && window.__demoExpand(); null`)
      await wait(600)
      await shot('shot-clip-offer.png')
      L('offer card: ' + (await win.webContents.executeJavaScript(`document.getElementById('offer').innerText`)))

      await win.webContents.executeJavaScript(`document.getElementById('btnOfferTake').click(); null`)
      await wait(900)
      await shot('shot-clip-setup.png')
      L('clip setup: ' + (await win.webContents.executeJavaScript(`document.getElementById('setup').innerText`)))

      await win.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('.setup .primary'); if (b) b.click(); return !!b })()`
      )
      await wait(500)
      await shot('shot-clip-running.png')
      await wait(7000)
      // 钉住展开态，否则光标不在岛上，面板会自动收起，看不到完成卡片
      await win.webContents.executeJavaScript(
        `window.__demoPin(true); window.__demoExpand && window.__demoExpand(); null`
      )
      await wait(500)
      await shot('shot-clip-done.png')
      await win.webContents.executeJavaScript(`window.__demoPin(false); null`)
      L('clip jobs: ' + JSON.stringify(queue.snapshot().map((j) => [j.title, j.status, j.summary])))

      // 产物应该在任务完成时自动进了剪贴板
      const afterCopy = await readClipboardSignal()
      L(
        'clip after done: ' +
          (afterCopy
            ? `${afterCopy.kind} ${afterCopy.width || 0}x${afterCopy.height || 0} ${afterCopy.png ? Math.round(afterCopy.png.length / 1024) + 'KB' : ''}`
            : 'empty')
      )
    }

    // ---- 剪贴板里的 JSON 文本 ----
    await clipboard.writeText('{"name":"waterTool","tools":["image","video","json"],"ok":true}')
    await wait(1900)
    await win.webContents.executeJavaScript(`window.__demoExpand && window.__demoExpand(); null`)
    await wait(500)
    await shot('shot-clip-json-offer.png')
    await win.webContents.executeJavaScript(`document.getElementById('btnOfferTake').click(); null`)
    await wait(900)
    await shot('shot-clip-json-setup.png')
    L('json setup: ' + (await win.webContents.executeJavaScript(`document.getElementById('setup').innerText`)))

    // 在编辑器里打开（文本来源）
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.setup .primary'); if (b) b.click(); return !!b })()`
    )
    await wait(1800)
    if (jsonWin && !jsonWin.isDestroyed()) {
      await shotWin(jsonWin, path.join(dir, 'shot-clip-json-window.png'))
      L(
        'json win loaded: ' +
          (await jsonWin.webContents.executeJavaScript(`document.getElementById('fileName').textContent`))
      )
      jsonWin.close()
      await wait(400)
    }

    const testFiles = [
      path.join(dir, 'test-assets', 'gradient.jpg')
    ].filter((p) => fs.existsSync(p))

    if (testFiles.length > 0) {
      // 参数面板
      await win.webContents.executeJavaScript(`window.__demoOffer(${JSON.stringify(testFiles)})`)
      await wait(700)
      await shot('shot-setup.png')
      L('estimate default: ' + (await win.webContents.executeJavaScript(`document.querySelector('.estimate').innerText`)))

      // 拖质量条 + 换格式，预估值应该跟着变（且不需要重新渲染面板）
      await win.webContents.executeJavaScript(`
        (() => {
          const s = document.querySelector('.setup .slider')
          if (!s) return null
          s.value = '45'
          s.dispatchEvent(new Event('input', { bubbles: true }))
          return s.value
        })()
      `)
      await wait(1100)
      L('estimate q45: ' + (await win.webContents.executeJavaScript(`document.querySelector('.estimate').innerText`)))

      await win.webContents.executeJavaScript(`
        (() => {
          const b = [...document.querySelectorAll('.setup .seg')].find((x) => x.textContent === 'WebP')
          if (b) b.click()
          return !!b
        })()
      `)
      await wait(1100)
      await shot('shot-setup-estimate.png')
      L(
        'estimate webp45: ' +
          (await win.webContents.executeJavaScript(`document.querySelector('.estimate').innerText`))
      )

      // 深色壁纸是最容易出现「灰雾 + 看不清」的场景，单独留一张对照
      await setBackdrop('dark')
      await win.webContents.executeJavaScript(`window.__demoBackdrop(0.12); null`)
      await wait(320)
      await shot('shot-setup-dark.png')
      await setBackdrop('photo')
      await win.webContents.executeJavaScript(`window.__demoBackdrop(0.88); null`)
      await wait(240)

      // 点「开始」，验证参数真的传到了工具层
      await win.webContents.executeJavaScript(`
        (() => {
          const b = document.querySelector('.setup .primary')
          if (b) b.click()
          return !!b
        })()
      `)
      await wait(800)
      await shot('shot-running.png')
      // 等压缩收尾，看结果卡上的「复制」状态
      await wait(2600)
      // 任务跑完后岛会自动收回胶囊，截图前先钉住展开态，否则拍到的只是个「完成 2 项」
      await win.webContents.executeJavaScript(
        `window.__demoPin(true); window.__demoExpand && window.__demoExpand(); null`
      )
      await wait(420)
      await shot('shot-job-done.png')
      L(
        'image job: ' +
          JSON.stringify(
            queue.snapshot().map((j) => [j.status, j.summary, (j.items || []).map((i) => i.out && path.basename(i.out))])
          )
      )

      // 手动点结果卡上的「复制」，走 IPC 再放一次剪贴板
      L(
        'copy btn: ' +
          (await win.webContents.executeJavaScript(`(() => {
            const b = [...document.querySelectorAll('.job-copy')].filter((x) => !x.hidden).pop()
            if (!b) return 'none'
            b.click()
            return b.textContent
          })()`))
      )
      await wait(700)
      const afterBtn = await readClipboardSignal()
      L('clip after btn: ' + (afterBtn ? `${afterBtn.kind} ${afterBtn.width || 0}x${afterBtn.height || 0}` : 'empty'))

      // 批量「剪切全部」：走 PowerShell 写 CF_HDROP + DropEffect=2
      L(
        'cut all: ' +
          (await win.webContents.executeJavaScript(`(() => {
            const b = document.getElementById('btnCutAll')
            if (!b || b.hidden) return 'none'
            b.click()
            return b.textContent
          })()`))
      )
      await wait(2200)
      L(
        'cut result: ' +
          (await win.webContents.executeJavaScript(`document.getElementById('btnCutAll').textContent`)) +
          ' / hint=' +
          (await win.webContents.executeJavaScript(`document.getElementById('hint').textContent`))
      )
      L('output dir: ' + settings.outputDir() + ' exists=' + fs.existsSync(settings.outputDir()))
    }

    // 视频参数面板：浅色下最高的形态，顺便验证「仅优化播放」隐藏其余参数
    const videoFile = path.join(dir, 'test-assets', 'clip.mp4')
    if (fs.existsSync(videoFile)) {
      await win.webContents.executeJavaScript(`
        document.getElementById('btnClear').click()
        window.__demoPin(true)
        window.__demoOffer(${JSON.stringify([videoFile])})
        null
      `)
      await wait(1000)
      await shot('shot-video-setup.png')
      L('video setup: ' + (await win.webContents.executeJavaScript(`document.getElementById('setup').innerText`)))

      await win.webContents.executeJavaScript(
        `(() => { const t = document.querySelector('.setup .toggle-row'); if (t) t.click(); return !!t })()`
      )
      await wait(600)
      await shot('shot-video-faststart.png')
      L('video faststart: ' + (await win.webContents.executeJavaScript(`document.getElementById('setup').innerText`)))
      await win.webContents.executeJavaScript(`window.__demoPin(false); null`)
    }

    // JSON 独立窗口
    const jsonFile = path.join(dir, 'test-assets', 'data.json')
    if (fs.existsSync(jsonFile)) {
      openJsonWindow(jsonFile)
      await wait(1600)
      if (jsonWin && !jsonWin.isDestroyed()) {
        const jimg = await jsonWin.webContents.capturePage()
        fs.writeFileSync(path.join(dir, 'shot-json.png'), jimg.toPNG())

        // 验证格式转换
        await jsonWin.webContents.executeJavaScript(
          `document.querySelector('[data-fmt="yaml"]').click(); null`
        )
        await wait(500)
        const yimg = await jsonWin.webContents.capturePage()
        fs.writeFileSync(path.join(dir, 'shot-json-yaml.png'), yimg.toPNG())

        await jsonWin.webContents.executeJavaScript(
          `document.querySelector('[data-fmt="csv"]').click(); null`
        )
        await wait(500)
        const cimg = await jsonWin.webContents.capturePage()
        fs.writeFileSync(path.join(dir, 'shot-json-csv.png'), cimg.toPNG())
      }
    }
  } catch (err) {
    L('ERROR: ' + (err && err.stack ? err.stack : String(err)))
  } finally {
    // 测试往剪贴板写过东西，尽量还原，避免污染用户剪贴板
    try {
      if (prevClipText) await clipboard.writeText(prevClipText)
    } catch {
      /* 忽略 */
    }
    L('--- renderer console ---')
    for (const line of consoleLogs) L(line)
    fs.writeFileSync(path.join(dir, 'shot-log.txt'), log.join('\n'), 'utf8')
    app.quit()
  }
}

// ---------------- 生命周期 ----------------

app.whenReady().then(async () => {
  bindIpc()
  createWindow()
  await createTray()

  globalShortcut.register('Control+Alt+Space', toggleWindow)
  globalShortcut.register('Control+Alt+J', () => openJsonWindow(null))

  // 剪贴板随手取：不用先移鼠标到岛上
  globalShortcut.register('Control+Alt+V', grabFromTray)

  startClipboardWatch()
  cleanClipDir()

  screen.on('display-metrics-changed', () => {
    if (!win || win.isDestroyed()) return
    const { workArea } = screen.getPrimaryDisplay()
    const x = Math.round(workArea.x + (workArea.width - WIN_W) / 2)
    win.setPosition(x, workArea.y + 6)
  })

  if (DIAG) startDiag()
  if (SIM) startSim()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  stopCursorPolling()
  stopWatchdog()
  stopClipboardWatch()
  globalShortcut.unregisterAll()
})
