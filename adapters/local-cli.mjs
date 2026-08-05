import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function allowlist() {
  return new Set((process.env.AGENT_CLI_ALLOWLIST || '').split(',').map((value) => value.trim()).filter(Boolean));
}
export class LocalCliAdapter {
  async run(program, args = [], { confirm = false } = {}) {
    if (!program || !allowlist().has(program)) throw new Error(`CLI program is not allowlisted: ${program || '<missing>'}`);
    if (!confirm) throw new Error(`Confirmation required for local CLI: ${program}`);
    try {
      const result = await execFileAsync(program, args, { shell: false, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 120_000, env: process.env });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || error.message };
    }
  }
}
