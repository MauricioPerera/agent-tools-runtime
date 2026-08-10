// Skill: pregunta libre sobre una imagen (visión general), el equivalente de
// vision_chat en QwenLM/Qwen-MM-Plugins pero contra Ollama en vez de la API
// de DashScope de Qwen. Verificado en vivo contra gemma4:cloud
// (capabilities: [completion, thinking, tools, vision]) con una imagen
// sintética (círculo rojo, borde negro, texto "CAT" en azul) -- describió
// color, forma y texto correctamente.
import { chatText, DEFAULT_VISION_MODEL } from './_shared.mjs';

export const meta = {
  description: 'Responde una pregunta libre sobre una imagen (visión general: qué hay, describir, comparar, contar objetos, etc.). Requiere un modelo con capability "vision" (ver list_models) -- con uno sin esa capability, Ollama ignora la imagen en silencio y contesta solo con el texto.',
  args: 'image (base64 puro, sin el prefijo "data:image/...;base64,", requerido), question (string, requerido), model? (default "gemma4:cloud"), confirm:true (requerido -- muta cómputo real).',
};

export async function run(adapter, args) {
  const image = args?.image;
  const question = args?.question;
  if (!image) return { isError: true, error: 'vision_chat requires: image (base64 string)' };
  if (!question) return { isError: true, error: 'vision_chat requires: question (string)' };
  if (args?.confirm !== true) {
    return { isError: true, error: 'Confirmation required: pass confirm: true (this skill runs a real, billable/timed model call).' };
  }
  const model = args?.model || DEFAULT_VISION_MODEL;

  const result = await chatText(adapter, model, question, image);
  if (result.isError) return result;
  return { isError: false, model, answer: result.text };
}
