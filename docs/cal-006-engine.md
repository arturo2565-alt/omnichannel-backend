# CAL-006 — Motor unificado de calibración

Estado: código aislado en `genesis/staging`. Sin ruta HTTP, sin módulo Nest, sin credencial y sin escritura a casos reales.

## Contrato

La fuente versionada es `pegazuz-calibration-data` `35818ba9f3fb4ee8beecea1f7d09f7e2e4022cfd`. Las copias locales `calibration/schema.json` y `calibration/photo-v1.schema.json` son ese contrato, no un esquema paralelo.

El motor exige además, para una cotización autorizada:

- `status = human_verified` y cada línea `human_confirmed` con precio entero en MXN mayor que cero.
- Evidencia explícita por marca, modelo y año: `customer_provided`, `visual_inference` o `unknown`. Un dato desconocido se queda vacío. Una inferencia no rellena los campos desconocidos.
- Clave de origen estable. La misma clave con la misma observación no crea otro caso. Otra observación con la misma clave se rechaza.
- Sin nombre, teléfono, correo, placa ni VIN.

## Persistencia

`CalibrationEngine.record` asigna el siguiente `AF-######` que no esté ocupado. Ante dos escrituras simultáneas, la que pierde el archivo o el índice toma el siguiente identificador. Si el caso quedó escrito y el índice no, `reconcile` completa el índice sin reescribir el caso.

## Fotografías

El archivo real de Cloudinary no se invoca. El puerto de pruebas debe devolver el SHA-256 local y `verified: true`, que solo es cierto si un checksum descargado coincide. Sin esa confirmación el caso permanece `pending_private_archive` y no se escribe manifiesto. No se declara `chatgpt_upload`: este motor no extrae adjuntos de una conversación.

## Errores de GitHub

Un HTTP 422 crea otro identificador solo si el mensaje demuestra que el archivo ya existe (`sha` no enviado). Una validación 422, un 403 y un 429 no ocupan otro `AF-######`. El 429 y los 5xx reintentan el mismo caso, con espera exponencial y jitter, hasta tres veces más. Las colisiones reales siguen limitadas a cinco identificadores, y ese tope se puede bajar.

## Fotografías huérfanas

Si el manifiesto se guarda y falla el enlace con el caso, el caso sigue `pending_private_archive` y el manifiesto permanece. Un reintento de la misma cotización reutiliza ese manifiesto y no vuelve a subir la foto. `recoverOrphanManifests` enlaza solo un manifiesto verificado cuyo `case_id` y `photo_id` coinciden con la ruta y con un caso existente. Si esa prueba no se cumple, el archivo se queda. Este motor no borra fotografías ni manifiestos.

## Bloqueo de activación

CAL-007A deja preparados el proveedor de GitHub App, la redescarga autenticada y el endpoint. La ruta no está registrada en `AppModule` y `CALIBRATION_INGEST_ENABLED` sigue distinto de `true`. No hay escritura real ni credencial en el repositorio. `CanonicalQuoteV1` no lee estos casos. El detalle está en `docs/cal-007a-integration.md`.
