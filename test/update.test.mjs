// 新版本提醒：挑能提醒的版本、认出插件是怎么装的
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { RELEASE_AGE_MS, compareVersions, installKind, installSpec, pickUpdate } = await import('../src/host/update.js')

const NOW = Date.parse('2026-11-28T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()

test('只提醒比现在新、发布满 24 小时、没弃用、不是预发布的最新版本', () => {
  const packument = {
    versions: {
      '0.5.3': {},
      '0.6.0': { lovideo: { whatsNew: { zh: '中英双语', en: 'English UI' } } },
      '0.6.1': {},
      '0.7.0-rc.1': {},
      '0.6.2': { deprecated: '有问题' },
    },
    time: {
      '0.5.3': ago(5 * RELEASE_AGE_MS),
      '0.6.0': ago(RELEASE_AGE_MS + 60_000),
      '0.6.1': ago(RELEASE_AGE_MS - 60_000), // 还没满 24 小时：桌面版装不到，不提醒
      '0.7.0-rc.1': ago(5 * RELEASE_AGE_MS),
      '0.6.2': ago(5 * RELEASE_AGE_MS),
    },
  }
  assert.deepEqual(pickUpdate(packument, '0.5.3', NOW), { version: '0.6.0', publishedAt: packument.time['0.6.0'], notes: { zh: '中英双语', en: 'English UI' } })
  assert.equal(pickUpdate(packument, '0.6.0', NOW), null)
  assert.equal(pickUpdate(packument, '0.6.1', NOW), null)
  assert.equal(pickUpdate({}, '0.5.3', NOW), null)
  assert.equal(compareVersions('0.10.0', '0.9.9') > 0, true)
  assert.equal(compareVersions('1.0.0-rc.1', '0.9.0'), null)
})

test('认出插件是怎么装的：npm 包名能一键更新，GitHub 和安装包地址不能，链接源码是开发模式', () => {
  assert.equal(installKind('0.5.3'), 'npm')
  assert.equal(installKind('^0.6.0'), 'npm')
  assert.equal(installKind('github:oceanz0312/dsh-lovideo#v0.6.0'), 'git')
  assert.equal(installKind('https://github.com/oceanz0312/dsh-lovideo'), 'git')
  assert.equal(installKind('git+https://github.com/oceanz0312/dsh-lovideo.git#abc'), 'git')
  assert.equal(installKind('https://registry.npmjs.org/dsh-lovideo/-/dsh-lovideo-0.6.0.tgz'), 'tarball')
  assert.equal(installKind('file:/tmp/dsh-lovideo-0.6.0.tgz'), 'tarball')
  assert.equal(installKind('link:/Users/me/dsh-lovideo'), 'dev')
  assert.equal(installKind(null), 'dev')
})

test('从插件目录往上找到 profile，读出它记的安装来源（两种 pnpm 布局都认）', () => {
  const profile = mkdtempSync(join(tmpdir(), 'lovideo-profile-'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-lovideo': 'github:oceanz0312/dsh-lovideo#v0.6.0' } }))
  const hoisted = join(profile, 'node_modules', 'dsh-lovideo')
  const isolated = join(profile, 'node_modules', '.pnpm', 'dsh-lovideo@0.6.0', 'node_modules', 'dsh-lovideo')
  mkdirSync(hoisted, { recursive: true })
  mkdirSync(isolated, { recursive: true })
  assert.equal(installSpec(hoisted, 'dsh-lovideo'), 'github:oceanz0312/dsh-lovideo#v0.6.0')
  assert.equal(installSpec(isolated, 'dsh-lovideo'), 'github:oceanz0312/dsh-lovideo#v0.6.0')
  assert.equal(installSpec(join(tmpdir(), 'no-such', 'dsh-lovideo'), 'dsh-lovideo'), null)
})
