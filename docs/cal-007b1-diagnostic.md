# CAL-007B.1 — Diagnóstico de lectura

Estado: comandos preparados. Esta misión no los ejecutó contra GitHub ni Cloudinary. Las pruebas usan servicios simulados, así que no demuestran que las cuentas reales respondan.

Los comandos no montan `CalibrationModule`, no abren una ruta y no escriben en `pegazuz-calibration-data`. Un `PUT`, `PATCH` o `DELETE` se rechaza antes de salir del proceso.

## Qué comprueba cada uno

`npm run diagnose:calibration-github`

1. Lee `CALIBRATION_GITHUB_APP_ID`, `CALIBRATION_GITHUB_INSTALLATION_ID` y `CALIBRATION_GITHUB_APP_PRIVATE_KEY`.
2. Pide un token de instalación con el mismo adaptador de CAL-007A.
3. Exige `contents: write`. Acepta además solo `metadata: read`, porque GitHub lo agrega siempre. Cualquier otro permiso detiene la prueba.
4. Exige que el token vea únicamente `arturo2565-alt/pegazuz-calibration-data`.
5. Lee `data/index.json` y valida `schema_version`, casos `AF-######` y claves de origen. Sin esa lectura el resultado no es éxito.

`npm run diagnose:calibration-cloudinary`

Usa `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET`. Hace `GET /usage`. No sube, no modifica y no borra fotografías. Esa llamada confirma la autenticación de administrador; no confirma la redescarga autenticada de una foto.

La salida es una sola línea JSON: `result` `ok` o `error`, y en el error una `category`. No incluye tokens, claves, encabezados ni el documento leído. En GitHub, el éxito incluye solo `caseCount`.

Categorías: `missing`, `incomplete`, `forbidden`, `rejected`, `scope`, `invalid_index`, `read_failed`, `wrong_target`.

## Dónde ejecutarlo

Solo dentro del servicio `pegazuz-backend-staging`, entorno `staging`, proyecto `db653a25-d8c0-4026-9026-b8f74fb9f1fb`. Fuera de esos identificadores el comando responde `wrong_target` y no abre la red.

Desde el directorio del backend, sin copiar variables a un archivo:

```bash
railway run --service pegazuz-backend-staging --environment staging --project db653a25-d8c0-4026-9026-b8f74fb9f1fb --no-local -- npm run diagnose:calibration-github
railway run --service pegazuz-backend-staging --environment staging --project db653a25-d8c0-4026-9026-b8f74fb9f1fb --no-local -- npm run diagnose:calibration-cloudinary
```

No usar `printenv`, `railway variables` ni redireccionar la salida hacia el repositorio. `--no-local` evita mezclar un `.env` de la máquina. El proceso quita un separador de línea invisible que `railway run` a veces agrega al final de un secreto; no lo imprime ni lo guarda en Railway.

Si la categoría es `missing`, las variables todavía no están en ese servicio. Cargarlas es un paso aparte y no forma parte de este diagnóstico.
