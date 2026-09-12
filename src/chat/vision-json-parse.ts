/**
 * Parser de JSON de visión usado en producción.
 * El harness live DEBE importar estas funciones; no duplicar.
 */

function stripMarkdownCodeFencesFromModelText(raw: string): string {
  let s = String(raw ?? '').trim();
  const fullFence = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/im;
  const m = fullFence.exec(s);
  if (m) return m[1].trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/gim, '');
  return s.trim();
}

export function extractLikelyJsonObjectSubstring(s: string): string {
  const t = stripMarkdownCodeFencesFromModelText(s);
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) return t.slice(first, last + 1).trim();
  return t;
}

export function parseVisionModelJsonResponse(
  rawText: string,
  context: string,
): unknown {
  const candidate = extractLikelyJsonObjectSubstring(rawText);
  try {
    return JSON.parse(candidate) as unknown;
  } catch (err) {
    console.error(
      `[Vision JSON ${context}] JSON.parse falló tras limpiar markdown/prosa. Error:`,
      err,
    );
    console.error(
      `[Vision JSON ${context}] Candidato (primeros 4000 chars):`,
      candidate.slice(0, 4000),
    );
    throw new Error(
      'La respuesta del modelo de visión no es JSON válido. Revisa la consola del servidor ("Respuesta cruda de Vision" y logs anteriores).',
    );
  }
}
