'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jsonApi', {
  read: (filePath) => ipcRenderer.invoke('json:read', filePath),
  save: (filePath, text) => ipcRenderer.invoke('json:save', { filePath, text }),
  pickSavePath: () => ipcRenderer.invoke('json:pick'),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),

  // target: 文件路径字符串，或 { text, name }（剪贴板内容没有磁盘文件）
  onLoad: (cb) => {
    const fn = (_e, target) => cb(target)
    ipcRenderer.on('json:load', fn)
    return () => ipcRenderer.removeListener('json:load', fn)
  }
})
