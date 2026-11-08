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

El diagnóstico autorizado corre dentro del contenedor ya desplegado de `pegazuz-backend-staging`. No se ejecuta desde la computadora local.

`railway run` arranca el código de esta máquina y le inyecta las variables que Railway tiene en el servicio. `--no-local` solo omite un `docker-compose` local. No convierte el comando en una ejecución remota. Esos comandos quedan fuera de este procedimiento. Tampoco se usan `printenv`, `railway variables` ni redirecciones que puedan guardar secretos.

El contenedor vigente, despliegue `c3702ee6-32cc-4f70-bcdc-5139a4cc60bc` del 6 de noviembre de 2026, no contiene estos scripts. `railway ssh` contra ese contenedor no puede hacer el diagnóstico. Primero hace falta el despliegue manual de la revisión publicada, descrito abajo, y todavía no ejecutado.

## Artefacto

Railway no usa un Dockerfile ni un `nixpacks.toml` en este repositorio. El servicio tiene `buildCommand` vacío y arranca con `npm run start:prod`, que es `node dist/main.js`. Nixpacks ejecuta `npm run build`. Ese build es `nest build`: compila `src` hacia `dist` y no compila `scripts/`.

`ts-node` está en `devDependencies`. Con `NODE_ENV=production`, el empaquetado puede omitir o podar esas dependencias después de compilar. El diagnóstico no depende de ellas. `npm run diagnose:calibration-github` y `npm run diagnose:calibration-cloudinary` ejecutan JavaScript ya compilado:

- `dist/calibration/calibration-diagnose-github.js`
- `dist/calibration/calibration-diagnose-cloudinary.js`

Esos archivos solo leen. No montan `CalibrationModule`.

### Comprobar la revisión

Después de que ese despliegue esté en SUCCESS y sea el activo, desde el directorio del backend:

```bash
railway ssh \
  --project db653a25-d8c0-4026-9026-b8f74fb9f1fb \
  --environment faf009cb-88a2-4ac8-80bd-7e3f60bbca8b \
  --service b40bff1c-2da4-4460-b5f4-507d9d994d0a \
  -- node -e 'const fs=require("fs"); const files=["dist/calibration/calibration-diagnose-github.js","dist/calibration/calibration-diagnose-cloudinary.js"]; console.log(JSON.stringify({present:Object.fromEntries(files.map((file)=>[file, fs.existsSync(file)]))}));'
```

Los dos archivos tienen que existir. Si falta alguno, el build no incluyó la entrada y hay que detenerse. No se instala `ts-node` dentro del contenedor y no se cambia el comando de arranque.

### Comprobar variables sin imprimirlas

```bash
railway ssh \
  --project db653a25-d8c0-4026-9026-b8f74fb9f1fb \
  --environment faf009cb-88a2-4ac8-80bd-7e3f60bbca8b \
  --service b40bff1c-2da4-4460-b5f4-507d9d994d0a \
  -- node -e 'const names=["CALIBRATION_GITHUB_APP_ID","CALIBRATION_GITHUB_INSTALLATION_ID","CALIBRATION_GITHUB_APP_PRIVATE_KEY","CLOUDINARY_CLOUD_NAME","CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET"]; const present=Object.fromEntries(names.map((name)=>[name, Boolean(String(process.env[name]||"").trim())])); const ingestEnabled=process.env.CALIBRATION_INGEST_ENABLED==="true"; const dbSynchronizeFalse=String(process.env.DB_SYNCHRONIZE||"")==="false"; console.log(JSON.stringify({present, ingestEnabled, dbSynchronizeFalse}));'
```

Esa salida solo dice si cada nombre está presente. `ingestEnabled` tiene que ser falso y `dbSynchronizeFalse` verdadero. Si falta un nombre, la categoría del diagnóstico será `missing`.

Las variables se aplican en el servicio `pegazuz-backend-staging` del entorno staging. `railway up` no las crea ni las modifica: Railway las inyecta en el proceso al arrancar. Definirlas es un paso posterior y separado, solo en ese servicio, nunca en `omnichannel-backend`. Este procedimiento no las lee ni las copia. `CALIBRATION_INGEST_ENABLED` no forma parte del build; la ingesta permanece apagada mientras ese valor no sea exactamente `true`. `DB_SYNCHRONIZE` permanece `false`. El arranque rechaza sincronizar una base remota y `Staging migrate` no corre en un push ni en `railway up`.

### Ejecutar el diagnóstico

Solo cuando la revisión y las variables ya se comprobaron:

```bash
railway ssh \
  --project db653a25-d8c0-4026-9026-b8f74fb9f1fb \
  --environment faf009cb-88a2-4ac8-80bd-7e3f60bbca8b \
  --service b40bff1c-2da4-4460-b5f4-507d9d994d0a \
  -- npm run diagnose:calibration-github
railway ssh \
  --project db653a25-d8c0-4026-9026-b8f74fb9f1fb \
  --environment faf009cb-88a2-4ac8-80bd-7e3f60bbca8b \
  --service b40bff1c-2da4-4460-b5f4-507d9d994d0a \
  -- npm run diagnose:calibration-cloudinary
```

El proceso, dentro del contenedor, exige el proyecto `db653a25-d8c0-4026-9026-b8f74fb9f1fb`, el entorno `faf009cb-88a2-4ac8-80bd-7e3f60bbca8b` y el servicio `b40bff1c-2da4-4460-b5f4-507d9d994d0a`. Si no coinciden, responde `wrong_target` y no abre la red.

## Despliegue manual, todavía sin ejecutar

Destino único: servicio `pegazuz-backend-staging` (`b40bff1c-2da4-4460-b5f4-507d9d994d0a`), entorno staging (`faf009cb-88a2-4ac8-80bd-7e3f60bbca8b`), proyecto `db653a25-d8c0-4026-9026-b8f74fb9f1fb`.

Producción es otro servicio y otro entorno del mismo proyecto: `omnichannel-backend` (`4db5083b-67e6-4b71-bcb6-61cfd701bc53`), entorno `436be9c9-9cff-46cd-9552-d517a9e4875e`. Su autodespliegue nativo escucha la rama `genesis/crm-008`, no `genesis/staging`. No se empuja esa rama, no se usa ese servicio y no se usa `--new` ni `railway service source connect`.

Antes de subir:

1. `git status` limpio y `HEAD` igual a `origin/genesis/staging`, en la revisión que ya contiene los dos scripts.
2. `STAGING_DEPLOY_ENABLED=false` y `STAGING_NATIVE_DEPLOY=off`.
3. Autodespliegue nativo de `pegazuz-backend-staging` desactivado y sin disparadores.
4. Anotar el despliegue activo. Hoy es `c3702ee6-32cc-4f70-bcdc-5139a4cc60bc`, SUCCESS, servicio y entorno de staging. Si ya cambió, se anota el nuevo identificador solo después de comprobar que su `serviceId` y `environmentId` son los de staging.
5. `CalibrationModule` sigue fuera de `AppModule`. `railway up` no cambia variables: `CALIBRATION_INGEST_ENABLED` no se define y `DB_SYNCHRONIZE` permanece `false`.
6. El arranque no migra. `synchronize` remoto queda apagado salvo `DB_SYNCHRONIZE=true`, y el workflow `Staging migrate` solo corre con `workflow_dispatch`.

Comando, desde el directorio del backend:

```bash
railway up --detach --json \
  --project db653a25-d8c0-4026-9026-b8f74fb9f1fb \
  --environment faf009cb-88a2-4ac8-80bd-7e3f60bbca8b \
  --service b40bff1c-2da4-4460-b5f4-507d9d994d0a \
  --message "cal-007b diagnostic scripts"
```

Después se espera SUCCESS de ese identificador nuevo. El comando de arranque sigue siendo `npm run start:prod`. La prueba de que el diagnóstico llegó es la existencia de los dos archivos `dist/calibration/calibration-diagnose-*.js`, comprobada por SSH. El humo es `GET /api/health` del host de staging, con `ok` y `staging` en verdadero, y el arranque debe registrar `dbSynchronize` en falso.

Reversión, solo hacia el despliegue de staging anotado antes de subir:

```bash
railway api --var id=IDENTIFICADOR_ANOTADO \
  'mutation($id: String!) { deploymentRollback(id: $id) }'
```

Antes de lanzarla, la consulta de ese identificador tiene que mostrar el servicio `b40bff1c-2da4-4460-b5f4-507d9d994d0a` y el entorno `faf009cb-88a2-4ac8-80bd-7e3f60bbca8b`. `deployment redeploy` repite el último despliegue, así que no sirve para volver al anterior. No se revierte el despliegue de producción `cf2da2ff-94b5-46eb-9885-f1baf56b73d8`.
