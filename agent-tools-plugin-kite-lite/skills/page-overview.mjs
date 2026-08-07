// Skill determinista: navega la sesion persistente a una URL y opcionalmente
// la screenshotea, en una sola llamada -- mismo patron que repo-overview del
// plugin de github (junta 2 tool-calls que casi siempre se piden juntas).

function extractContentJson(mcpResult) {
  const text = mcpResult?.content?.[0]?.text;
  if (typeof text !== 'string') return mcpResult;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function run(adapter, args) {
  const url = args?.url;
  const withScreenshot = args?.screenshot !== false;
  const format = args?.format === 'svg' ? 'svg' : 'png';
  if (!url) return { isError: true, error: 'page-overview requires: url' };

  try {
    const navResult = await adapter.call('browser_navigate', { url });
    const page = extractContentJson(navResult);
    // kite-lite marca isError:true en su respuesta MCP cruda cuando la
    // navegacion falla (DNS, conexion, etc.) -- extractContentJson() solo
    // desenvuelve el content[0].text y lo pierde, así que hay que chequearlo
    // acá antes de reportar éxito. Bug real: sin este chequeo, un fetch
    // fallido (ej. dominio inexistente) volvía isError:false con el mensaje
    // de error de kite-lite metido adentro de page.raw, como si fuera un
    // resumen de página válido.
    if (navResult?.isError) return { isError: true, error: page?.raw || JSON.stringify(page) };
    if (!withScreenshot) return { isError: false, page };

    const shotResult = await adapter.call('browser_screenshot', { format });
    const shot = extractContentJson(shotResult);
    if (shotResult?.isError) return { isError: true, error: shot?.raw || JSON.stringify(shot), page };
    return { isError: false, page, screenshot: shot };
  } catch (e) {
    return { isError: true, error: e.message };
  }
}
