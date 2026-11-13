'use strict'

/**
 * 工具注册表
 *
 * 核心约定：调度层和界面层永远不 import 具体工具。
 * 它们只认识 Payload -> registry.match(payload) -> 可用工具列表。
 * 新增工具 = 在本目录加一个文件并 register 一次，其余代码零改动。
 *
 * Payload 结构（所有输入源最终都归一化成这个）：
 *   { kind: 'files', paths: string[] }
 *   { kind: 'text',  text: string }
 */

const path = require('path')

/** @type {Map<string, any>} */
const tools = new Map()

/**
 * @param {object} tool
 * @param {string} tool.id
 * @param {string} tool.name
 * @param {string} tool.hint
 * @param {(payload: object) => boolean} tool.match
 * @param {(payload: object, ctx: object) => Promise<any>} tool.run
 */
function register(tool) {
  if (!tool || !tool.id) throw new Error('tool.id is required')
  if (typeof tool.match !== 'function') throw new Error(`${tool.id}: match() is required`)
  if (typeof tool.run !== 'function') throw new Error(`${tool.id}: run() is required`)
  if (tools.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`)
  tools.set(tool.id, tool)
  return tool
}

function list() {
  return Array.from(tools.values())
}

function get(id) {
  return tools.get(id) || null
}

/** 返回能处理该 payload 的工具（按 order 升序） */
function match(payload) {
  return list()
    .filter((tool) => {
      try {
        return tool.match(payload) === true
      } catch {
        return false
      }
    })
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

/** 给 UI 用的摘要信息，不含函数 */
function describe(payload) {
  return match(payload).map((t) => ({
    id: t.id,
    name: t.name,
    hint: t.hint || '',
    icon: t.icon || 'box',
    ui: t.ui || 'default',
    // 函数不能过 IPC，只透出一个标记：界面据此决定要不要显示「预估大小」这一行
    estimable: typeof t.estimate === 'function',
    options: t.options || []
  }))
}

// ---- 内置工具 ----
register(require('./image-compress'))
register(require('./video'))
register(require('./json-format'))

function extSet(list) {
  return new Set(list.map((e) => e.toLowerCase()))
}

module.exports = { register, list, get, match, describe, extSet, path }
