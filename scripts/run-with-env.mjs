import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const [assignment, ...command] = process.argv.slice(2)
if (!assignment || !assignment.includes('=') || command.length === 0) {
  console.error('Usage: node scripts/run-with-env.mjs KEY=value command [...args]')
  process.exit(1)
}
const [key, ...rest] = assignment.split('=')
const env = { ...process.env, [key]: rest.join('=') }
delete env.ELECTRON_RUN_AS_NODE

const bin = process.platform === 'win32' ? `${command[0]}.cmd` : command[0]
const child = spawn(bin, command.slice(1), {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})
child.on('exit', (code) => process.exit(code ?? 0))
