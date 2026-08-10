// Helper compartido por las tres skills de visión (vision_chat/ocr/grounding):
// todas hacen exactamente lo mismo por dentro -- un chat de un solo mensaje
// con una imagen adjunta -- y solo cambia el prompt. Ver README del plugin
// para la verificación en vivo de por qué "gemma4:cloud" es el default.

export const DEFAULT_VISION_MODEL = 'gemma4:cloud';

/** Llama chat() del adapter con un solo mensaje de usuario (prompt + imagen)
 * y devuelve el texto de la respuesta ya extraído del envoltorio de
 * agent_tools_ollama_call. adapter: instancia de OllamaAdapter ya conectada. */
export async function chatText(adapter, model, prompt, imageBase64) {
  try {
    const result = await adapter.call('chat', {
      model,
      messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
    });
    const parsed = JSON.parse(result.content[0].text);
    const text = parsed?.message?.content;
    if (typeof text !== 'string') {
      return { isError: true, error: 'ollama chat response had no message.content', raw: parsed };
    }
    return { isError: false, text };
  } catch (e) {
    return { isError: true, error: e.message };
  }
}
