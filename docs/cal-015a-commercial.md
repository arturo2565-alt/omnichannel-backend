# CAL-015A — cotización comercial de pintura

Registro privado de baños de pintura y cambios de color. No es un expediente visual: no usa `CalibrationEngine`, no escribe `data/index.json` y no exige fotografías. La ingesta pública sigue apagada y sin módulo.

El archivo vive en `arturo2565-alt/pegazuz-calibration-data`:

```text
data/commercial/index.json
data/commercial/quotes/CQ-######.json
```

`CQ-######` no comparte espacio con `AF-######`. Una cotización escrita no se modifica. Otra observación de la misma oportunidad usa otra `source_case_key`, la misma `opportunity_key` y `prior_quote_id` igual a la cabeza actual. El índice cuenta oportunidades, no versiones.

## Precios

Cada precio tiene su propia validación. El cotizado es obligatorio y `human_confirmed`. El contratado y el cobrado quedan `not_provided` con importe nulo cuando el operador no los declara. Un importe sin validación se rechaza. El cobrado no se copia del cotizado.

Una revisión es una observación completa. Para agregar el contratado o el cobrado hay que volver a declarar los precios que siguen autorizados. El archivo anterior permanece.

## Alcance

`exterior_bath` no admite hojalatería ni color solicitado. `bath_with_bodywork` exige `bodywork` en `work_scope` y no admite color solicitado. `color_change` exige color solicitado. El alcance solo guarda `bodywork`, `disassembly` e `interior_frames`. Un trabajo que no esté en esa lista no se anota y no se toma del catálogo. El archivo ordena el alcance alfabéticamente.

Marca, modelo, año y versión se guardan solo con evidencia `customer_provided`. Si no se conocen, el valor es nulo y la evidencia es `unknown`. No hay `visual_inference`.

## Comando

```text
npm run import:commercial-quote -- cotizacion.json
```

El comando compilado es `node dist/calibration/commercial-quote-import-run.js`. No abre un endpoint. Exige el entorno de staging, `CALIBRATION_INGEST_ENABLED=false` y `DB_SYNCHRONIZE=false`. Rechaza cualquier campo de imagen, un enlace simbólico y un archivo de más de 64 KiB.

## Ejemplo de entrada

```json
{
  "schema_version": "1.0.0",
  "status": "human_verified",
  "source": {
    "kind": "autofix_human_commercial_quote",
    "source_case_key": "autofix-comercial-20261113-exterior-001",
    "opportunity_key": "autofix-oportunidad-20261113-exterior-001",
    "prior_quote_id": null,
    "quoted_at": null
  },
  "vehicle": {
    "make": "Mazda",
    "make_evidence": "customer_provided",
    "model": "3",
    "model_evidence": "customer_provided",
    "year": 2019,
    "year_evidence": "customer_provided",
    "variant": "Sedan",
    "variant_evidence": "customer_provided"
  },
  "service": "exterior_bath",
  "colors": {
    "current": null,
    "current_evidence": "unknown",
    "requested": null,
    "requested_evidence": "unknown"
  },
  "work_scope": [],
  "prices": {
    "quoted": { "amount_mxn": 28000, "validation": "human_confirmed" }
  }
}
```

## Ejemplo de salida del comando

```json
{
  "service": "commercial-quote-import",
  "result": "ok",
  "status": "created",
  "quoteId": "CQ-000001",
  "sourceKey": "autofix-comercial-20261113-exterior-001",
  "opportunityKey": "autofix-oportunidad-20261113-exterior-001",
  "revision": 1,
  "opportunityCount": 1,
  "quoteCount": 1
}
```

La misma entrada responde `already_exists`. La misma clave con otro precio responde `conflict` y no crea otro `CQ`. El repetido no cambia `recorded_at`.

El archivo `CQ-000001.json` agrega `quote_id`, `revision`, `recorded_at` y los precios no declarados:

```json
{
  "prices": {
    "quoted": { "amount_mxn": 28000, "validation": "human_confirmed" },
    "contracted": { "amount_mxn": null, "validation": "not_provided" },
    "collected": { "amount_mxn": null, "validation": "not_provided" }
  }
}
```

Una revisión del cotizado a 30000 MXN, con otra clave y `prior_quote_id` `CQ-000001`, crea `CQ-000002`. La oportunidad sigue siendo una. `CQ-000001` permanece en 28000.
