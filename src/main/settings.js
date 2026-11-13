'use strict'

/**
 * 用户设置（目前只有产物位置）
 *
 * 存到 app.getPath('userData')/settings.json，纯手工读写，
 * 不引第三方库；写失败就只在本次运行里生效，绝不因为设置文件读不出来而崩溃。
 */

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

let cache = null

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

/**
 * 默认产物目录。
 * 剪贴板截图没有「源文件目录」可言，以前是直接丢桌面，桌面很快就乱；
 * 改成图片库下的独立文件夹，用户可以在岛底部右键改到别的盘。
 */
function defaultOutputDir() {
  let base
  try {
    base = app.getPath('pictures')
  } catch {
    base = app.getPath('desktop')
  }
  return path.join(base, 'waterTool')
}

function read() {
  if (cache) return cache
  const out = { outputDir: defaultOutputDir(), customOutput: false }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    if (raw && typeof raw.outputDir === 'string' && raw.outputDir.trim()) {
      out.outputDir = raw.outputDir
      // 只有用户真的点过「更换位置」才算自定义；
      // 没自定义时，拖进来的文件仍然写在源文件旁边
      out.customOutput = raw.customOutput === true
    }
  } catch {
    /* 第一次运行没有这个文件，用默认值 */
  }
  cache = out
  return cache
}

function write(patch) {
  cache = { ...read(), ...patch }
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    /* 写不进去就只在内存生效 */
  }
  return cache
}

function outputDir() {
  return read().outputDir
}

/** 用户是否指定过产物目录（指定过就所有产物都往那里放） */
function isCustom() {
  return read().customOutput === true
}

/**
 * 落盘前确保目录存在，并且真的可写：
 * 目录被用户手工删了、或者换了个没权限的盘，就回到默认目录，
 * 不能让 toFile 直接抛 ENOENT。
 */
function ensureOutputDir() {
  const dir = outputDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return dir
  } catch {
    /* 落到下面的兜底 */
  }
  const fallback = defaultOutputDir()
  try {
    fs.mkdirSync(fallback, { recursive: true })
    return fallback
  } catch {
    return app.getPath('temp')
  }
}

module.exports = { read, write, outputDir, isCustom, ensureOutputDir, defaultOutputDir, settingsPath }
