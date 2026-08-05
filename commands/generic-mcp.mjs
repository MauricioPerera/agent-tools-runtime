import { GenericMcpAdapter } from '../adapters/generic-mcp.mjs';

function result(value) { return { stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 }; }
function failure(error) { return { stdout: '', stderr: error.message, exitCode: 2 }; }

export function register({ bash, commands, defineCommand }) {
  const adapter = new GenericMcpAdapter();
  const search = defineCommand('mcp-search', async (args) => { try { return result(await adapter.search(args.join(' '))); } catch (error) { return failure(error); } });
  const describe = defineCommand('mcp-describe', async (args) => { try { return result(await adapter.describe(args[0])); } catch (error) { return failure(error); } });
  const call = defineCommand('mcp-call', async (args) => {
    try {
      if (!args[0] || !args[1]) throw new Error('Usage: mcp-call [--confirm] <tool-name> <json-arguments>');
      const confirmed = args[0] === '--confirm';
      if (!confirmed) return { stdout: '', stderr: 'Generic MCP calls require explicit --confirm until a provider read-only policy is configured', exitCode: 4 };
      return result(await adapter.call(args[1], JSON.parse(args.slice(2).join(' '))));
    } catch (error) { return failure(error); }
  });
  bash.registerCommand(search); bash.registerCommand(describe); bash.registerCommand(call);
  commands.set('mcp-search', { source: 'adapters/generic-mcp.mjs', mutating: false });
  commands.set('mcp-describe', { source: 'adapters/generic-mcp.mjs', mutating: false });
  commands.set('mcp-call', { source: 'adapters/generic-mcp.mjs', mutating: true, requiresConfirmation: true });
}
