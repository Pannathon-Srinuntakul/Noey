/**
 * Upload the just-built Windows installer to the S3-compatible release bucket
 * so the web app's download button always serves the latest build.
 *
 * Reads S3 credentials from ../../backend/.env (same bucket the API's
 * /releases/desktop/windows endpoint reads from — see packages/video/s3.py
 * and services/api/routers/releases.py) so credentials live in one place.
 *
 * Run from desktop/app (chained onto `npm run build:win`):
 *   node scripts/upload-release.mjs
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const backendEnvPath = resolve(appDir, '../../backend/.env')

function log(msg) {
  console.log(`[upload-release] ${msg}`)
}

function parseEnv(path) {
  const vars = {}
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
  return vars
}

function findInstaller() {
  const distDir = join(appDir, 'dist')
  const candidates = readdirSync(distDir)
    .filter((f) => f.endsWith('-setup.exe'))
    .map((f) => ({ name: f, path: join(distDir, f), mtime: statSync(join(distDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (candidates.length === 0) {
    throw new Error(`no *-setup.exe found in ${distDir} — run npm run build:win first`)
  }
  return candidates[0]
}

async function main() {
  const env = parseEnv(backendEnvPath)
  const bucket = env.S3_BUCKET
  const endpoint = env.S3_ENDPOINT_URL
  const region = env.S3_REGION || 'auto'
  const accessKeyId = env.S3_ACCESS_KEY_ID
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    log('S3_* vars not set in backend/.env — skipping upload (installer still built locally)')
    return
  }

  const installer = findInstaller()
  const sizeMb = (statSync(installer.path).size / 1_048_576).toFixed(1)
  log(`uploading ${installer.name} (${sizeMb} MB)…`)

  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false
  })

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: 'releases/desktop/noey-video-edit-setup.exe',
      Body: readFileSync(installer.path)
    })
  )

  log('done — live at GET /releases/desktop/windows')
}

main().catch((err) => {
  console.error(`[upload-release] failed: ${err.message}`)
  process.exit(1)
})
