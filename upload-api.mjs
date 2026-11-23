// 用 GitHub API（绕过被污染的 git 协议）上传备份文件
// 用法: GH_TOKEN_B64=<base64token> node upload-api.mjs <repoDir> <owner/repo>
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const [repoDir, slug] = process.argv.slice(2)
const token = Buffer.from(process.env.GH_TOKEN_B64, 'base64').toString('utf8').trim()
const API = 'https://api.github.com'
// 沙箱里 %TEMP% 不可写 → payload 写到工作目录旁边
const tmp = join(repoDir, `.ghpayload-${process.pid}.json`)

// payload 走文件，避免 Windows 命令行长度限制
const gh = (method, path, body, retry = 3) => {
  const args = ['-s', '--noproxy', '*', '--max-time', '600', '-X', method,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: dsh-backup']
  if (body !== undefined) {
    writeFileSync(tmp, body, 'utf8')
    args.push('-H', 'Content-Type: application/json', '--data-binary', `@${tmp}`)
  }
  args.push(`${API}${path}`)
  let lastErr = ''
  for (let attempt = 1; attempt <= retry; attempt++) {
    try {
      const out = execFileSync('curl', args, { maxBuffer: 1024 * 1024 * 64, encoding: 'utf8' })
      return JSON.parse(out)
    } catch (e) {
      lastErr = `status=${e.status} sig=${e.signal} msg=${(e.message || '').slice(0, 200)} stderr=${(e.stderr || '').toString().slice(-200)}`
      if (attempt < retry) {
        console.log(`    重试 ${attempt}/${retry - 1} …`)
        execFileSync('sleep', ['3'])
      }
    }
  }
  throw new Error(`curl 失败 ${method} ${path}: ${lastErr}`)
}

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else files.push({ path: relative(repoDir, p).split(sep).join('/'), abs: p })
  }
}
walk(repoDir)
console.log(`待上传 ${files.length} 个文件`)

const entries = []
let done = 0
for (const f of files) {
  const content = readFileSync(f.abs).toString('base64')
  const r = gh('POST', `/repos/${slug}/git/blobs`, JSON.stringify({ content, encoding: 'base64' }))
  if (!r.sha) throw new Error(`blob 失败 ${f.path}: ${JSON.stringify(r).slice(0, 300)}`)
  entries.push({ path: f.path, mode: '100644', type: 'blob', sha: r.sha })
  done++
  if (done % 20 === 0) console.log(`  blob ${done}/${files.length}`)
}
console.log(`全部 blob 完成 (${done})`)

const tree = gh('POST', `/repos/${slug}/git/trees`, JSON.stringify({ tree: entries }))
if (!tree.sha) throw new Error('tree 失败: ' + JSON.stringify(tree).slice(0, 300))
console.log('tree sha =', tree.sha)

const ref = gh('GET', `/repos/${slug}/git/ref/heads/main`)
const commit = gh('POST', `/repos/${slug}/git/commits`,
  JSON.stringify({ message: `BT 搜索结果网页备份：${files.length} 个文件`, tree: tree.sha, parents: [ref.object.sha] }))
if (!commit.sha) throw new Error('commit 失败: ' + JSON.stringify(commit).slice(0, 300))
console.log('commit sha =', commit.sha)

gh('PATCH', `/repos/${slug}/git/refs/heads/main`,
  JSON.stringify({ sha: commit.sha, force: true }))
console.log('PUSH_OK')
