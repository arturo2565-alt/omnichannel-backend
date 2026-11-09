# CAL-009C — Espacio de prueba dentro del archivo privado

Estado: preparación simulada. No hubo escritura en GitHub ni en Cloudinary, y el activo de CAL-008 sigue donde está.

## Destino

Se usa la GitHub App actual, Pegazuz Calibration, y el repositorio privado `arturo2565-alt/pegazuz-calibration-data`. No hay una segunda app ni un segundo repositorio.

El archivo real permanece en:

- `data/index.json`
- `data/cases/`
- el resto de rutas reales ya existentes

La prueba solo puede usar:

- `data/probes/index.json`
- `data/probes/cases/AF-9#####.json`

`CalibrationGithubWriter` sigue atendiendo el archivo real. `CalibrationProbeWriter` es otra clase. No recibe un nombre de repositorio: la URL sale de la constante del repositorio privado y el camino se valida antes de llamar al transporte.

## Índice de prueba

```json
{
  "schema_version": "1.0.0",
  "archive": "probe",
  "cases": {
    "AF-900000": "data/probes/cases/AF-900000.json"
  },
  "source_keys": {
    "probe-cal-009c-001": "AF-900000"
  }
}
```

Un índice ausente se crea vacío, con `archive: "probe"` y sin casos. El primer identificador es `AF-900000`. La cuenta no lee `data/index.json`. Un identificador menor, una ruta distinta de `data/probes/cases/AF-9#####.json`, o un segmento `..`, `%`, barra invertida o consulta distinta de `ref=main`, se rechaza antes de la petición.

La misma clave de origen no crea otro caso. Otro contenido con esa clave es conflicto. Un 409 del índice deja el caso escrito y la conciliación solo enlaza `data/probes/index.json`. Un archivo de caso que ya existe no se pisa; la siguiente alta usa el siguiente identificador reservado, todavía dentro de `data/probes/cases/`.

La observación de prueba no lleva fotografías. `photo_refs` queda vacío y `photo_archive_status` queda `not_provided`. No se cita el activo `27b61d9ab76b915baa754954bfb34ec8` ni la ruta `pegazuz_calibration/cal008-probe/`.

## Prueba real, todavía sin ejecutar

Hace falta revisión antes de lanzarla. Esta fase no agrega un comando ejecutable.

1. Confirmar que el proceso corre en el contenedor de staging, que el repositorio resuelto es exactamente `arturo2565-alt/pegazuz-calibration-data` y que `CALIBRATION_INGEST_ENABLED` y `DB_SYNCHRONIZE` siguen en `false`.
2. Usar la instalación actual. No se agregan permisos ni repositorios.
3. Leer `data/index.json` solo para anotar su SHA y su conteo antes y después. La asignación del caso de prueba no usa ese índice.
4. Crear el índice de prueba si no existe. Registrar una sola observación ficticia, sin fotografías y sin datos personales, con una clave nueva.
5. Leer `data/probes/index.json` y el caso. El identificador esperado es `AF-900000`, o el siguiente libre desde ese rango si una prueba anterior ya lo ocupó. Repetir la misma observación y comprobar `already_exists`.
6. Comprobar que el SHA de `data/index.json` no cambió y que `data/cases/AF-000001.json` no fue modificado.

Limpieza, solo después de anotar los caminos creados:

- Borrar únicamente esos archivos bajo `data/probes/`.
- No borrar `data/index.json`, `data/cases/` ni el PNG autenticado de CAL-008.

Si una ruta resuelta sale de `data/probes/`, la prueba se detiene sin reintento.
