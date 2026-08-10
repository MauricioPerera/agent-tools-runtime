// Skill: encuentra un objeto en una imagen por descripción y devuelve su
// bounding box en píxeles. Equivalente de grounding en
// QwenLM/Qwen-MM-Plugins, contra Ollama. Verificado en vivo dos veces antes
// de escribir esto (no asumido): (1) imagen 200x200 con un solo círculo rojo
// -- el modelo devolvió {30,30,170,170}, exacto contra el box real; (2)
// imagen 300x300 con un círculo rojo Y un cuadrado azul, pidiendo
// específicamente el azul -- devolvió {180,150,255,225} contra el real
// {180,150,260,230}, discriminó la forma correcta y erró por ≤5px por lado.
// gemma4:cloud tiende a envolver el JSON en un fence ```json aunque se le
// pida explícitamente que no lo haga -- extractJson lo pela como red de
// seguridad, no confía en que el prompt alcance solo.
import { chatText, DEFAULT_VISION_MODEL } from './_shared.mjs';

function groundingPrompt(target, width, height) {
  return `The image is ${width}x${height} pixels. Find: ${target}. Output ONLY a JSON object with the bounding box in pixel coordinates, no other text, no markdown, no code fence: {"x_min": int, "y_min": int, "x_max": int, "y_max": int}. If it is not visible in the image, output exactly: {"found": false}`;
}

function extractJson(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(stripped); } catch { return null; }
}

export const meta = {
  description: 'Encuentra un objeto en una imagen por descripción libre y devuelve su bounding box en píxeles ({x_min, y_min, x_max, y_max}), o {found:false} si no aparece. Requiere las dimensiones REALES de la imagen (width/height) para que las coordenadas devueltas tengan escala, y un modelo con capability "vision".',
  args: 'image (base64 puro, requerido), target (string, requerido -- qué buscar, ej. "the red circle"), width/height (number, requeridos -- dimensiones reales en píxeles), model? (default "gemma4:cloud"), confirm:true (requerido -- muta cómputo real).',
};

export async function run(adapter, args) {
  const image = args?.image;
  const target = args?.target;
  const width = args?.width;
  const height = args?.height;
  if (!image) return { isError: true, error: 'grounding requires: image (base64 string)' };
  if (!target) return { isError: true, error: 'grounding requires: target (string, what to find)' };
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { isError: true, error: 'grounding requires: width and height (numbers, the real pixel dimensions of the image) -- without them the model has no scale to report coordinates against' };
  }
  if (args?.confirm !== true) {
    return { isError: true, error: 'Confirmation required: pass confirm: true (this skill runs a real, billable/timed model call).' };
  }
  const model = args?.model || DEFAULT_VISION_MODEL;

  const result = await chatText(adapter, model, groundingPrompt(target, width, height), image);
  if (result.isError) return result;

  const parsed = extractJson(result.text);
  if (!parsed) return { isError: true, error: 'model did not return parseable JSON', raw: result.text };
  if (parsed.found === false) return { isError: false, found: false, target };

  const { x_min, y_min, x_max, y_max } = parsed;
  if (![x_min, y_min, x_max, y_max].every(Number.isFinite)) {
    return { isError: true, error: 'model returned JSON but not all four bounding-box fields were numbers', raw: parsed };
  }
  return { isError: false, found: true, target, box: { x_min, y_min, x_max, y_max } };
}
