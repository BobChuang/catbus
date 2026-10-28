import { chmodSync } from 'node:fs'

// clean + tsc 会重建 bin 文件；保留 npm link 的命令入口在 Unix 上可执行。
if (process.platform !== 'win32') chmodSync(new URL('../dist/cli/main.js', import.meta.url), 0o755)
