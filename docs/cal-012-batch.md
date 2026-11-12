# CAL-012 — importación privada por lotes

El comando es `node dist/calibration/calibration-import-batch-run.js`. No hay endpoint. `CalibrationModule` sigue fuera de la aplicación y `CALIBRATION_INGEST_ENABLED` permanece en `false`.

Cada expediente reutiliza el importador de un caso. La cantidad de fotografías sigue el tope de CAL-013, no un máximo de cuatro. La identidad sigue siendo `source_case_key`. Un reintento de un archivo pendiente usa esa misma clave y no asigna otro identificador. Un caso ya archivado no se reabre.

## Directorio

Un directorio fuera del repositorio, con un subdirectorio por expediente y como máximo diez. Cada subdirectorio contiene `caso.json` y sus fotografías, con el mismo contrato del importador individual. El nombre del subdirectorio no sale en el informe. El orden del informe es el orden de esos nombres. Si el JSON no se puede validar, el expediente se identifica por `slot`.

No se acepta un lote dentro de este repositorio, un lote cuya ruta contenga `data/probes`, un directorio raíz que sea un enlace simbólico, ni más de diez expedientes. Esas condiciones rechazan el lote antes de leer fotografías.

Una clave `probe-*`, `autofix-sim-*`, `case-test-*` o `seed-case-*` queda en `requiere_correccion` y no se importa. Las fotografías repetidas dentro del mismo expediente siguen la regla actual: se conservan una vez y el informe trae `duplicateImages`. Si dos expedientes distintos contienen la misma fotografía, ambos quedan en `requiere_correccion` con `shared_photo` y ninguno se importa. Eso no afirma que sean el mismo caso. La misma clave con el mismo contenido importa solo la primera copia. La misma clave con otro contenido no importa ninguna.

## Preparación

```bash
npm run import:calibration-batch -- /tmp/pegazuz-import/lote
```

No abre GitHub ni Cloudinary. Un expediente válido queda `listo_para_importar`. Una copia local queda `duplicado_en_lote`. Un expediente ilegible, inseguro o contradictorio queda `requiere_correccion`. `labelEligible` es `false`: la preparación no consulta el índice y no autoriza cambiar la etiqueta de WhatsApp.

## Aplicación

```bash
npm run import:calibration-batch -- --apply /tmp/pegazuz-import/lote
```

Solo esta forma llama al importador, y lo hace de uno en uno, en el contenedor de staging ya usado por el diagnóstico. Exige `CALIBRATION_INGEST_ENABLED=false` y `DB_SYNCHRONIZE=false`.

- `registrado`: esta ejecución dejó el caso creado o reconciliado, con archivo privado completo y manifiestos verificados.
- `already_exists`: la clave ya tenía esa observación y el archivo también quedó verificado. El identificador no cambia.
- `pending_private_archive`: el caso quedó asignado, pero la fotografía o el manifiesto no se completaron. Se reintenta con la misma clave.
- `requiere_correccion`: el expediente no se importa, o la clave ya registra otra observación. Los demás expedientes continúan.
- `detenido_por_seguridad`: falló el destino, el permiso, el índice o la integridad. El resto de los expedientes listos no se envía.

`labelEligible` es `true` solo en `registrado` y `already_exists` cuando el almacenamiento privado y los manifiestos están verificados. Solo entonces el operador puede cambiar manualmente la etiqueta a CAL REGISTRADA. Este comando no llama a WhatsApp. Un pendiente conserva CAL PENDIENTE y su clave de origen.

`AF-000001`, `AF-000002` y `AF-000003` no admiten escritura. Un caso ya archivado, sea cual sea su identificador, no se reescribe: la misma observación responde `already_exists` y una observación distinta responde `requiere_correccion`. `data/probes/` no admite escritura.

## Informe

La salida es un JSON técnico. No incluye la cotización, nombres de archivo, directorios, URLs ni credenciales.

```json
{
  "service": "calibration-import-batch",
  "mode": "apply",
  "result": "error",
  "category": "halted",
  "items": [
    {
      "slot": 1,
      "sourceKey": "autofix-2026-11-11-06",
      "disposition": "registrado",
      "labelEligible": true,
      "duplicateImages": 0,
      "caseId": "AF-000003",
      "photoRefs": ["IMG-000001", "IMG-000002"],
      "contentMatch": true,
      "manifestMatch": true,
      "photoArchiveStatus": "archived_private",
      "protectedCaseUnchanged": true
    },
    {
      "slot": 2,
      "sourceKey": "autofix-2026-11-11-07",
      "disposition": "already_exists",
      "labelEligible": true,
      "duplicateImages": 0,
      "caseId": "AF-000004",
      "photoRefs": ["IMG-000001"],
      "contentMatch": true,
      "manifestMatch": true,
      "photoArchiveStatus": "archived_private",
      "protectedCaseUnchanged": true
    },
    {
      "slot": 3,
      "sourceKey": "autofix-2026-11-11-08",
      "disposition": "pending_private_archive",
      "labelEligible": false,
      "duplicateImages": 0,
      "caseId": "AF-000005",
      "photoRefs": [],
      "contentMatch": false,
      "manifestMatch": false,
      "photoArchiveStatus": "pending_private_archive",
      "protectedCaseUnchanged": true,
      "storageFailure": "upload_rejected"
    },
    {
      "slot": 4,
      "sourceKey": "autofix-2026-11-11-09",
      "disposition": "requiere_correccion",
      "labelEligible": false,
      "reason": "shared_photo",
      "duplicateImages": 0
    },
    {
      "slot": 5,
      "sourceKey": "autofix-2026-11-11-10",
      "disposition": "detenido_por_seguridad",
      "labelEligible": false,
      "reason": "halted",
      "duplicateImages": 0
    }
  ],
  "counts": {
    "requiere_correccion": 1,
    "registrado": 1,
    "already_exists": 1,
    "pending_private_archive": 1,
    "detenido_por_seguridad": 1
  }
}
```

En ese ejemplo solo los slots 1 y 2 autorizan la etiqueta. El slot 3 se reintenta con `autofix-2026-11-11-08`. El slot 4 se revisa junto con el otro expediente que contiene la misma fotografía. El slot 5 no se envió.

Esta misión no ejecuta `--apply` contra staging, GitHub ni Cloudinary.
