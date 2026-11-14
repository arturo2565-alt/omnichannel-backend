# CAL-017A — cotización textual de reparación

Registro privado de reparaciones cotizadas por texto, sin fotografías. No es un expediente visual y no es una cotización de pintura integral. No usa `CalibrationEngine`, no escribe `data/index.json` ni `data/commercial/`, y no crea identificadores `AF` ni `CQ`. La ingesta pública sigue apagada y sin módulo.

El archivo vive en `arturo2565-alt/pegazuz-calibration-data`, con la misma GitHub App:

```text
data/repairs/index.json
data/repairs/quotes/RQ-######.json
```

`RQ-######` no comparte espacio con `AF-######` ni con `CQ-######`. Una cotización escrita no se modifica. Otra observación de la misma oportunidad usa otra `source_case_key`, la misma `opportunity_key` y `prior_quote_id` igual a la cabeza actual. El índice cuenta oportunidades, no versiones.

La cotización humana del Aveo 2026 sigue pendiente. Este contrato no la registra. Los ejemplos usan la misma estructura con claves sintéticas.

## Evidencia

`evidence` es `text_only` y `photo_status` es `not_provided`. Cero fotografías es válido. Cualquier campo `images`, `photos` o `photo_refs` se rechaza, también dentro de una partida. No hay diagnóstico visual ni `visual_inference`.

Marca, modelo, año y versión se guardan solo con evidencia `customer_provided`. Si no se conocen, el valor es nulo y la evidencia es `unknown`.

## Partidas

Cada partida tiene un papel: `part` para la refacción o `labor` para la mano de obra. La refacción no lleva tratamiento. La mano de obra admite solo `mount_and_paint`, `paint` y `repair`. `mount_and_paint` es montaje y pintura de este contrato; no es un tratamiento del expediente visual y no sustituye el precio de la refacción.

La misma pieza puede repetirse con papeles distintos. La misma pieza con el mismo papel y el mismo tratamiento se rechaza, para no sumar dos veces el mismo importe. Cada partida tiene su cotizado, su contratado y su cobrado. El cotizado es obligatorio y `human_confirmed`. El contratado y el cobrado quedan `not_provided` con importe nulo cuando no se declaran. El cobrado no se copia del cotizado.

`quoted_total_mxn` tiene que ser la suma de los cotizados. Si el declarado no coincide, no hay escritura. Contratado y cobrado no entran en ese total.

Las condiciones son frases declaradas. No se infieren daños ni datos del vehículo.

## Revisiones

Para agregar el contratado o el cobrado hay que crear otra observación y volver a declarar las partidas que siguen autorizadas. El archivo anterior permanece. La misma clave y el mismo contenido responden `already_exists` y no cambian `recorded_at`. La misma clave con otro contenido responde `conflict` y no crea otro `RQ`.

Una fotografía posterior sería un expediente `AF` nuevo. Este contrato no adjunta imágenes ni edita el `RQ` original.

## Comando

```text
npm run import:repair-quote -- cotizacion.json
```

El comando compilado es `node dist/calibration/repair-quote-import-run.js`. No abre un endpoint. Exige el entorno de staging, `CALIBRATION_INGEST_ENABLED=false` y `DB_SYNCHRONIZE=false`. Rechaza un enlace simbólico y un archivo de más de 64 KiB.

## Ejemplo sintético

```json
{
  "schema_version": "1.0.0",
  "status": "human_verified",
  "evidence": "text_only",
  "photo_status": "not_provided",
  "source": {
    "kind": "autofix_human_repair_quote",
    "source_case_key": "sintetico-textual-fascia-001",
    "opportunity_key": "sintetico-oportunidad-fascia-001",
    "prior_quote_id": null,
    "quoted_at": null
  },
  "vehicle": {
    "make": null,
    "make_evidence": "unknown",
    "model": "Aveo",
    "model_evidence": "customer_provided",
    "year": 2026,
    "year_evidence": "customer_provided",
    "variant": null,
    "variant_evidence": "unknown"
  },
  "lines": [
    {
      "line_id": "L01",
      "part": "fascia delantera",
      "role": "part",
      "labor": null,
      "prices": {
        "quoted": { "amount_mxn": 2900, "validation": "human_confirmed" }
      }
    },
    {
      "line_id": "L02",
      "part": "fascia delantera",
      "role": "labor",
      "labor": "mount_and_paint",
      "prices": {
        "quoted": { "amount_mxn": 3400, "validation": "human_confirmed" }
      }
    }
  ],
  "quoted_total_mxn": 6300,
  "conditions": [
    "Tiempo estimado de 3 a 4 dias habiles, sujeto a disponibilidad de la refaccion."
  ]
}
```

## Ejemplo de salida del comando

```json
{
  "service": "repair-quote-import",
  "result": "ok",
  "status": "created",
  "quoteId": "RQ-000001",
  "sourceKey": "sintetico-textual-fascia-001",
  "opportunityKey": "sintetico-oportunidad-fascia-001",
  "revision": 1,
  "opportunityCount": 1,
  "quoteCount": 1
}
```

El archivo agrega `quote_id`, `revision`, `recorded_at` y los precios no declarados en cada partida. Una revisión con otra clave y `prior_quote_id` `RQ-000001` crea `RQ-000002`. La oportunidad sigue siendo una. `RQ-000001` permanece sin contratado ni cobrado.
