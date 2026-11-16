/**
 * 配置契约：Schemastery 在 apply 之前校验并填默认值。
 *
 * 这些断言钉三件事：
 * 1. 默认值只有一个事实源（`DEFAULTS`），schema 不另抄数字；
 * 2. 错配置 fail loud（类型、范围、未知枚举值）；
 * 3. 旧值 `workerWorkspace: 'target'` 仍可加载（0.8.1 及更早的配置）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Config } from '../src/index.js'
import { DEFAULTS } from '../src/constants.js'

test('Config 是 DSH 能识别的 Schemastery schema（有 marker / type / meta / toJSON）', () => {
  assert.equal(Config[Symbol.for('schemastery')], true)
  assert.equal(Config.type, 'object')
  assert.equal(typeof Config.toJSON, 'function')
  assert.equal(typeof Config.meta, 'object')
})

test('空配置按 DEFAULTS 填满所有字段', () => {
  const config = Config({})
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.deepEqual(config[key], value, `${key} 的默认值必须来自 DEFAULTS`)
  }
})

test('错配置 fail loud：范围、类型与枚举值', () => {
  assert.throws(() => Config({ maxWorkers: 0 }), /maxWorkers/)
  assert.throws(() => Config({ maxDependsOn: -1 }), /maxDependsOn/)
  assert.throws(() => Config({ retryBackoffMs: 'slow' }), /retryBackoffMs/)
  assert.throws(() => Config({ workerWorkspace: 'elsewhere' }), /workerWorkspace/)
  assert.throws(() => Config({ noticeMergeWindowMs: -1 }), /noticeMergeWindowMs/)
  assert.throws(() => Config({ maxTasksPerSession: 'many' }), /maxTasksPerSession/)
})

test('旧值 workerWorkspace=target 仍能通过（运行时按 day 处理）', () => {
  assert.equal(Config({ workerWorkspace: 'target' }).workerWorkspace, 'target')
})

test('未知键保留，不用 schema 把前向兼容字段吞掉', () => {
  const config = Config({ futureKnob: 42 })
  assert.equal(config.futureKnob, 42)
})
