# LEVEL 2 — live vision fixtures

`npm run eval:autonomy:live`

Cada caso puede ser:

1. Entrada en `cases.json`, o
2. Carpeta `<caseId>/` con `case.json` + fotos (`jpg`/`png`/`webp`).

No hace falta incluir JSON de visión: el harness llama al modelo real y guarda el bruto en `test/fixtures/autonomy/live-artifacts/<caseId>.vision.json` solo para debug. Ese archivo no es golden truth.

## case.json / cases.json

```json
{
  "caseId": "autofix_real_001",
  "description": "Fascia delantera Mazda 3",
  "images": ["autofix_real_001.jpg"],
  "vehicleContext": "Mazda 3 2020",
  "banioCode": "BPE",
  "expected": {
    "treatments": ["SUSTITUIR"]
  }
}
```

`banioCode` BPEI/BPCC sin precio de catálogo marca `PRODUCT_CONFIGURATION_REQUIRED` (no es fallo de visión).

Side effects bloqueados: WhatsApp, Messenger, Twilio, citas, BD/catálogo productivos.
