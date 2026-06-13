import type { FunctionTool } from 'openai/resources/responses/responses';

/** Herramientas del autopilot (Responses API `tools`). */
export const AUTOPILOT_RESPONSES_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    name: 'obtenerCotizacionExpress',
    description:
      'Úsala cuando el cliente solicite el precio de un baño de pintura o el repintado express de piezas específicas y ya conozcas el modelo del vehículo. Esta función consultará la base de datos real del taller y te devolverá los precios oficiales para que se los presentes al cliente.',
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
      'Registra una cita en la base de datos del taller. Úsala cuando el cliente haya confirmado explícitamente día y hora de visita válidos dentro del horario laboral. En el panel de simulación (playground), la misma llamada solo valida horario y devuelve vista previa sin persistir en BD.',
    parameters: {
      type: 'object',
      properties: {
        scheduledAtIso: {
          type: 'string',
          description:
            'Fecha y hora del turno en America/Mexico_City. Preferido: YYYY-MM-DDTHH:mm sin sufijo Z (ej. 2026-05-26T15:30:00 = 3:30 PM CDMX). Si el cliente dice "3:30" sin AM/PM, usa 15:30. Horario: lun–vie 09:00–18:00, sáb 09:00–14:00.',
        },
        clientName: {
          type: 'string',
          description:
            'Nombre del cliente si se menciona; si omites, se usará el nombre de la conversación.',
        },
        vehicleDescription: {
          type: 'string',
          description:
            'Modelo o datos del vehículo si el cliente los dio en el chat.',
        },
        phone: {
          type: 'string',
          description:
            'Teléfono del cliente si consta en el mensaje (solo dígitos o formato típico).',
        },
      },
      required: ['scheduledAtIso'],
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
