'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 把拖入的 File 对象转成真实磁盘路径（Electron 32+ 已移除 File.path）
  getPathForFile: (file) => webUtils.getPathForFile(file),

  inspect: (paths) => ipcRenderer.invoke('payload:inspect', paths),
  startJob: (arg) => ipcRenderer.invoke('job:start', arg),
  // 预估产物大小（图片压缩用），改参数时实时刷新
  estimate: (arg) => ipcRenderer.invoke('tool:estimate', arg),
  snapshot: () => ipcRenderer.invoke('jobs:snapshot'),
  cancel: (id) => ipcRenderer.send('job:cancel', id),
  clearFinished: () => ipcRenderer.send('jobs:clear'),

  // 让主进程知道窗口里哪一块是"真"的（其余部分点击穿透）
  setHitRect: (rects) => ipcRenderer.send('hit-rect', rects),
  setIgnore: (ignore) => ipcRenderer.send('pointer:set-ignore', ignore),

  reveal: (p) => ipcRenderer.send('shell:reveal', p),
  quit: () => ipcRenderer.send('app:quit'),

  // 产物 → 剪贴板（图片是位图，视频是文件）
  copyPaths: (paths) => ipcRenderer.invoke('clip:copy', paths),
  // 以「剪切」形式放进去：粘贴到目标文件夹时源文件会被移走
  cutPaths: (paths) => ipcRenderer.invoke('clip:cut', paths),

  // 产物目录
  getOutputDir: () => ipcRenderer.invoke('settings:output'),
  pickOutputDir: () => ipcRenderer.invoke('settings:pick-output'),
  openOutputDir: () => ipcRenderer.send('shell:open-output'),

  // 打开 JSON 独立窗口（需要键盘输入，不能放在 focusable:false 的岛上）
  // target 可以是文件路径，或 { text, name } —— 剪贴板内容没有磁盘文件
  openJson: (target) => ipcRenderer.send('json:open', target || null),

  // 剪贴板：显式取一次 / 被动提示
  grabClipboard: () => ipcRenderer.invoke('clipboard:grab'),
  onClipboardOffer: (cb) => {
    const fn = (_e, data) => cb(data)
    ipcRenderer.on('clipboard:offer', fn)
    return () => ipcRenderer.removeListener('clipboard:offer', fn)
  },
  onClipboardResult: (cb) => {
    const fn = (_e, data) => cb(data)
    ipcRenderer.on('clipboard:result', fn)
    return () => ipcRenderer.removeListener('clipboard:result', fn)
  },

  // 桌面亮度：玻璃据此自适应浓度
  getBackdrop: () => ipcRenderer.invoke('theme:backdrop'),
  onBackdrop: (cb) => {
    const fn = (_e, data) => cb(data)
    ipcRenderer.on('theme:backdrop', fn)
    return () => ipcRenderer.removeListener('theme:backdrop', fn)
  },

  // 渲染进程心跳，用于诊断渲染层是否还活着
  reportBeat: (data) => ipcRenderer.send('diag:beat', data),

  onJobUpdate: (cb) => {
    const fn = (_e, job) => cb(job)
    ipcRenderer.on('jobs:update', fn)
    return () => ipcRenderer.removeListener('jobs:update', fn)
  },
  onJobsReplaced: (cb) => {
    const fn = (_e, list) => cb(list)
    ipcRenderer.on('jobs:replaced', fn)
    return () => ipcRenderer.removeListener('jobs:replaced', fn)
  },
  onPointerRegion: (cb) => {
    const fn = (_e, data) => cb(data)
    ipcRenderer.on('pointer:region', fn)
    return () => ipcRenderer.removeListener('pointer:region', fn)
  },
  /** 光标已进入本窗口：请主进程立刻收起穿透，别等轮询 */
  pointerProbe: () => ipcRenderer.send('pointer:probe')
})
