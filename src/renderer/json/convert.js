'use strict'

/**
 * JSON 互转实现（纯前端，无依赖）
 * 目标格式：JSON / YAML / CSV / XML
 */

;(function () {
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  }

  function yamlScalar(v) {
    if (v === null || v === undefined) return 'null'
    if (v === true) return 'true'
    if (v === false) return 'false'
    if (typeof v === 'number') return String(v)
    const s = String(v)
    if (s === '') return "''"
    // 含特殊字符或像数字/布尔/空值的字符串一律加引号，避免歧义
    if (
      /^[\s]|[\s]$/.test(s) ||
      /[:#\-?,[\]{}&*!|>'"%@`\n]/.test(s) ||
      /^(true|false|null|~|-?\d)/.test(s)
    ) {
      return JSON.stringify(s)
    }
    return s
  }

  function toYaml(value, indent) {
    const pad = ' '.repeat(indent)

    if (Array.isArray(value)) {
      if (value.length === 0) return `${pad}[]`
      return value
        .map((item) => {
          if (isPlainObject(item) || Array.isArray(item)) {
            const empty = Array.isArray(item) ? item.length === 0 : Object.keys(item).length === 0
            if (empty) return `${pad}- ${Array.isArray(item) ? '[]' : '{}'}`
            const body = toYaml(item, indent + 2)
            return `${pad}- ${body.slice(indent + 2)}`
          }
          return `${pad}- ${yamlScalar(item)}`
        })
        .join('\n')
    }

    if (isPlainObject(value)) {
      const keys = Object.keys(value)
      if (keys.length === 0) return `${pad}{}`
      return keys
        .map((k) => {
          const v = value[k]
          if (isPlainObject(v) || Array.isArray(v)) {
            const empty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0
            if (empty) return `${pad}${k}: ${Array.isArray(v) ? '[]' : '{}'}`
            return `${pad}${k}:\n${toYaml(v, indent + 2)}`
          }
          return `${pad}${k}: ${yamlScalar(v)}`
        })
        .join('\n')
    }

    return pad + yamlScalar(value)
  }

  function csvCell(v) {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  function pickRows(data) {
    if (Array.isArray(data)) return data
    // 常见的 API 响应结构 { title, items: [...] }：直接把那个数组当成表格
    if (isPlainObject(data)) {
      const arrKeys = Object.keys(data).filter(
        (k) => Array.isArray(data[k]) && data[k].length > 0 && isPlainObject(data[k][0])
      )
      if (arrKeys.length === 1) return data[arrKeys[0]]
    }
    return [data]
  }

  function toCsv(data) {
    const rows = pickRows(data)
    const objs = rows.filter(isPlainObject)
    if (objs.length === 0) {
      throw new Error('CSV 需要数组，元素为对象，例如 [{"a":1},{"a":2}]')
    }
    if (!Array.isArray(rows)) {
      throw new Error('顶层对象里没有可展开的对象数组')
    }
    const cols = []
    for (const o of objs) {
      for (const k of Object.keys(o)) if (!cols.includes(k)) cols.push(k)
    }
    const lines = [cols.map(csvCell).join(',')]
    for (const o of objs) lines.push(cols.map((c) => csvCell(o[c])).join(','))
    return lines.join('\n')
  }

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  function safeTag(name) {
    const t = String(name).replace(/[^\w\-.:]/g, '_')
    return /^[A-Za-z_]/.test(t) ? t : `_${t}`
  }

  function toXml(data) {
    function walk(v, name, indent) {
      const pad = '  '.repeat(indent)
      const tag = safeTag(name)

      if (Array.isArray(v)) {
        if (v.length === 0) return `${pad}<${tag}/>`
        return v.map((item) => walk(item, name, indent)).join('\n')
      }
      if (isPlainObject(v)) {
        const keys = Object.keys(v)
        if (keys.length === 0) return `${pad}<${tag}/>`
        const inner = keys.map((k) => walk(v[k], k, indent + 1)).join('\n')
        return `${pad}<${tag}>\n${inner}\n${pad}</${tag}>`
      }
      return `${pad}<${tag}>${xmlEscape(v === null ? '' : v)}</${tag}>`
    }

    return ['<?xml version="1.0" encoding="UTF-8"?>', walk(data, 'root', 0)].join('\n')
  }

  window.converters = { toYaml, toCsv, toXml }
})()
