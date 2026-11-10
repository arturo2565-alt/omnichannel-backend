# CAL-010 — Observación con fotografía privada

Estado: `AF-900001` quedó pendiente en la primera ejecución real. La fotografía de seis bytes no era un JPEG decodificable y no se creó activo ni manifiesto. La recuperación todavía no se ejecuta.

## Diseño

`CalibrationEngine` sigue siendo el orquestador. Recibe dos adaptadores con rutas fijas:

- `CalibrationProbeWriter` solo acepta `data/probes/index.json`, `data/probes/cases/AF-9#####.json` y `data/probes/photos/AF-9#####/IMG-######.json`.
- `createCal010PhotoArchive` solo sube a `pegazuz_calibration/cal010-probe/AF-9#####/`. Rechaza `AF-900000`, `AF-000001` y cualquier ruta `cal008-probe`.

Una fotografía queda `verified` después de que la descarga autenticada reproduce el SHA-256 original. El manifiesto se escribe entonces y el caso recibe `photo_refs`. Si Cloudinary ya tiene el archivo y la segunda subida falla, el adaptador descarga esos bytes y los vuelve a comprobar. No borra el activo.

Si el manifiesto no llega a GitHub, el caso queda `pending_private_archive` y `photo_refs` vacío. La misma clave, en otra ejecución, no abre otro caso: reintenta el manifiesto. Si el manifiesto quedó escrito y el caso no se actualizó, `recoverOrphanManifests` lo enlaza sin subir otra imagen. Un reintento con el mismo SHA reutiliza `IMG-000001`.

`AF-900000` y la clave `probe-cal-009d-001` tienen que existir en el índice de prueba antes de empezar. El caso nuevo usa `probe-cal-010-001` y el siguiente identificador libre, `AF-900001` si ese es el único caso de prueba. El índice real no participa en la asignación.

## Comando

`npm run diagnose:calibration-integrated` ejecuta `node dist/calibration/calibration-diagnose-integrated-run.js`. No usa `ts-node`. El proceso solo arranca si el proyecto, el entorno y el servicio son los de Railway staging, y si `CALIBRATION_INGEST_ENABLED` y `DB_SYNCHRONIZE` valen exactamente `false`.

Antes de cualquier escritura lee el índice real y exige `AF-900000` con la clave `probe-cal-009d-001`. La observación usa `probe-cal-010-001` y pasa por `CalibrationEngine`, `CalibrationProbeWriter` y `createCal010PhotoArchive`. Después vuelve a leer el caso y el manifiesto desde GitHub. `photo_refs` tiene que coincidir con el manifiesto verificado. El índice real y `AF-900000` tienen que quedar iguales.

Si `probe-cal-010-001` ya está completa y el SHA-256 coincide, el comando responde `already_exists` y no crea otro activo. Si el manifiesto está verificado pero el caso no lo enlaza, enlaza ese manifiesto una vez. Si el contenido o el SHA-256 difieren, se detiene. Una respuesta ausente no se trata como “no se escribió”: el resultado queda en `partial` o `error` y no se borra nada.

Esta fase no ejecuta el comando contra GitHub ni Cloudinary.

## Recuperación de AF-900001

La clave `probe-cal-010-001` ya apunta a `AF-900001`. El caso está en `pending_private_archive`, con `photo_refs` vacío. No existe `IMG-000001` y no hay activos bajo `pegazuz_calibration/cal010-probe/`. El índice real sigue con `AF-000001` y `AF-900000` no cambió.

La huella de la cotización no incluye la fotografía. Cambiar el PNG sintético no convierte la observación en otra distinta y no abre `AF-900002`. Como no hay manifiesto, el SHA-256 nuevo tampoco entra en conflicto. Si antes del reintento apareciera un manifiesto con otro SHA-256, o un activo bajo ese prefijo, hay que detenerse e identificarlo. No se borra nada.

El enlace posterior solo completa `photo_refs`, el estado del archivo y `updated_at`. No reescribe la cotización.

1. Publicar el commit de la imagen decodificable solo en `genesis/staging`. Actions debe verificar y omitir el despliegue. El autodespliegue de staging sigue apagado.
2. Volver a leer el índice de prueba, `AF-900001`, el manifiesto y el prefijo `pegazuz_calibration/cal010-probe/`. Si el manifiesto existe o el prefijo ya tiene activos, detenerse.
3. Desplegar solo `pegazuz-backend-staging` con el proyecto `db653a25-d8c0-4026-9026-b8f74fb9f1fb`, el entorno `faf009cb-88a2-4ac8-80bd-7e3f60bbca8b` y el servicio `b40bff1c-2da4-4460-b5f4-507d9d994d0a`.
4. Comprobar `GET /api/health` y que el JavaScript compilado del comando está en el contenedor. Las banderas siguen exactamente en `false`.
5. Ejecutar `npm run diagnose:calibration-integrated` una vez. El resultado esperado es `ok`, estado `already_exists`, caso `AF-900001`, foto `IMG-000001` y manifiesto verificado. El SHA-256 del PNG es `d220355abb4483298addfcae6959dcadbb69552c422a0f005176197133fe6122`. `probeCaseCount` queda en 2 y el índice real sigue en 1.
6. Ejecutarlo otra vez. El resultado esperado es `already_exists`, sin otro caso, manifiesto ni activo.
7. Si el resultado es `partial`, `error` o `storageFailure`, detenerse. No crear `AF-900002` y no borrar `AF-900001`, `AF-900000` ni `AF-000001`.
