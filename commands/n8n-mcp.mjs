import { N8nMcpAdapter } from '../adapters/n8n-mcp.mjs';

function emit(value) {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 };
}

export function register({ bash, commands, defineCommand }) {
  const adapter = new N8nMcpAdapter();
  const readOnlyTools = new Set(['search_workflows', 'get_workflow_details', 'get_workflow_history', 'get_workflow_version', 'search_executions', 'get_execution', 'search_nodes', 'get_node_types', 'get_workflow_best_practices', 'explore_node_resources', 'validate_workflow', 'validate_node_config', 'get_sdk_reference', 'list_credentials', 'list_tags', 'search_projects', 'search_folders']);
  const search = defineCommand('n8n-search', async (args) => {
    try { return emit(await adapter.search(args.join(' '))); }
    catch (error) { return { stdout: '', stderr: error.message, exitCode: 2 }; }
  });
  const auth = defineCommand('n8n-auth-status', async () => {
    try { return emit(await adapter.authStatus()); }
    catch (error) { return { stdout: '', stderr: error.message, exitCode: 2 }; }
  });
  const describe = defineCommand('n8n-describe', async (args) => {
    try { return emit(await adapter.describe(args[0])); }
    catch (error) { return { stdout: '', stderr: error.message, exitCode: 2 }; }
  });
  const call = defineCommand('n8n-call', async (args) => {
    try {
      const confirmed = args[0] === '--confirm';
      const toolName = confirmed ? args[1] : args[0];
      const jsonStart = confirmed ? 2 : 1;
      if (!toolName || !args[jsonStart]) throw new Error('Usage: n8n-call [--confirm] <tool-name> <json-arguments>');
      if (!readOnlyTools.has(toolName) && !confirmed) return { stdout: '', stderr: `Confirmation required for mutating n8n tool: ${toolName}`, exitCode: 4 };
      return emit(await adapter.call(toolName, JSON.parse(args.slice(jsonStart).join(' '))));
    } catch (error) { return { stdout: '', stderr: error.message, exitCode: 2 }; }
  });
  bash.registerCommand(search);
  bash.registerCommand(auth);
  bash.registerCommand(describe);
  bash.registerCommand(call);
  commands.set('n8n-search', { source: 'adapters/n8n-mcp.mjs', mutating: false });
  commands.set('n8n-auth-status', { source: 'adapters/n8n-oauth.mjs', mutating: false });
  commands.set('n8n-describe', { source: 'adapters/n8n-mcp.mjs', mutating: false });
  commands.set('n8n-call', { source: 'adapters/n8n-mcp.mjs', mutating: true, requiresConfirmation: true, readOnlyTools: [...readOnlyTools] });
}
