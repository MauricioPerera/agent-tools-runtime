// Skill: extrae todo el texto visible de una imagen, verbatim. Equivalente
// de ocr en QwenLM/Qwen-MM-Plugins, contra Ollama. El prompt pide texto
// exacto y nada más -- probado en vivo, gemma4:cloud sí respeta "output only
// the text" sin envolver en comentario/markdown extra para casos simples.
import { chatText, DEFAULT_VISION_MODEL } from './_shared.mjs';

const OCR_PROMPT = 'Extract ALL text visible in this image, exactly as written, preserving line breaks and reading order. Output ONLY the extracted text -- no commentary, no markdown formatting, no quotes around it. If there is no text anywhere in the image, output exactly: (no text found)';

export const meta = {
  description: 'Extrae todo el texto visible de una imagen, tal cual está escrito (sin resumir ni corregir). Requiere un modelo con capability "vision".',
  args: 'image (base64 puro, sin el prefijo "data:image/...;base64,", requerido), model? (default "gemma4:cloud"), confirm:true (requerido -- muta cómputo real).',
};

export async function run(adapter, args) {
  const image = args?.image;
  if (!image) return { isError: true, error: 'ocr requires: image (base64 string)' };
  if (args?.confirm !== true) {
    return { isError: true, error: 'Confirmation required: pass confirm: true (this skill runs a real, billable/timed model call).' };
  }
  const model = args?.model || DEFAULT_VISION_MODEL;

  const result = await chatText(adapter, model, OCR_PROMPT, image);
  if (result.isError) return result;
  const text = result.text.trim();
  return { isError: false, model, text: text === '(no text found)' ? '' : text };
}
