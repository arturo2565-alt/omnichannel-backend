# CAL-010 — Observación con fotografía privada

Estado: integración simulada. No hubo escritura en GitHub ni en Cloudinary.

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

## Ejecución real, todavía sin lanzar

1. Publicar el commit revisado solo en `genesis/staging` y esperar a que la verificación de Actions termine en éxito y el despliegue quede omitido.
2. Confirmar que el autodespliegue de `pegazuz-backend-staging` sigue apagado. No cambiar variables.
3. Desplegar solo ese servicio de staging con `railway up` y los identificadores del proyecto `db653a25-d8c0-4026-9026-b8f74fb9f1fb`, el entorno `faf009cb-88a2-4ac8-80bd-7e3f60bbca8b` y el servicio `b40bff1c-2da4-4460-b5f4-507d9d994d0a`.
4. Comprobar `GET /api/health` y que `dist/calibration/calibration-diagnose-integrated-run.js` existe en el contenedor.
5. Ejecutar el comando una vez. El resultado esperado es `created`, caso `AF-900001`, foto `IMG-000001`.
6. Ejecutarlo otra vez. El resultado esperado es `already_exists`, sin otro caso ni otra fotografía.
7. Si el resultado es `partial` o `error`, detenerse. No reintentar en ciega y no borrar el activo, el manifiesto, `AF-900000` ni `AF-000001`.
8. El índice real debe seguir con un solo caso. `CalibrationModule` permanece fuera de la aplicación.
