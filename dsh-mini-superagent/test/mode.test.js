/**
 * 派发模式的判定与切换。
 *
 * 这是「不派发 / 派发」开关的语义核心：只要目标不是「不派发」，
 * 会话就进入必派发模式。判定错了，模型就会在本会话里直接干活。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { AUTO, MODE_ALWAYS, MODE_OFF, NONE } from '../src/constants.js'

/** 复刻 Dispatch.modeOf 的判定（纯函数，不需要构造整个 Dispatch）。 */
function modeOf(targets, sessionId) {
  const target = targets.get(sessionId)
  if (!target) return MODE_OFF
  if (target.auto) return MODE_ALWAYS
  if (target.workspace_id) return MODE_ALWAYS
  return MODE_OFF
}

test('没有目标 = 不派发（默认）', () => {
  assert.equal(modeOf(new Map(), 's1'), MODE_OFF)
})

test('目标是具体工作区 = 必派发', () => {
  const targets = new Map([['s1', { workspace_id: 'w-1', title: '项目 A', path: 'C:\\a' }]])
  assert.equal(modeOf(targets, 's1'), MODE_ALWAYS)
})

test('目标是自动 = 必派发', () => {
  const targets = new Map([['s1', { auto: true, title: '自动选择', path: '' }]])
  assert.equal(modeOf(targets, 's1'), MODE_ALWAYS)
})

test('目标只有标题没有 id 也不算派发（防御脏数据）', () => {
  const targets = new Map([['s1', { title: '坏数据', path: '' }]])
  assert.equal(modeOf(targets, 's1'), MODE_OFF)
})

test('每个会话的判定互相独立', () => {
  const targets = new Map([
    ['s1', { workspace_id: 'w-1' }],
    ['s2', { auto: true }],
  ])
  assert.equal(modeOf(targets, 's1'), MODE_ALWAYS)
  assert.equal(modeOf(targets, 's2'), MODE_ALWAYS)
  assert.equal(modeOf(targets, 's3'), MODE_OFF)
})

test('常量值符合约定', () => {
  assert.equal(AUTO, 'auto')
  assert.equal(NONE, 'none')
  assert.equal(MODE_OFF, 'off')
  assert.equal(MODE_ALWAYS, 'always')
})
