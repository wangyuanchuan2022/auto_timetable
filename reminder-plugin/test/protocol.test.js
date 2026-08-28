// 协议与启动解析测试（node:test）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTOCOL_VERSION,
  HelperMessageKind,
  HelperReplyKind,
  createMessage,
  encodeMessage,
  parseReply,
} from '../src/protocol.js'
import { defaultLaunch, defaultHelperPath } from '../src/helper-process.js'
import { existsSync } from 'node:fs'

test('协议常量为稳定字符串', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.equal(HelperMessageKind.PING, 'ping')
  assert.equal(HelperMessageKind.SHUTDOWN, 'shutdown')
  assert.equal(HelperReplyKind.READY, 'ready')
  assert.equal(HelperReplyKind.CLOSED, 'closed')
})

test('createMessage/encodeMessage 可被 helper 端 JSON 解析', () => {
  const msg = createMessage(HelperMessageKind.CONFIG, { hotkey: 'ctrl+f5', leadMinutes: [30, 10] })
  assert.equal(msg.protocolVersion, 1)
  assert.equal(msg.kind, 'config')
  assert.equal(typeof msg.timestamp, 'number')
  const line = encodeMessage(msg)
  assert.ok(line.endsWith('\n'))
  const parsed = JSON.parse(line)
  assert.equal(parsed.hotkey, 'ctrl+f5')
  assert.deepEqual(parsed.leadMinutes, [30, 10])
})

test('parseReply 校验协议版本与 kind', () => {
  assert.equal(parseReply('{"protocolVersion":1,"kind":"pong"}').kind, 'pong')
  assert.throws(() => parseReply('{"protocolVersion":2,"kind":"pong"}'), /unsupported protocol version/)
  assert.throws(() => parseReply('{"protocolVersion":1}'), /missing kind/)
})

test('默认启动解析指向存在的 helper.py', () => {
  const launch = defaultLaunch()
  assert.ok(launch.command)
  assert.equal(launch.args[launch.args.length - 1], defaultHelperPath)
  assert.ok(existsSync(defaultHelperPath))
})

test('插件入口可加载（含 schemastery 依赖解析）', async () => {
  const mod = await import('../src/index.js')
  assert.equal(mod.name, 'dsh-timetable-reminder')
  assert.deepEqual(mod.inject, ['settings'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.Config, 'function') // schemastery Schema 为构造函数
  assert.equal(typeof mod.HelperProcess, 'function')
})
