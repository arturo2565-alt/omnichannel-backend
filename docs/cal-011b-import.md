# CAL-011B — publicación del importador privado

El comando sigue siendo `node dist/calibration/calibration-import-run.js`. No hay endpoint de subida. `CalibrationModule` no entra en la aplicación y `CALIBRATION_INGEST_ENABLED` permanece en `false`.

## Lectura

El JSON y sus fotografías viven en un mismo directorio, fuera del repositorio de código. Cada entrada de `images` es un nombre relativo de ese directorio, por ejemplo `frente.jpg` o `fotos/frente.jpg`. El lector rechaza una ruta absoluta, un segmento `..`, una barra invertida y cualquier enlace simbólico. Comprueba que el archivo real quede dentro del directorio y que sea una imagen decodificable de hasta 5 MiB. Un archivo ausente o ilegible termina la lectura sin copiar la ruta al resultado.

La clave de origen identifica el reintento. Un fallo de subida o de manifiesto deja el caso pendiente; la misma clave lo completa y no asigna otro identificador. `AF-000001`, `data/probes/` y los prefijos `cal008-probe` y `cal010-probe` no se modifican.

El caso y el manifiesto guardan la cotización validada, el identificador, el SHA-256 y la referencia privada `pegazuz_calibration/AF-0#####/`. No guardan el directorio local, el nombre del archivo, credenciales ni datos de contacto. La salida del comando es el JSON técnico y no repite esos datos.

## Transferencia, todavía sin habilitar

Las fotografías no se suben al repositorio de código ni al de calibración. Cuando exista la cotización aprobada y se autorice la primera importación, la copia será una sola sesión SSH autenticada hacia `pegazuz-backend-staging`:

1. Crear en el contenedor el directorio efímero `/tmp/pegazuz-import`. No es un volumen ni una variable de Railway.
2. Copiar el JSON y las fotografías de esa sesión, con nombres relativos simples. La cantidad sigue el tope de CAL-013.
3. Ejecutar una vez `node dist/calibration/calibration-import-run.js /tmp/pegazuz-import/caso.json`.
4. Ejecutar el mismo comando otra vez. Lo esperado es `already_exists` sobre el mismo caso.
5. Detenerse ante `partial`, `conflict`, `real_index` o `storageFailure`. No borrar el caso, el manifiesto ni la fotografía. No cambiar la clave.

Esta misión no abre esa sesión de copia y no registra un caso humano. Si el índice real sigue teniendo solo `AF-000001`, el primer caso nuevo será `AF-000002`.
