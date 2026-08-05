import { LocalCliAdapter } from '../adapters/local-cli.mjs';

export function register({ bash, commands, defineCommand }) {
  const adapter = new LocalCliAdapter();
  const command = defineCommand('cli-run', async (args) => {
    const confirmed = args[0] === '--confirm';
    const offset = confirmed ? 1 : 0;
    const program = args[offset];
    if (!program) return { stdout: '', stderr: 'Usage: cli-run --confirm <allowlisted-program> [args...]', exitCode: 2 };
    try { return await adapter.run(program, args.slice(offset + 1), { confirm: confirmed }); }
    catch (error) { return { stdout: '', stderr: error.message, exitCode: error.message.startsWith('Confirmation required') ? 4 : 2 }; }
  });
  bash.registerCommand(command);
  commands.set('cli-run', { source: 'adapters/local-cli.mjs', mutating: true, requiresConfirmation: true });
}
