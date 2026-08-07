// Skill determinista: crea una task y confirma leyendola de vuelta. Mismo
// patron que insert-and-verify-datatable-row del plugin de n8n, pero contra
// una API propia sin capa de workflow de por medio (create + read directos).

function extractContentJson(mcpResult) {
  const text = mcpResult?.content?.[0]?.text;
  if (typeof text !== 'string') return mcpResult;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function run(adapter, args) {
  const title = args?.title;
  const done = Boolean(args?.done);
  if (!title || typeof title !== 'string') {
    return { isError: true, error: 'insert-and-verify-task requires: title (non-empty string)' };
  }

  let created;
  try {
    created = await adapter.call('create_task', { title, done }).then(extractContentJson);
  } catch (e) {
    return { isError: true, stage: 'create', error: e.message };
  }
  if (!created?.id) {
    return { isError: true, stage: 'create', error: 'create_task did not return a task id' };
  }

  let verified;
  try {
    verified = await adapter.call('get_task', { id: created.id }).then(extractContentJson);
  } catch (e) {
    return { isError: true, stage: 'verify', error: e.message, taskId: created.id };
  }

  const confirmed = verified?.title === title && Boolean(verified?.done) === done;
  return {
    isError: !confirmed,
    confirmed,
    taskId: created.id,
    written: { title, done },
    read: verified,
  };
}
