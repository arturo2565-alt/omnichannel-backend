# CAL-010 — Observación con fotografía privada

Estado: integración simulada. No hubo escritura en GitHub ni en Cloudinary.

## Diseño

`CalibrationEngine` sigue siendo el orquestador. Recibe dos adaptadores con rutas fijas:

- `CalibrationProbeWriter` solo acepta `data/probes/index.json`, `data/probes/cases/AF-9#####.json` y `data/probes/photos/AF-9#####/IMG-######.json`.
- `createCal010PhotoArchive` solo sube a `pegazuz_calibration/cal010-probe/AF-9#####/`. Rechaza `AF-900000`, `AF-000001` y cualquier ruta `cal008-probe`.

Una fotografía queda `verified` después de que la descarga autenticada reproduce el SHA-256 original. El manifiesto se escribe entonces y el caso recibe `photo_refs`. Si Cloudinary ya tiene el archivo y la segunda subida falla, el adaptador descarga esos bytes y los vuelve a comprobar. No borra el activo.

Si el manifiesto no llega a GitHub, el caso queda `pending_private_archive` y `photo_refs` vacío. La misma clave, en otra ejecución, no abre otro caso: reintenta el manifiesto. Si el manifiesto quedó escrito y el caso no se actualizó, `recoverOrphanManifests` lo enlaza sin subir otra imagen. Un reintento con el mismo SHA reutiliza `IMG-000001`.

`AF-900000` y la clave `probe-cal-009d-001` tienen que existir en el índice de prueba antes de empezar. El caso nuevo usa `probe-cal-010-001` y el siguiente identificador libre, `AF-900001` si ese es el único caso de prueba. El índice real no participa en la asignación.

## Ejecución real, todavía sin lanzar

Hace falta revisión. No hay comando ejecutable en esta fase.

1. Correr dentro del contenedor de staging, con el repositorio resuelto en `arturo2565-alt/pegazuz-calibration-data` y con `CALIBRATION_INGEST_ENABLED` y `DB_SYNCHRONIZE` exactamente en `false`.
2. Leer `data/index.json` y `data/probes/cases/AF-900000.json` y anotar su SHA. Si cualquiera cambia al final, la prueba se detiene.
3. Confirmar que el índice de prueba contiene `AF-900000` con la clave `probe-cal-009d-001`.
4. Registrar una sola observación con la imagen sintética de CAL-010 y la clave `probe-cal-010-001`. La ruta Cloudinary tiene que empezar por `pegazuz_calibration/cal010-probe/`.
5. Leer el caso, el manifiesto y el índice de prueba. El caso esperado es `AF-900001`, con `IMG-000001`, estado verificado y el mismo SHA-256.
6. Repetir la misma observación. El resultado es `already_exists` y no aparece otro caso ni otra subida.
7. No borrar el activo, el manifiesto, `AF-900000` ni `AF-000001`.
