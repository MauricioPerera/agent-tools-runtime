// Separa "qué falló" (el mensaje de error, ya suele ser específico) de "qué
// hacer" (la receta) -- mismo patrón que rule-hints.py del repo hermano KDD
// (github.com/MauricioPerera/KDD, knowledge/contracts/rule-hints.md): "los
// gates reportan QUÉ falló, no QUÉ HACER; un humano lo deduce, un agente
// efímero llega en frío y tantea". Encontrado en vivo el costo real de la
// diferencia: el mismo error generico ("Unknown skill: undefined") le tomó a
// un modelo 6 reintentos idénticos antes de corregirse solo; un error
// específico ("Argumentos anidados de más: recibí...") le tomó 1.
//
// Alcance a propósito: solo los errores que el RUNTIME mismo emite (mismos
// para cualquier plugin), no los que cada skill arma a mano en su propio
// código -- esos ya suelen nombrar el campo/valor exacto en el momento
// (ver audit-workflows.mjs), y no hay una receta genérica útil para un error
// que ya es específico. Mismo criterio que rule-hints.py: no enriquece gates
// que reenvían salida ajena (acá, lo que devuelve el adapter o `skill.run()`
// -- ese texto es del backend, no una "regla" nuestra con receta fija).
export const FALLBACK_HINT = 'No hay receta específica para este código todavía -- revisá el mensaje de error completo y el schema de la tool/skill que llamaste.';

export const HINTS = {
  MISSING_TOOL_NAME: 'Pasá "toolName" con el nombre exacto de la tool (ver agent_tools_<prefix>_discover para la lista), al mismo nivel que "arguments" en el objeto de arguments de esta llamada.',
  UNKNOWN_TOOL: 'El nombre de tool no existe en este plugin. Llamá agent_tools_<prefix>_discover({query}) para buscarlo por texto, o sin query para listar los más comunes -- no lo inventes ni lo copies de otro plugin.',
  ARG_VALIDATION_FAILED: 'Mirá el array "details" de esta misma respuesta: nombra el campo exacto que falta o el tipo que no matchea. Corregí solo eso, no reconstruyas la llamada entera.',
  CONFIRM_REQUIRED: 'Esta tool muta estado. Repetí la misma llamada agregando "confirm": true al mismo nivel que "toolName"/"arguments" -- no hace falta cambiar nada más.',
  UNKNOWN_SKILL: 'El nombre de skill no existe en este plugin. Revisá "Skills disponibles" en esta misma respuesta, o llamá agent_tools_<prefix>_discover({query}) con una palabra de la tarea para encontrar la skill correcta y sus argumentos reales.',
  UNKNOWN_FACADE_TOOL: 'El nombre de tool no coincide con ninguna de esta sesión. Llamá agent_tools_help() para ver los prefixes de los plugins cargados -- puede haber más de un plugin para el mismo dominio.',
  EMPTY_COMMAND: 'agent_tools_exec requiere "command" como string no vacío -- ej. "load commands/generic-mcp.mjs", "status", "list", o un comando real del adapter ya cargado.',
};

export function hintFor(code) {
  return HINTS[code] || FALLBACK_HINT;
}
