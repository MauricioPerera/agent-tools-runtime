// Skill determinista: junta get_repository + list_issues + get_latest_commit
// en una sola llamada, mismo patron que insert-and-verify-datatable-row del
// plugin de n8n (sin generar codigo, solo colapsar orquestacion).

function extractContentJson(mcpResult) {
  const text = mcpResult?.content?.[0]?.text;
  if (typeof text !== 'string') return mcpResult;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function run(adapter, args) {
  const owner = args?.owner;
  const repo = args?.repo;
  if (!owner || !repo) return { isError: true, error: 'repo-overview requires: owner, repo' };

  try {
    const [repoInfo, openIssues, latestCommit] = await Promise.all([
      adapter.call('get_repository', { owner, repo }).then(extractContentJson),
      adapter.call('list_issues', { owner, repo, state: 'open' }).then(extractContentJson),
      adapter.call('get_latest_commit', { owner, repo }).then(extractContentJson),
    ]);
    return {
      isError: false,
      repository: repoInfo,
      openIssueCount: Array.isArray(openIssues) ? openIssues.length : null,
      latestCommit,
    };
  } catch (e) {
    return { isError: true, error: e.message };
  }
}
