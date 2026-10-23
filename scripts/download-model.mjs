import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const repo = 'intfloat/multilingual-e5-small'
const base = `https://modelscope.cn/models/${repo}/resolve/master/`
const root = process.env.LOCALMIND_MODELS_DIR || join(process.env.APPDATA || process.cwd(), 'LocalMind', 'models')
const dir = join(root, 'multilingual-e5-small-ca456c06b3a9')
const modelId = 'e5-small-onnx-fp32:ca456c06b3a9:384:e5-v1'
const files = [
  ['onnx/model.onnx', 470268510, 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665'],
  ['tokenizer.json', 17082730, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'],
  ['config.json', 655, '69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959'],
  ['tokenizer_config.json', 443, 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'],
  ['special_tokens_map.json', 167, 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7'],
  ['onnx/config.json', 653, 'bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6']
]
const total = files.reduce((sum, file) => sum + file[1], 0)

async function size(path) {
  try { return (await stat(path)).size } catch { return 0 }
}

async function hash(path) {
  const h = createHash('sha256')
  const handle = await open(path, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      h.update(buffer.subarray(0, bytesRead))
    }
  } finally { await handle.close() }
  return h.digest('hex')
}

await mkdir(join(dir, 'onnx'), { recursive: true })
let done = 0
for (const [remote, expectedSize, expectedHash] of files) {
  const finalPath = join(dir, remote)
  const partPath = `${finalPath}.part`
  if (await size(finalPath) === expectedSize) {
    done += expectedSize
    console.log(`skip ${remote}`)
    continue
  }
  let offset = await size(partPath)
  if (offset >= expectedSize) offset = 0
  if (offset === 0) await writeFile(partPath, Buffer.alloc(0))
  console.log(`download ${remote} from ${offset}`)
  const response = await fetch(base + remote, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!response.ok) throw new Error(`${remote} HTTP ${response.status}`)
  const append = offset > 0 && response.status === 206
  if (!append) offset = 0
  const handle = await open(partPath, append ? 'a' : 'w')
  let written = offset
  try {
    if (!response.body) throw new Error('no body')
    for await (const chunk of response.body) {
      await handle.write(chunk)
      written += chunk.byteLength
      const pct = ((done + written) / total * 100).toFixed(1)
      if (Math.floor(pct) % 5 === 0) process.stdout.write(`\r${pct}% ${remote}`)
    }
  } finally { await handle.close() }
  if (written !== expectedSize) throw new Error(`${remote} size ${written}/${expectedSize}`)
  const actualHash = await hash(partPath)
  if (actualHash !== expectedHash) throw new Error(`${remote} sha256 mismatch ${actualHash}`)
  await rename(partPath, finalPath)
  done += expectedSize
  console.log(`\nok ${remote}`)
}
await writeFile(join(dir, '.installed.json'), JSON.stringify({
  modelId,
  installedAt: new Date().toISOString(),
  files: files.map(([local, sizeValue, sha256]) => ({ local, size: sizeValue, sha256 }))
}, null, 2))
console.log(`\nMODEL READY ${dir}`)
