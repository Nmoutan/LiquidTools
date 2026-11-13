'use strict'

/**
 * 任务队列
 *
 * 串行执行：图片压缩 / 视频转码都是重 IO + 重 CPU，
 * 并行只会让所有任务的进度都变慢，用户体验更差。
 */

const registry = require('./tools/registry')

let seq = 0

class JobQueue {
  /**
   * @param {(job: object) => void} onUpdate
   */
  constructor(onUpdate) {
    /** @type {object[]} */
    this.jobs = []
    this.running = false
    this.onUpdate = onUpdate
  }

  snapshot() {
    return this.jobs.map((j) => ({
      id: j.id,
      title: j.title,
      toolName: j.toolName,
      status: j.status,
      progress: j.progress,
      message: j.message,
      summary: j.summary,
      items: j.items || [],
      error: j.error
    }))
  }

  push(job) {
    this.jobs.push(job)
    this.emit(job)
    this.pump()
    return job
  }

  emit(job) {
    this.onUpdate({
      id: job.id,
      title: job.title,
      toolName: job.toolName,
      status: job.status,
      progress: job.progress,
      message: job.message,
      summary: job.summary,
      items: job.items || [],
      error: job.error
    })
  }

  cancel(jobId) {
    const job = this.jobs.find((j) => j.id === jobId)
    if (!job) return
    job.cancelled = true
    if (job.status === 'queued') {
      job.status = 'cancelled'
      this.emit(job)
      return
    }
    // 通知正在执行的工具（ffmpeg 这类外部进程需要主动 kill）
    for (const cb of job.cancelHandlers || []) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'running')
    this.onUpdate(null)
  }

  async pump() {
    if (this.running) return
    const job = this.jobs.find((j) => j.status === 'queued')
    if (!job) return

    this.running = true
    job.status = 'running'
    this.emit(job)

    try {
      const tool = registry.get(job.toolId)
      if (!tool) throw new Error(`未知工具：${job.toolId}`)

      job.cancelHandlers = []
      const result = await tool.run(job.payload, {
        options: job.options,
        isCancelled: () => job.cancelled === true,
        onCancel: (cb) => {
          if (job.cancelled) cb()
          else job.cancelHandlers.push(cb)
        },
        progress: (ratio, message) => {
          job.progress = Math.max(0, Math.min(1, ratio))
          job.message = message || ''
          this.emit(job)
        }
      })

      job.status = job.cancelled ? 'cancelled' : 'done'
      job.progress = 1
      job.summary = result?.summary || ''
      job.items = result?.items || []
      job.text = result?.text
    } catch (err) {
      job.status = 'error'
      job.error = err.message
    } finally {
      this.running = false
      this.emit(job)
      setImmediate(() => this.pump())
    }
  }
}

function createJob({ tool, payload, options, title }) {
  seq += 1
  return {
    id: `job-${seq}`,
    toolId: tool.id,
    toolName: tool.name,
    title: title || tool.name,
    payload,
    options: options || {},
    status: 'queued',
    progress: 0,
    message: '',
    summary: '',
    items: [],
    cancelled: false
  }
}

module.exports = { JobQueue, createJob }
