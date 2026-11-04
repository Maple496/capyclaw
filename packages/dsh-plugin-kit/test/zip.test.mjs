/** zip 单一真源测试：写→读回环、Buffer/路径双形态、坏 ZIP 报错。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZipFromDir, listZipEntries, listZipEntryNames, readZipEntryBuffer } from '../src/zip.mjs'

test('写→读回环：store 模式产物可被同一读取器解出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-rt-'))
  try {
    fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'package.json'), '{"name":"x"}')
    fs.writeFileSync(path.join(dir, 'src', 'lib', 'host.mjs'), 'export const a = 1\n')
    const zipFile = path.join(dir, 'out.zip')
    const files = writeZipFromDir(path.join(dir, 'src'), zipFile)
    assert.deepEqual(files, ['lib/host.mjs', 'package.json'])
    assert.deepEqual(listZipEntries(zipFile), ['lib/host.mjs', 'package.json'])
    // 路径形态读取
    assert.equal(readZipEntryBuffer(zipFile, 'package.json').toString(), '{"name":"x"}')
    // Buffer 形态读取（远端源路径）
    const bytes = fs.readFileSync(zipFile)
    assert.deepEqual(listZipEntryNames(bytes), ['lib/host.mjs', 'package.json'])
    assert.equal(readZipEntryBuffer(bytes, 'lib/host.mjs').toString(), 'export const a = 1\n')
    assert.equal(readZipEntryBuffer(bytes, 'missing.txt'), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('坏 ZIP 与非 store 条目：明确报错', () => {
  assert.throws(() => listZipEntryNames(Buffer.from('not a zip')), /不是有效的 ZIP/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-bad-'))
  try {
    const zipFile = path.join(dir, 'x.zip')
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'hi')
    writeZipFromDir(path.join(dir, 'src'), zipFile)
    // 篡改中央目录的压缩方式字段（中央头 0x02014b50，method 在 +10；中央目录为读取权威）
    const bytes = fs.readFileSync(zipFile)
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes.readUInt32LE(i) === 0x02014b50) {
        bytes.writeUInt16LE(99, i + 10)
        break
      }
    }
    fs.writeFileSync(path.join(dir, 'bad.zip'), bytes)
    assert.throws(() => readZipEntryBuffer(path.join(dir, 'bad.zip'), 'a.txt'), /不支持的 ZIP 压缩方式/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CRC-32 与标准实现一致（"hello" → 0x3610a686，消费端解压可校验）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-crc-'))
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'hello.txt'), 'hello')
    const zipFile = path.join(dir, 'crc.zip')
    writeZipFromDir(path.join(dir, 'src'), zipFile)
    const bytes = fs.readFileSync(zipFile)
    let found = false
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes.readUInt32LE(i) === 0x04034b50) {
        assert.equal(bytes.readUInt32LE(i + 14), 0x3610a686, 'local header CRC 必须是标准 CRC-32')
        found = true
        break
      }
    }
    assert.ok(found, '应找到本地文件头')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
