# CAL-011A — importación privada del primer caso humano

La ingesta pública permanece apagada. `CalibrationModule` no entra en la aplicación. Este comando compilado reutiliza el motor, el escritor real de GitHub y el archivo privado de Cloudinary con el prefijo `pegazuz_calibration`.

No escribe en `data/probes/`, no reutiliza los activos de CAL-008 ni CAL-010 y no modifica `AF-000001`.

## Entrada

Un archivo JSON local, junto a las fotografías JPEG, PNG o WEBP del expediente. CAL-013 sustituyó el máximo fijo de cuatro por un tope de seguridad configurable. El comando no acepta datos por HTTP.

```json
{
  "source_case_key": "autofix-2026-11-10-001",
  "quoted_at": null,
  "human_verified": true,
  "vehicle": {
    "make": "Mazda",
    "make_evidence": "customer_provided",
    "model": "3",
    "model_evidence": "customer_provided",
    "year": 2019,
    "year_evidence": "customer_provided",
    "variant": null
  },
  "line_items": [
    {
      "line_id": "L1",
      "part": "salpicadera delantera derecha",
      "treatment": "repair_paint",
      "price_mxn": 1250,
      "damage_severity": "unknown",
      "validation": "human_confirmed"
    }
  ],
  "visual_observations": [],
  "images": ["frente.jpg"]
}
```

`human_verified` debe ser exactamente `true` y cada línea debe traer `validation` igual a `human_confirmed` con un precio entero aprobado. Marca, modelo y año pueden omitirse solo con evidencia `unknown` y valor vacío. El archivo no debe incluir nombre, teléfono, correo, placa ni VIN. Cada fotografía es un nombre relativo dentro del mismo directorio del JSON. CAL-011B rechaza rutas absolutas, `..` y enlaces simbólicos. Una fotografía repetida se conserva una sola vez.

La clave de origen es la identidad de la operación. `probe-cal-009d-001`, `probe-cal-010-001` y cualquier clave que empiece por `probe-` se rechazan. La clave que ya apunta a `AF-000001` también se rechaza.

## Comando

```bash
npm run import:calibration-case -- /ruta/caso.json
```

Equivale a `node dist/calibration/calibration-import-run.js`. Exige el contenedor de staging ya usado por los diagnósticos, `CALIBRATION_INGEST_ENABLED=false` y `DB_SYNCHRONIZE=false`. Si el índice real sigue conteniendo solo `AF-000001`, el caso nuevo es `AF-000002`.

La salida es un JSON técnico: identificador, clave, estado, referencias `IMG-######` y conteos. No incluye la cotización, direcciones firmadas ni credenciales.

## Integridad

Antes de cualquier escritura se validan la cotización y cada imagen. El escritor real solo puede leer el índice, leer `AF-000001` y leer o crear `data/cases/AF-0#####.json` y `data/photos/AF-0#####/IMG-######.json`, nunca `AF-000001` ni `data/probes/`. La fotografía se sube con tipo autenticado bajo `pegazuz_calibration/AF-0#####/`. El manifiesto queda verificado solo cuando la descarga reproduce el SHA-256 original. La misma clave con la misma cotización y las mismas fotografías devuelve `already_exists` y no crea otro caso. Una clave con otra cotización detiene la operación. Si la subida o el manifiesto fallan, el caso queda en `pending_private_archive`; la siguiente ejecución de la misma clave completa ese caso y no asigna otro identificador.

## Procedimiento del primer caso real

Esta fase no lo ejecuta.

1. Confirmar `genesis/staging`, el servicio de staging y que la ingesta pública sigue en `false`.
2. Leer el índice real. Debe seguir teniendo un solo caso, `AF-000001`, y no debe cambiar su archivo.
3. Preparar el JSON y las fotografías originales fuera del repositorio. Usar una clave nueva, distinta de las claves de sonda.
4. Publicar este cambio solo cuando se autorice el despliegue de staging. No cambiar variables ni permisos.
5. Ejecutar el comando una vez dentro del contenedor de staging. El resultado esperado es `ok`, estado `created` o `already_exists`, caso `AF-000002` y una referencia por fotografía única.
6. Ejecutarlo otra vez con el mismo archivo. El resultado esperado es `already_exists`, sin otro caso ni otra fotografía.
7. Detenerse si el resultado es `partial`, `conflict`, `real_index` o trae `storageFailure`. No borrar el caso, el manifiesto ni el activo. No reintentar con otra clave.
