// Skill determinista: junta repo_view + issue_list + pr_list en una sola
// llamada -- mismo patrón de "colapsar orquestación" que repo-overview del
// plugin REST de github, pero acá vía CLI. A diferencia del REST, `gh --json`
// ya devuelve JSON limpio y tipado -- no hay que adivinar la forma del
// payload como con extractContentJson en los demás adapters.

export const meta = {
  description: 'Junta repo_view + issue_list + pr_list de gh CLI en una sola llamada: metadata del repo, cantidad de issues y PRs abiertos.',
  args: 'owner, repo (requeridos).',
};

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
    const [repository, openIssues, openPRs] = await Promise.all([
      adapter.call('repo_view', { owner, repo }).then(extractContentJson),
      adapter.call('issue_list', { owner, repo, state: 'open' }).then(extractContentJson),
      adapter.call('pr_list', { owner, repo, state: 'open' }).then(extractContentJson),
    ]);
    return {
      isError: false,
      repository,
      openIssueCount: Array.isArray(openIssues) ? openIssues.length : null,
      openPRCount: Array.isArray(openPRs) ? openPRs.length : null,
    };
  } catch (e) {
    return { isError: true, error: e.message };
  }
}
