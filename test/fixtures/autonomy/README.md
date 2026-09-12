# Autonomy certification fixtures

Formato para incorporar casos reales de AutoFix de forma gradual.

## LEVEL 1 (CI)

Los golden cases deterministas viven en `src/certification/autonomy/golden-cases.ts`.
Usan JSON de visión ya parseado + mock pricing. Corren con `npm test`.

## LEVEL 2 (manual)

`npm run eval:autonomy:live` solo si existe `OPENAI_API_KEY`.

Ver `live/README.md`. El harness llama al modelo de visión de producción, parsea con `parseVisionModelJsonResponse` y recorre el Quote Engine. El JSON crudo se guarda en `live-artifacts/` para debug; no se convierte en golden.

No se envían mensajes a WhatsApp, no se crean citas, no se usa BD/catálogo de producción.

## Qué necesitamos para casos reales

1. Foto(s) del daño
2. JSON de visión validado por nosotros (o se captura en live eval)
3. Precios reales de catálogo / mercado acordados
4. Resultado semántico esperado (tratamiento, líneas, total, warnings)
