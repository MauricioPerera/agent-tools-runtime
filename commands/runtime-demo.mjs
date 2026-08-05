export function register({ bash, commands, defineCommand }) {
  const command = defineCommand('runtime-echo', async (args) => ({
    stdout: `${args.join(' ')}\n`,
    stderr: '',
    exitCode: 0,
  }));
  bash.registerCommand(command);
  commands.set('runtime-echo', { source: 'runtime-demo.mjs', mutating: false });
}
