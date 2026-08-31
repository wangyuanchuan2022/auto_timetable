// dsh-timetable-reminder · DSH 插件宿主（参考 dsh-dafeiyu src/index.js 的结构）
// 职责：读取/监听设置，拉起并看护 Python helper 子进程，把配置以 JSONL 下发。
import { createRequire } from 'node:module'
import Schema from '@deepseek-ai/schemastery'
import { HelperProcess } from './helper-process.js'
import { HelperMessageKind, createMessage } from './protocol.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

export const name = 'dsh-timetable-reminder'
export const inject = ['settings']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用当日日程提醒'),
  dataPath: Schema.string().default('D:/tools/auto_timetable/schedule.json').description('日程数据文件（schedule.json，可外部编辑）'),
  hotkey: Schema.string().default('ctrl+alt+t').description('全局快捷键（如 ctrl+alt+t，全局生效，切换主窗口显隐）'),
  leadMinutes: Schema.array(Schema.number()).default([30, 10]).description('提醒提前分钟数（每条日程每个点各提醒一次）'),
  showOnStart: Schema.boolean().default(false).description('DSH 启动时显示主窗口（默认无头：仅驻留提醒弹窗，Ctrl+Alt+T 或弹窗按钮唤出）'),
}).description('当日日程提醒：主窗口 + 提前弹窗 + 全局快捷键')

const defaults = Object.freeze({
  enabled: true,
  dataPath: 'D:/tools/auto_timetable/schedule.json',
  hotkey: 'ctrl+alt+t',
  leadMinutes: [30, 10],
  showOnStart: false,
})

function publicConfig(config = {}) {
  const leads = Array.isArray(config.leadMinutes) ? config.leadMinutes.filter((n) => n > 0) : []
  return {
    enabled: config.enabled ?? defaults.enabled,
    dataPath: config.dataPath ?? defaults.dataPath,
    hotkey: config.hotkey ?? defaults.hotkey,
    leadMinutes: leads.length ? leads : [...defaults.leadMinutes],
    showOnStart: config.showOnStart ?? defaults.showOnStart,
  }
}

function localSettingsScope(value) {
  return { get: () => value, watch: () => () => {} }
}

function mount(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const base = publicConfig(config)
  const settings = ctx.settings?.register?.('dsh-timetable-reminder', Config, {
    base,
    applies: 'live',
  }) ?? localSettingsScope(base)

  let bridge
  let restartTimer

  const configMessage = (next) => createMessage(HelperMessageKind.CONFIG, {
    dataPath: next.dataPath,
    hotkey: next.hotkey,
    leadMinutes: next.leadMinutes,
    showOnStart: next.showOnStart,
  })

  const stopRuntime = (reason = 'settings-change') => {
    bridge?.stop(reason)
    bridge = undefined
  }

  const startRuntime = (resolved) => {
    if (resolved.enabled === false) {
      logger.info?.('dsh-timetable-reminder is disabled')
      return
    }
    bridge = new HelperProcess({}, logger)
    bridge.start()
    bridge.send(createMessage(HelperMessageKind.HELLO, {
      host: 'deepseek-harness',
      pluginVersion: pkg.version,
      message: 'timetable reminder connected',
    }))
    bridge.send(configMessage(resolved))
    logger.info?.('dsh-timetable-reminder helper bridge started')
  }

  const scheduleRestart = (next) => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      stopRuntime('settings-change')
      startRuntime(next)
    }, 400)
    restartTimer.unref?.()
  }

  startRuntime(settings.get())

  const unwatch = settings.watch((next) => {
    const resolved = publicConfig(next)
    if (resolved.enabled === false) {
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined }
      stopRuntime('settings-change')
      return
    }
    if (!bridge) {
      scheduleRestart(resolved)
      return
    }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined }
    // 数据文件 / 快捷键 / 提前分钟数 / 启动显示均支持实时下发，无需重启 helper
    bridge.send(configMessage(resolved))
  })

  ctx.effect(() => () => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = undefined
    unwatch()
    stopRuntime('dsh-host-stop')
  })
}

export function apply(ctx, config = {}) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => mount(settingsCtx, config, ctx))
    return
  }
  mount(ctx, config)
}

export { HelperProcess }
