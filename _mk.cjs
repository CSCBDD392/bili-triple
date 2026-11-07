const fs = require('node:fs')
const path = require('node:path')
const tok = fs.readFileSync(path.join(__dirname, '..', '.github-token'), 'utf8').trim()
const body = '# 本机运行时文件\n__pycache__/\n*.pyc\n_state/\nnode_modules/\n'
fetch('https://api.github.com/repos/CSCBDD392/bili-triple/contents/.gitignore', {
  method: 'PUT',
  headers: { Authorization: `token ${tok}`, 'User-Agent': 'dsh-push', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'chore: init repo with .gitignore', content: Buffer.from(body).toString('base64') }),
}).then(async (res) => console.log('init', res.status, (await res.text()).slice(0, 300)))
