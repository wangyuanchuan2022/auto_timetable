// 与 runtime/helper.py 约定的 JSONL 协议（参考 dsh-dafeiyu protocol.js）
export const PROTOCOL_VERSION = 1

// 宿主 → helper
export const HelperMessageKind = {
  HELLO: 'hello',
  CONFIG: 'config',
  SHOW: 'show',
  HIDE: 'hide',
  PING: 'ping',
  SHUTDOWN: 'shutdown',
}

// helper → 宿主
export const HelperReplyKind = {
  READY: 'ready',
  PONG: 'pong',
  CLOSED: 'closed', // 用户主动退出：宿主收到后不再自动重启
  ERROR: 'error',
}

export function createMessage(kind, payload = {}) {
  return { protocolVersion: PROTOCOL_VERSION, kind, timestamp: Date.now(), ...payload }
}

export function encodeMessage(message) {
  return JSON.stringify(message) + '\n'
}

export function parseReply(line) {
  const reply = JSON.parse(line)
  if (reply?.protocolVersion !== PROTOCOL_VERSION) throw new Error('unsupported protocol version')
  if (typeof reply.kind !== 'string') throw new Error('reply missing kind')
  return reply
}
