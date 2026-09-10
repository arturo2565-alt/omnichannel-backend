import type { FunctionTool } from 'openai/resources/responses/responses';

/** Herramientas del autopilot (Responses API `tools`). */
export const AUTOPILOT_RESPONSES_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    name: 'obtenerCotizacionExpress',
    description:
      'Úsala cuando el cliente solicite el precio de un baño de pintura o el repintado express de piezas específicas y ya conozcas el modelo del vehículo. Si pide cotizar el mismo servicio para varios autos en un mensaje, llama esta herramienta una vez por cada vehículo (modeloVehiculo distinto). El backend devolverá cotizacionMultiVehiculo.totalCombinadoMx cuando haya dos o más vehículos en el turno; usa ese total, no sumes mentalmente.',
    parameters: {
      type: 'object',
      properties: {
        servicios: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Piezas a repintar (ej. Puerta, Fascia, Salpicadera) o "baño de pintura" / pintura exterior completa.',
        },
        modeloVehiculo: {
          type: 'string',
          description:
            'Marca y modelo del vehículo del cliente (ej. Volkswagen Bora 2012, Nissan March 2018). Obligatorio antes de cotizar.',
        },
        categoriaTamaño: {
          type: 'string',
          enum: ['Chico', 'Mediano', 'Grande', 'XL'],
          description:
            'Tamaño de carrocería (NO confundir con premium). Pick-up/SUV grande (F-150, Silverado, Suburban) → Grande. SUV full-size (Escalade, Tahoe, Expedition) → XL. Sedán compacto (Aveo, March) → Chico. Sedán mediano → Mediano.',
        },
        esPremium: {
          type: 'boolean',
          description:
            'true si es marca premium (BMW, Mercedes, Audi, Lexus, Porsche, Land Rover, Mini, etc.). El sistema aplica un multiplicador sobre el precio base del tamaño. También puedes inferirlo del modelo.',
        },
      },
      required: ['servicios', 'modeloVehiculo', 'categoriaTamaño'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'obtenerCarritoActual',
    description:
      'Devuelve el carrito/cotización acumulada de esta conversación (fotos + chat). Úsala cuando el cliente pida el total actual o antes de agregar o quitar piezas.',
    parameters: { type: 'object', properties: {} },
    strict: false,
  },
  {
    type: 'function',
    name: 'agregarAlCarrito',
    description:
      'Agrega una pieza o servicio al carrito global de la conversación (rayones, repintado express por chat, etc.).',
    parameters: {
      type: 'object',
      properties: {
        pieza: {
          type: 'string',
          description:
            'Nombre de la pieza (Toldo, Fascia delantera, Puerta, Salpicadera, etc.).',
        },
        severidad: {
          type: 'string',
          description:
            'Opcional. Nivel de daño (DL, DML, DM, …). Por defecto DL para repintado express.',
        },
        descripcion: {
          type: 'string',
          description: 'Detalle opcional para el operador.',
        },
      },
      required: ['pieza'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'quitarDelCarrito',
    description:
      'Quita una pieza del carrito cuando el cliente diga que ya no la quiere (ej. "mejor sin el toldo").',
    parameters: {
      type: 'object',
      properties: {
        pieza: {
          type: 'string',
          description:
            'Pieza a quitar; coincidencia parcial (toldo, fascia, puerta, etc.).',
        },
      },
      required: ['pieza'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'actualizarCarrito',
    description:
      'Modifica una pieza en el carrito activo (severidad, nombre o descripción).',
    parameters: {
      type: 'object',
      properties: {
        piezaActual: {
          type: 'string',
          description: 'Pieza a modificar (coincidencia parcial).',
        },
        piezaNueva: {
          type: 'string',
          description:
            'Opcional. Nuevo nombre de pieza (ej. cambiar Puerta por Puerta delantera derecha).',
        },
        severidad: {
          type: 'string',
          description: 'Opcional. Nuevo nivel de daño (DL, DML, DM, …).',
        },
        descripcion: {
          type: 'string',
          description: 'Opcional. Nueva descripción técnica.',
        },
      },
      required: ['piezaActual'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'obtenerResumenCarrito',
    description:
      'Resumen completo del carrito: estado (pendiente, complemento, aprobado), desglose aprobado vs complemento, totales parciales y totalGlobal.',
    parameters: { type: 'object', properties: {} },
    strict: false,
  },
  {
    type: 'function',
    name: 'createAppointment',
    description:
      'Registra una cita en la base de datos del taller con los datos completos del cliente. Úsala cuando el cliente haya confirmado explícitamente día y hora de visita válidos dentro del horario laboral. Requiere nombre real (no "cliente"/"desconocido"), teléfono de al menos 8 dígitos (en WhatsApp puede omitirse si ya hay wa_id) y vehicleInfo con marca o modelo. Si falta alguno, la herramienta devuelve success:false y error MISSING_REQUIRED_DATA: pide esos datos amablemente y reintenta. En Messenger pide el teléfono si aún no lo tienes. En el panel de simulación (playground) valida horario y datos, pero no persiste.',
    parameters: {
      type: 'object',
      properties: {
        dateTime: {
          type: 'string',
          description:
            'Fecha y hora del turno en America/Mexico_City. Preferido: YYYY-MM-DDTHH:mm:ss sin sufijo Z (ej. 2026-05-26T15:30:00 = 3:30 PM CDMX). Si el cliente dice "3:30" sin AM/PM, usa 15:30. Horario: lun–vie 09:00–18:00, sáb 09:00–14:00. Alias aceptado: scheduledAtIso.',
        },
        scheduledAtIso: {
          type: 'string',
          description:
            'Alias de dateTime (compatibilidad). Usa dateTime si puedes.',
        },
        clientName: {
          type: 'string',
          description:
            'Nombre real del cliente. No uses "Cliente Desconocido" si el cliente ya se presentó.',
        },
        vehicleInfo: {
          type: 'string',
          description:
            'Marca, modelo y año del vehículo (ej. Jetta 2018). Alias: vehicleDescription.',
        },
        phone: {
          type: 'string',
          description:
            'Teléfono de contacto. Obligatorio en la práctica para Messenger (el PSID no es un número llamable).',
        },
        quoteSummary: {
          type: 'string',
          description:
            'Opcional. Resumen breve o total de la cotización activa (ej. "Hojalatería fascia $4,800").',
        },
      },
      required: ['dateTime', 'clientName', 'vehicleInfo', 'phone'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'buscarCostoRefaccionOnline',
    description:
      'Busca el costo real de una refacción en MercadoLibre México. REQUIERE año y modelo confirmados. Aplica +30% y redondea a $50. Si no hay muestra de mercado, devuelve requiereConfirmacionManual y NO inventes un precio. Inserta REFACCION en el carrito solo si success=true. El catálogo del taller solo aplica si el taller forzó un precio manual.',
    parameters: {
      type: 'object',
      properties: {
        pieza: {
          type: 'string',
          description: 'Pieza a reemplazar (Calavera_Izquierda, Faro_Derecho, FD, etc.).',
        },
        vehiculo: {
          type: 'string',
          description: 'Marca y modelo (ej. Volkswagen Jetta).',
        },
        modelo: {
          type: 'string',
          description: 'Modelo o versión (ej. Jetta, March).',
        },
        anio: {
          type: 'string',
          description: 'Año del vehículo (obligatorio, ej. 2019).',
        },
        marca: {
          type: 'string',
          description: 'Marca si se conoce (ej. Volkswagen).',
        },
      },
      required: ['pieza', 'anio'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'estimarRefaccionMercado',
    description:
      'Alias de buscarCostoRefaccionOnline. Misma regla: año + modelo obligatorios, mercado MX en tiempo real, +30%, sin precios inventados.',
    parameters: {
      type: 'object',
      properties: {
        pieza: {
          type: 'string',
          description: 'Pieza a reemplazar.',
        },
        vehiculo: {
          type: 'string',
          description: 'Marca y modelo.',
        },
        modelo: { type: 'string', description: 'Modelo o versión.' },
        anio: { type: 'string', description: 'Año (obligatorio).' },
        marca: { type: 'string', description: 'Marca.' },
      },
      required: ['pieza', 'anio'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'notificarLlegadaCliente',
    description:
      'Ejecuta esta herramienta inmediatamente cuando el cliente indique que ya llegó al taller o está esperando afuera.',
    parameters: { type: 'object', properties: {} },
    strict: false,
  },
];

/** Orden estable (alfabético) para maximizar prompt caching del prefijo de tools. */
export function sortFunctionToolsByName(
  tools: readonly FunctionTool[],
): FunctionTool[] {
  return [...tools].sort((a, b) =>
    String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en'),
  );
}

export const AUTOPILOT_RESPONSES_TOOLS_SORTED: FunctionTool[] =
  sortFunctionToolsByName(AUTOPILOT_RESPONSES_TOOLS);
