import { RestApiAdapter } from '../adapters/rest-api.mjs';

function success(value) { return { stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 }; }
function failure(error, code = 2) { return { stdout: '', stderr: error.message, exitCode: code }; }

export function register({ bash, commands, defineCommand }) {
  const adapter = new RestApiAdapter();
  const request = defineCommand('api-request', async (args) => {
    try {
      const confirmed = args[0] === '--confirm';
      const offset = confirmed ? 1 : 0;
      const method = args[offset];
      const path = args[offset + 1];
      if (!method || !path) throw new Error('Usage: api-request [--confirm] <method> <relative-path> [json-body]');
      const rawBody = args.slice(offset + 2).join(' ');
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      return success(await adapter.request(method, path, body, { confirm: confirmed }));
    } catch (error) {
      return failure(error, error.message.startsWith('Confirmation required') ? 4 : 2);
    }
  });
  bash.registerCommand(request);
  commands.set('api-request', { source: 'adapters/rest-api.mjs', mutating: true, requiresConfirmation: true });
}
