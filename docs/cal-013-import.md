# CAL-013 — fotografías variables

El importador privado de CAL-011 y el lote de CAL-012 aceptan de 1 a 30 fotografías por expediente. No hay un máximo fijo de cuatro. La ingesta pública sigue apagada, en ocho imágenes, y sin módulo. El análisis visual del agente sigue partiendo su trabajo en grupos de cuatro; este cambio no lo modifica.

Los bytes recibidos se archivan sin transformación. `source_kind` permanece `manual_import`. Eso registra una carpeta entregada por el operador. No afirma que el archivo sea el original de la cámara ni que haya llegado por el webhook de WhatsApp. El informe del importador individual trae `provenance: operator_local_folder` y `cameraOriginal: false`.

## Topes

Si la variable no está definida, se usa el valor de la derecha. Un valor por encima del techo se rechaza. Esta misión no cambia variables de Railway.

| Variable | Valor inicial | Techo |
|---|---|---|
| `CALIBRATION_IMPORT_MAX_PHOTOS` | 30 | 30 |
| `CALIBRATION_IMPORT_MAX_PHOTO_BYTES` | 5242880 | 5242880 |
| `CALIBRATION_IMPORT_MAX_TOTAL_BYTES` | 83886080 | 83886080 |

El mínimo es una fotografía y no se configura. Superar la cantidad, el tamaño de un archivo o el volumen total rechaza el expediente completo. No se descartan las fotografías sobrantes. El lector mide cada archivo antes de leer sus bytes. Una ruta repetida se lee una sola vez.

El orden es el arreglo `images` de `caso.json`. La primera aparición de un SHA-256 se conserva. Las copias posteriores aumentan `duplicateImages` y no cambian las referencias siguientes.

## Recuperación

Un caso pasa a `archived_private` solo cuando todas las fotografías únicas están verificadas, las referencias son exactamente `IMG-000001` en adelante, no hay huecos ni duplicados y cada SHA-256 coincide con la posición de entrada.

Si falla la fotografía 8 de 15, el caso sigue `pending_private_archive` y `photo_refs` queda vacío. Los manifiestos ya verificados permanecen. El siguiente intento con la misma `source_case_key` y el mismo orden continúa desde el primer manifiesto ausente. No asigna otro caso ni otra fotografía para un SHA que ya estaba verificado.

`recoverOrphanManifests` no marca `archived_private` cuando el conjunto esperado está incompleto. Un caso que ya está `archived_private` no se reescribe: la misma observación responde `already_exists` y otra observación o otro orden responde conflicto. Esa regla vale para cualquier caso completo, no solo para una lista fija.

`AF-000001`, `AF-000002` y `AF-000003` no aceptan escritura. El asignador los salta, así que el siguiente caso nuevo es `AF-000004` mientras esos tres sigan reservados. `data/probes/` y los prefijos `cal008-probe` y `cal010-probe` siguen fuera del importador real.

## Privacidad

Se rechaza un JPEG, PNG o WEBP cuyos metadatos contengan GPS, autor, propietario, número de serie, correo, teléfono, placa o un VIN en el texto auxiliar. El rechazo ocurre antes de subir y no modifica el archivo.

Una placa, un rostro o un VIN visibles en la imagen no se detectan aquí. Esa revisión es humana y debe hacerse antes de colocar los archivos en la carpeta. El importador no anonimiza y no afirma que esa revisión haya ocurrido.

## Comandos

Siguen siendo los de CAL-011 y CAL-012:

```bash
npm run import:calibration-case -- /ruta/caso.json
npm run import:calibration-batch -- /ruta/lote
npm run import:calibration-batch -- --apply /ruta/lote
```

El lote sigue limitado a diez expedientes. Esta fase no ejecuta una importación real.
