'use strict'

/**
 * 统一的 sharp 入口（必须从这里 require，不要直接 require('sharp')）。
 *
 * 踩过的坑：libvips 默认会缓存「最近打开的文件」，Windows 上这层缓存会把
 * 文件以映射方式持有。表现为：图片压缩完（尤其转成 WebP 后，复制到剪贴板
 * 需要再用 sharp 解码一次），产物就被 electron.exe 占住，资源管理器里删不掉，
 * 提示「文件已在 electron.exe 中打开」，而且不会自己恢复。
 *
 * files: 0 关掉这层文件缓存即可，内存缓存与操作缓存保持默认，压缩速度不受影响。
 * 实测：同一个 webp 用路径解码后，默认配置 unlink 报 EBUSY，files:0 下正常。
 */

const sharp = require('sharp')

sharp.cache({ files: 0 })

module.exports = sharp
