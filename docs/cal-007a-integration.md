# CAL-007A — Integración preparada, todavía apagada

Estado: código en `genesis/staging`. `CalibrationModule` no está importado en `AppModule`. Con la bandera apagada, `POST /calibration/cases` no registra una cotización. No hay push, despliegue ni escritura en `pegazuz-calibration-data`.

## Bandera

`CALIBRATION_INGEST_ENABLED` solo habilita el manejador cuando su valor es exactamente `true`. Cualquier otro valor, incluido vacío, responde 404 y no abre GitHub ni Cloudinary.

Aunque alguien importe el módulo, la bandera sigue siendo obligatoria. Montar la ruta en `AppModule` queda para una autorización posterior.

## Variables

No hay secretos en el código. Los nombres, sin valores, son:

| Variable | Uso |
| --- | --- |
| `CALIBRATION_INGEST_ENABLED` | `true` para aceptar ingesta. Cualquier otro valor la deja apagada. |
| `CALIBRATION_GITHUB_APP_ID` | Identificador numérico de la GitHub App. |
| `CALIBRATION_GITHUB_INSTALLATION_ID` | Instalación limitada a `pegazuz-calibration-data`. |
| `CALIBRATION_GITHUB_APP_PRIVATE_KEY` | PEM de la App. Puede traer saltos de línea escapados. Solo vive en el servidor. |
| `CALIBRATION_GITHUB_REPOSITORY` | Opcional. El único valor aceptado es `arturo2565-alt/pegazuz-calibration-data`. |
| `CLOUDINARY_CLOUD_NAME` | Nube usada para el archivo privado. |
| `CLOUDINARY_API_KEY` | Credencial de servidor. |
| `CLOUDINARY_API_SECRET` | Credencial de servidor. |

Un token personal de GitHub no es la credencial de este camino. El adaptador pide un token de instalación, con permiso `contents: write` y repositorio `pegazuz-calibration-data`, y lo renueva en memoria. Un HTTP 401 lo invalida y reintenta la misma escritura una sola vez.

## GitHub App

1. Crear una GitHub App en la cuenta que administra `arturo2565-alt`.
2. Quitar el webhook, o dejarlo inactivo. Esta ingesta no lo usa.
3. Permiso de repositorio: Contents, Read and write. No agregar Administration, Pull requests, Actions ni Metadata de más si la interfaz lo permite por separado.
4. Instalación: solo el repositorio `pegazuz-calibration-data`.
5. Generar una clave privada y guardarla en el gestor de secretos del servidor. No pegarla en el código, en fixtures ni en el chat.
6. Anotar el App ID y el Installation ID. El dueño del repositorio los copia desde la configuración de la App y de la instalación.
7. No instalar la App en `omnichannel-backend` ni en `main`.

El token dura como máximo una hora. El proceso lo descarta un minuto antes de `expires_at` y no lo escribe en logs.

## Cloudinary

La subida pide `type: authenticated`. Después se descargan los bytes con URL firmada de corta vida. Esa URL no sale del proceso. El manifiesto se escribe solo si el SHA-256 descargado coincide con el archivo original y el identificador del activo no es una URL. Si la descarga falla o el checksum no coincide, el caso permanece `pending_private_archive`.

El cuerpo de la ingesta lleva los bytes originales en base64. Una URL o un `data:` de conversación se rechaza. Este módulo no extrae adjuntos de ChatGPT.

## Respuesta

El taller sale del JWT. Un `tallerId` del cuerpo que no coincida se rechaza. El caso guardado no incluye ese taller ni datos de contacto. La respuesta dice `created`, `already_exists`, `reconciled` o `partial`, con el `AF-######` y el estado fotográfico. No incluye tokens, URLs ni el cuerpo de la cotización.

Límites: ocho imágenes, 5 MiB cada una, JPEG, PNG o WEBP.

## Antes de la primera prueba real

- Montar `CalibrationModule` solo con autorización y con la bandera todavía en falso hasta el momento de la prueba.
- Cargar la GitHub App y Cloudinary en el entorno de staging, no en producción.
- Usar un caso ficticio. No reescribir `AF-000001`.
- Confirmar que el activo queda `authenticated` y que el manifiesto tiene el mismo SHA-256.
- Retirar la bandera al terminar. No hay borrado automático de un manifiesto no probado.
