// Skill determinista: crea un record y lo confirma leyéndolo de vuelta.
// Mismo patrón que insert-and-verify-task (plugin tasks) e
// insert-and-verify-datatable-row (plugin n8n): create + read directos, sin
// capa de workflow ni codegen de por medio.

export const meta = {
  description: 'Crea un record en una colección de PocketBase y lo confirma leyéndolo de vuelta.',
  args: 'collection, data (objeto con los campos del record) -- requeridos.',
};

function extractContentJson(mcpResult) {
  const text = mcpResult?.content?.[0]?.text;
  if (typeof text !== 'string') return mcpResult;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function run(adapter, args) {
  const collection = args?.collection;
  const data = args?.data;
  if (!collection || !data || typeof data !== 'object') {
    return { isError: true, error: 'insert-and-verify-record requires: collection (string), data (object)' };
  }

  let created;
  try {
    created = await adapter.call('create_record', { collection, data }).then(extractContentJson);
  } catch (e) {
    return { isError: true, stage: 'create', error: e.message };
  }
  if (!created?.id) {
    return { isError: true, stage: 'create', error: 'create_record did not return an id', raw: created };
  }

  let verified;
  try {
    verified = await adapter.call('get_record', { collection, id: created.id }).then(extractContentJson);
  } catch (e) {
    return { isError: true, stage: 'verify', error: e.message, recordId: created.id };
  }

  // Encontrado en vivo probando esto contra la colección real "users":
  // PocketBase nunca devuelve password/passwordConfirm/oldPassword al leer
  // un record de una auth collection (write-only por diseño, aunque el
  // create haya salido bien) -- compararlos contra el valor escrito siempre
  // da falso, aunque el record se haya creado y leído correctamente. Se
  // excluyen de la verificación por default en vez de reportar un
  // "confirmed:false" que no refleja ningún problema real.
  const PB_WRITE_ONLY_FIELD_PATTERN = /password/i;
  const comparableEntries = Object.entries(data).filter(([key]) => !PB_WRITE_ONLY_FIELD_PATTERN.test(key));
  const confirmed = comparableEntries.every(([key, value]) => JSON.stringify(verified?.[key]) === JSON.stringify(value));
  return {
    isError: !confirmed,
    confirmed,
    collection,
    recordId: created.id,
    written: data,
    read: verified,
  };
}
