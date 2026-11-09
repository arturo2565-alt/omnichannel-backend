# CAL-008 — Sonda fotográfica privada

Estado: comando preparado. Esta misión no lo ejecutó contra Cloudinary. Las pruebas usan un archivo simulado, así que no demuestran que la cuenta real guarde o proteja la imagen.

El comando no monta `CalibrationModule`, no abre una ruta, no escribe en GitHub y no crea filas de calibración. Tampoco borra activos.

## Qué hace

`npm run diagnose:calibration-cloudinary-photo` ejecuta `node dist/calibration/calibration-diagnose-cloudinary-photo.js`.

1. Exige el contenedor de staging. Si el proyecto, el entorno o el servicio no coinciden, responde `wrong_target` y no abre la red.
2. Si `CALIBRATION_INGEST_ENABLED` es exactamente `true`, responde `rejected` y no sube nada.
3. Genera un PNG de un píxel, sin EXIF ni datos personales, y calcula su SHA-256 con `validateCalibrationImage`.
4. Lo sube con `CalibrationImageArchiveService.uploadOriginal`, `type: authenticated`, sin sobrescribir.
5. Recupera los bytes con `createCloudinaryGateway().downloadAuthenticated`. La URL firmada permanece dentro del proceso.
6. Compara el SHA-256 recuperado con `confirmArchiveChecksum`.
7. Pide la misma ruta sin firma. El original no debe volver en ese cuerpo.
8. Imprime identificadores y estados. No imprime la URL firmada, la URL anónima, el secreto ni el cuerpo descargado.

La ruta es exclusiva:

`pegazuz_calibration/cal008-probe/AF-008008/<32 hex del SHA-256>`

`AF-008008` solo nombra esa ruta de prueba. No es un caso de `pegazuz-calibration-data` y no se escribe en el índice. No se usa `AF-000001` ni `omnichannel_chats`. Si el recibo trae otra ruta, la categoría es `scope` y no se descarga ni se borra.

## Salida

Una línea JSON. `deleted` es siempre `false`.

Éxito: `result` `ok`, `checksumMatch` verdadero, `unauthorizedBlocked` verdadero, más `assetId`, `publicId`, `version`, `bytes`, `contentSha256` y `unauthorizedStatus`.

Error: `category` una de `missing`, `incomplete`, `checksum`, `exposed`, `rejected`, `read_failed`, `wrong_target`, `scope`.

`checksum` significa que la descarga autenticada no reprodujo el original. `exposed` significa que la petición sin firma sí lo devolvió. `incomplete` es un recibo sin identificador, versión o tamaño. Esas tres dejan el activo, si se llegó a crear, para el procedimiento de limpieza.

## Dónde ejecutarlo

Solo dentro del contenedor de `pegazuz-backend-staging`, después de un despliegue autorizado que contenga este commit. El despliegue activo `cccf5d95-dd82-4ce2-b4ff-6db3e4c15f62` es anterior y no tiene este archivo. No se ejecuta desde la computadora local. No se usa `railway run`, `printenv` ni `railway variables`.

Antes de la sonda, con el despliegue nuevo en SUCCESS:

```bash
railway ssh \
  --project db653a25-d8c0-4026-9026-b8f74fb9f1fb \
  --environment faf009cb-88a2-4ac8-80bd-7e3f60bbca8b \
  --service b40bff1c-2da4-4460-b5f4-507d9d994d0a \
  -- node -e 'const fs=require("fs"); console.log(JSON.stringify({present:fs.existsSync("dist/calibration/calibration-diagnose-cloudinary-photo.js")}));'
```

El archivo tiene que existir. No se instala `ts-node`. `CALIBRATION_INGEST_ENABLED` tiene que seguir en `false` y `DB_SYNCHRONIZE` en `false`. La comprobación booleana sigue siendo la de `docs/cal-007b1-diagnostic.md`.

```bash
railway ssh \
  --project db653a25-d8c0-4026-9026-b8f74fb9f1fb \
  --environment faf009cb-88a2-4ac8-80bd-7e3f60bbca8b \
  --service b40bff1c-2da4-4460-b5f4-507d9d994d0a \
  -- npm run diagnose:calibration-cloudinary-photo
```

Ese comando sube un único PNG autenticado en la ruta de prueba. No es una lectura. No se lanza hasta una autorización posterior.

## Limpieza

El comando no borra. Borrar más tarde solo es admisible cuando las cinco condiciones se cumplen a la vez:

1. `publicId` es exactamente `pegazuz_calibration/cal008-probe/AF-008008/` seguido de 32 hexadecimales, igual al `publicId` impreso.
2. `assetId` y `version` son los impresos en esa misma línea.
3. El tipo es `authenticated` y el recurso es `image`.
4. Una descarga firmada, hecha dentro del proceso y sin imprimir la URL, reproduce el `contentSha256` impreso.
5. La ruta no contiene `AF-000001`, no contiene `omnichannel_chats` y no empieza por `pegazuz_calibration/AF-`.

Si falta una, no se borra. Una línea sin `assetId` no autoriza borrado, aunque la ruta de prueba sea predecible. No se lista ni se vacía el prefijo `pegazuz_calibration/`. No se llama a `destroy` desde este diagnóstico.
