// Python helper 子进程桥接（移植自 dsh-dafeiyu src/helper-process.js，按需精简）
// - stdin/stdout 按行交换 JSON（协议版本 1）
// - READY 后开始心跳（PING/PONG），超时或意外退出自动重启（最多 5 次失败）
// - helper 回报 CLOSED（用户主动退出）后不再重启
// - stdin 关闭即 helper 退出：生命周期完全由 DSH 插件宿主持有
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  HelperMessageKind,
  HelperReplyKind,
  PROTOCOL_VERSION,
  createMessage,
  encodeMessage,
} from './protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const defaultHelperPath = resolve(here, '..', 'runtime', 'helper.py')

// ---- 子进程 env 白名单：不继承宿主全量环境（宿主供应商密钥等凭据不下传）。
// 基础运行变量走白名单；协议必需的 DSH_TTR_* 前缀变量（DSH_TTR_DATA /
// DSH_TTR_HOTKEY / DSH_TTR_SHOW_ON_START / DSH_TTR_TEST_TOAST 等）逐前缀挑选透传。
const ENV_WHITELIST = ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'DSH_PORT', 'DSH_API_URL', 'NODE_ENV', 'LANG']
function filteredChildEnv(extra = {}) {
  const env = {}
  for (const key of ENV_WHITELIST) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DSH_TTR_')) env[key] = process.env[key]
  }
  return { ...env, ...extra } // options.env 为调用方显式指定，允许覆盖
}

export function defaultLaunch() {
  // Windows 优先使用 py 启动器；可用 DSH_TTR_PYTHON 指定解释器
  const pythonEnv = process.env.DSH_TTR_PYTHON
  if (pythonEnv) return { command: pythonEnv, args: [defaultHelperPath] }
  if (process.platform === 'win32') return { command: 'py', args: ['-3', defaultHelperPath] }
  return { command: 'python3', args: [defaultHelperPath] }
}

export class HelperProcess {
  constructor(options = {}, logger = console) {
    this.options = options
    this.logger = logger
    this.child = undefined
    this.queue = []
    this.snapshot = new Map()
    this.spawned = false
    this.hasEverSpawned = false
    this.stopping = false
    this.restartSuppressed = false
    this.startFailures = 0
    this.restartTimer = undefined
    this.heartbeatTimer = undefined
    this.startupTimer = undefined
    this.lastPongAt = 0
  }

  start() {
    if (this.child || this.stopping || this.restartSuppressed) return this.child
    let child
    try {
      const helperPath = this.options.helperPath || defaultHelperPath
      const launch = this.options.command
        ? { command: this.options.command, args: [helperPath] }
        : defaultLaunch()
      if (!existsSync(helperPath)) throw new Error(`helper not found: ${helperPath}`)
      child = spawn(launch.command, [...launch.args], {
        cwd: this.options.cwd || resolve(here, '..'),
        env: filteredChildEnv(this.options.env), // 白名单 + DSH_TTR_*，不继承宿主全量环境
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.child = undefined
      this.spawned = false
      this.logger.error?.(`dsh-timetable-reminder helper failed to start: ${error.message}`)
      if (!this.stopping && !this.restartSuppressed) this.#countStartFailure(`launch error: ${error.message}`)
      return undefined
    }
    this.child = child
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    child.once('spawn', () => {
      const startupTimeoutMs = this.options.startupTimeoutMs ?? 30000
      this.startupTimer = setTimeout(() => {
        if (this.child === child && !this.spawned) {
          this.logger.warn?.('dsh-timetable-reminder helper readiness timed out')
          child.kill()
        }
      }, startupTimeoutMs)
      this.startupTimer.unref?.()
    })
    child.once('error', (error) => {
      this.logger.error?.(`dsh-timetable-reminder helper failed to start: ${error.message}`)
      if (this.child !== child) return
      this.child = undefined
      this.spawned = false
      this.#clearHeartbeat()
      this.#clearStartupTimer()
      if (!this.stopping && !this.restartSuppressed) this.#countStartFailure(`spawn error: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      const wasReady = this.spawned
      this.spawned = false
      this.#clearHeartbeat()
      this.#clearStartupTimer()
      if (!this.stopping && !this.restartSuppressed) {
        if (!wasReady) {
          this.#countStartFailure(`exited before ready (code=${String(code)}, signal=${String(signal)})`)
          return
        }
        this.logger.warn?.(`dsh-timetable-reminder helper exited (code=${String(code)}); restarting`)
        this.#scheduleRestart()
      }
    })
    createInterface({ input: child.stdout }).on('line', (line) => this.#handleReply(line))
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) this.logger.warn?.(`dsh-timetable-reminder: ${line}`)
    })
    return child
  }

  send(message) {
    this.#remember(message)
    const line = encodeMessage(message)
    if (!this.child || !this.spawned || !this.child.stdin.writable || this.child.stdin.destroyed) {
      if (!this.hasEverSpawned) this.queue.push(line)
      return
    }
    this.child.stdin.write(line)
  }

  stop(reason = 'plugin-disposed') {
    this.stopping = true
    this.#clearHeartbeat()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const child = this.child
    if (!child) return
    this.queue.push(encodeMessage(createMessage(HelperMessageKind.SHUTDOWN, { reason })))
    if (this.spawned) {
      this.#flushQueue()
      if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end()
    }
    const timer = setTimeout(() => {
      if (this.child === child) child.kill()
    }, this.options.shutdownTimeoutMs ?? 10000)
    timer.unref?.()
  }

  #remember(message) {
    if (message.kind === HelperMessageKind.HELLO) this.snapshot.set('hello', encodeMessage(message))
    if (message.kind === HelperMessageKind.CONFIG) this.snapshot.set('config', encodeMessage(message))
  }

  #flushSnapshot() {
    const child = this.child
    if (!this.spawned || !child?.stdin.writable || child.stdin.destroyed) return
    const payload = [...this.snapshot.values()].join('')
    if (payload) child.stdin.write(payload)
  }

  #flushQueue() {
    const child = this.child
    if (!this.spawned || !child?.stdin.writable || child.stdin.destroyed) return
    const payload = this.queue.splice(0).join('')
    if (payload) child.stdin.write(payload)
  }

  #handleReply(line) {
    if (!line.trim()) return
    try {
      const reply = JSON.parse(line)
      if (reply?.protocolVersion === PROTOCOL_VERSION && reply.kind === HelperReplyKind.READY) {
        if (this.spawned) return
        const firstSpawn = !this.hasEverSpawned
        this.hasEverSpawned = true
        this.spawned = true
        this.startFailures = 0
        this.lastPongAt = Date.now()
        this.#clearStartupTimer()
        if (firstSpawn) this.#flushQueue()
        else { this.#flushSnapshot(); this.#flushQueue() }
        this.#startHeartbeat()
        if (this.stopping && this.child) this.child.stdin.end()
        return
      }
      if (reply?.protocolVersion === PROTOCOL_VERSION && reply.kind === HelperReplyKind.PONG) {
        this.lastPongAt = Date.now()
        return
      }
      if (reply?.protocolVersion === PROTOCOL_VERSION && reply.kind === HelperReplyKind.CLOSED) {
        this.restartSuppressed = true
        return
      }
    } catch {
      // 非协议输出仅作调试日志
    }
    this.logger.debug?.(`dsh-timetable-reminder: ${line}`)
  }

  #startHeartbeat() {
    const heartbeatMs = this.options.heartbeatMs ?? 5000
    if (heartbeatMs <= 0) return
    const timeoutMs = this.options.heartbeatTimeoutMs ?? Math.max(heartbeatMs * 3, 12000)
    this.heartbeatTimer = setInterval(() => {
      const child = this.child
      if (!child || !this.spawned) return
      if (Date.now() - this.lastPongAt > timeoutMs) {
        this.logger.warn?.('dsh-timetable-reminder helper heartbeat timed out')
        child.kill()
        return
      }
      this.send(createMessage(HelperMessageKind.PING))
    }, heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  #clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  #clearStartupTimer() {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  #countStartFailure(reason) {
    this.startFailures += 1
    const maxFailures = this.options.maxStartFailures ?? 5
    if (this.startFailures >= maxFailures) {
      this.restartSuppressed = true
      this.logger.error?.(`dsh-timetable-reminder helper failed to start ${this.startFailures} times; giving up (${reason})`)
      return
    }
    this.logger.warn?.(`dsh-timetable-reminder helper failed to start; scheduling restart (${this.startFailures}/${maxFailures}) (${reason})`)
    this.#scheduleRestart()
  }

  #scheduleRestart() {
    if (this.restartTimer || this.stopping || this.restartSuppressed) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.start()
    }, this.options.restartDelayMs ?? 750)
    this.restartTimer.unref?.()
  }
}

export { defaultHelperPath }
