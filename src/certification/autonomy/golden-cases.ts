import type { DetectedDamageItem } from '../../chat/entities/chat.entity';
import type { AutonomyCertificationCase } from './types';

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DM',
    descripcionTecnica: 'golpe reparable',
    urls_origen: ['https://cdn.example/p.jpg'],
    treatmentSource: 'vision',
    ...overrides,
  };
}

export const AUTONOMY_GOLDEN_CASES: AutonomyCertificationCase[] = [
  {
    caseId: 'reparar_puerta_01',
    category: 'A. REPARAR claro',
    kind: 'vision',
    description: 'Golpe reparable en puerta',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({ pieza: 'Puerta', tratamiento: 'REPARAR', severidad: 'DM' }),
      ],
    },
    expected: {
      treatments: ['REPARAR'],
      quoteLines: [{ serviceType: 'REPARACION_PINTURA', billable: true }],
      forbiddenServiceTypes: ['REFACCION'],
      total: 4500,
      isPartial: false,
    },
  },
  {
    caseId: 'sustituir_fascia_01',
    category: 'B. SUSTITUIR claro',
    kind: 'vision',
    description: 'Fascia quebrada con mercado',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({
          pieza: 'Fascia',
          tratamiento: 'SUSTITUIR',
          descripcionTecnica: 'Fascia quebrada',
          precioMx: 6500,
          pricingStatus: 'OK',
          priceSource: 'WEB_MARKET_ESTIMATE',
        }),
      ],
    },
    expected: {
      treatments: ['SUSTITUIR'],
      quoteLines: [
        { serviceType: 'REFACCION', billable: true },
        { serviceType: 'MONTAJE_PINTURA', billable: true },
      ],
      total: 9900,
      isPartial: false,
    },
  },
  {
    caseId: 'incierto_contradiccion_01',
    category: 'C. INCIERTO',
    kind: 'vision',
    description: 'Evidencia contradictoria REPARAR vs SUSTITUIR',
    input: {
      vehicleContext: 'Versa 2018',
      visionItems: [
        item({ pieza: 'Puerta', tratamiento: 'SUSTITUIR', severidad: 'DL' }),
      ],
      priorTreatments: [{ pieza: 'Puerta', treatment: 'REPARAR' }],
    },
    expected: {
      treatments: ['INCIERTO'],
      quoteLines: [{ serviceType: 'REPARACION_PINTURA' }],
      requiredWarnings: ['POSSIBLE_SUBSTITUTION'],
      forbiddenServiceTypes: ['REFACCION'],
    },
  },
  {
    caseId: 'pendiente_sin_decision_01',
    category: 'D. PENDIENTE',
    kind: 'vision',
    description: 'Visión moderna sin tratamiento estructurado',
    input: {
      vehicleContext: 'Aveo 2015',
      visionItems: [
        item({
          pieza: 'Puerta',
          descripcionTecnica: 'posible roce',
          treatmentSource: 'vision',
        }),
      ],
    },
    expected: {
      treatments: ['PENDIENTE'],
      quoteLines: [{ serviceType: 'PENDIENTE', billable: false }],
      isPartial: true,
      requiredWarnings: ['PENDING_TREATMENT'],
      shouldRequestMoreEvidence: true,
      forbiddenServiceTypes: ['REFACCION'],
    },
  },
  {
    caseId: 'hidden_damage_01',
    category: 'E. daño interno posible',
    kind: 'vision',
    description: 'Warning de daño interno; no cargo inventado',
    input: {
      vehicleContext: 'Jetta 2019',
      visionItems: [
        item({
          pieza: 'Puerta',
          tratamiento: 'REPARAR',
          possibleHiddenDamage: {
            detected: true,
            areas: ['refuerzo'],
            requiresDisassembly: true,
          },
        }),
      ],
    },
    expected: {
      treatments: ['REPARAR'],
      requiredWarnings: ['HIDDEN_DAMAGE'],
      total: 4500,
      isPartial: false,
    },
  },
  {
    caseId: 'refaccion_mercado_ok_01',
    category: 'F. refacción con mercado',
    kind: 'vision',
    description: 'SUSTITUIR con muestra de mercado suficiente',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({
          pieza: 'Fascia',
          tratamiento: 'SUSTITUIR',
          precioMx: 6500,
          pricingStatus: 'OK',
          priceSource: 'WEB_MARKET_ESTIMATE',
        }),
      ],
    },
    expected: {
      treatments: ['SUSTITUIR'],
      quoteLines: [
        { serviceType: 'REFACCION', billable: true, pricingStatus: 'OK' },
        { serviceType: 'MONTAJE_PINTURA' },
      ],
      total: 9900,
      isPartial: false,
    },
  },
  {
    caseId: 'refaccion_insuficiente_01',
    category: 'G. refacción sin mercado',
    kind: 'vision',
    description: 'REFACCION pendiente; montaje sí; total parcial',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({
          pieza: 'Fascia',
          tratamiento: 'SUSTITUIR',
          pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
          priceSource: 'INSUFFICIENT_MARKET_SAMPLE',
        }),
      ],
    },
    expected: {
      treatments: ['SUSTITUIR'],
      quoteLines: [
        { serviceType: 'REFACCION', billable: false },
        { serviceType: 'MONTAJE_PINTURA', billable: true },
      ],
      isPartial: true,
      requiredWarnings: ['REFACCION_PENDIENTE_DE_COTIZAR'],
      total: 3400,
    },
  },
  {
    caseId: 'multi_pieza_01',
    category: 'H. múltiples piezas',
    kind: 'vision',
    description: 'Una reparación + una sustitución',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({ pieza: 'Puerta', tratamiento: 'REPARAR', severidad: 'DM' }),
        item({
          pieza: 'Fascia',
          tratamiento: 'SUSTITUIR',
          urls_origen: ['https://cdn.example/fd.jpg'],
          precioMx: 6500,
          pricingStatus: 'OK',
        }),
      ],
    },
    expected: {
      treatments: ['REPARAR', 'SUSTITUIR'],
      quoteLines: [
        { serviceType: 'REPARACION_PINTURA' },
        { serviceType: 'REFACCION' },
        { serviceType: 'MONTAJE_PINTURA' },
      ],
      total: 14400,
    },
  },
  {
    caseId: 'multi_foto_misma_pieza_01',
    category: 'I. múltiples fotos misma pieza',
    kind: 'vision',
    description: 'Dos fotos de la misma puerta → un damageItemId',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({
          pieza: 'Puerta',
          tratamiento: 'REPARAR',
          urls_origen: ['https://cdn.example/a.jpg'],
        }),
        item({
          pieza: 'Puerta',
          tratamiento: 'REPARAR',
          urls_origen: ['https://cdn.example/b.jpg'],
        }),
      ],
    },
    expected: {
      treatments: ['REPARAR'],
      sameDamageItemId: true,
      quoteLines: [{ serviceType: 'REPARACION_PINTURA' }],
    },
  },
  {
    caseId: 'descripcion_cambia_mismo_id_01',
    category: 'J. foto nueva cambia descripción',
    kind: 'vision',
    description: 'Nueva foto cambia texto; misma identidad',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({
          pieza: 'Puerta',
          tratamiento: 'REPARAR',
          descripcionTecnica: 'roce superficial actualizado',
          urls_origen: ['https://cdn.example/new.jpg'],
        }),
      ],
      priorTreatments: [{ pieza: 'Puerta', treatment: 'REPARAR' }],
    },
    expected: {
      treatments: ['REPARAR'],
      sameDamageItemId: true,
      quoteLines: [{ serviceType: 'REPARACION_PINTURA' }],
    },
  },
  {
    caseId: 'lock_contradiccion_01',
    category: 'K. contradicción locked',
    kind: 'vision',
    description: 'REPARAR locked vs SUSTITUIR incoming → INCIERTO',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({ pieza: 'Puerta', tratamiento: 'SUSTITUIR' }),
      ],
      priorTreatments: [{ pieza: 'Puerta', treatment: 'REPARAR' }],
    },
    expected: {
      treatments: ['INCIERTO'],
      requiredWarnings: ['POSSIBLE_SUBSTITUTION'],
    },
  },
  {
    caseId: 'bpe_01',
    category: 'L. BPE',
    kind: 'express',
    description: 'Baño de pintura exterior',
    input: {
      express: {
        lines: [
          {
            servicio: 'Baño de Pintura Exterior',
            canonical: 'Baño de Pintura Exterior',
            tipo: 'bano_pintura',
            precioLineaMx: 28000,
          },
        ],
        vehicleDisplayLabel: 'Nissan March 2018',
      },
    },
    expected: {
      total: 28000,
      isPartial: false,
      quoteFlowMode: 'CANONICAL',
    },
  },
  {
    caseId: 'bpei_01',
    category: 'M. BPEI',
    kind: 'express',
    description: 'Baño exterior e interiores (importe de catálogo BPEI)',
    input: {
      express: {
        lines: [
          {
            servicio: 'Baño de Pintura Exterior e Interiores',
            canonical: 'Baño de Pintura Exterior e Interiores',
            tipo: 'bano_pintura',
            precioLineaMx: 32000,
          },
        ],
        vehicleDisplayLabel: 'Jetta 2019',
      },
    },
    expected: {
      total: 32000,
      isPartial: false,
    },
  },
  {
    caseId: 'bpcc_01',
    category: 'N. BPCC',
    kind: 'express',
    description:
      'BPCC oficial: Baño de Pintura con Cambio de Color BASE $39,000 (sin fórmula legacy)',
    input: {
      express: {
        lines: [
          {
            servicio: 'Baño de Pintura con Cambio de Color',
            canonical: 'Baño de Pintura con Cambio de Color',
            tipo: 'bano_pintura',
            precioLineaMx: 39000,
          },
        ],
        vehicleDisplayLabel: 'Nissan March',
      },
    },
    expected: {
      total: 39000,
      isPartial: false,
    },
  },
  {
    caseId: 'express_una_pieza_01',
    category: 'O. express una pieza',
    kind: 'express',
    description: 'Repintado express de fascia',
    input: {
      express: {
        lines: [
          { servicio: 'Fascia', canonical: 'Fascia', precioLineaMx: 4500 },
        ],
        vehicleDisplayLabel: 'Aveo 2015',
      },
    },
    expected: { total: 4500, isPartial: false },
  },
  {
    caseId: 'express_multi_pieza_01',
    category: 'P. express múltiples piezas',
    kind: 'express',
    description: 'Fascia + puerta express',
    input: {
      express: {
        lines: [
          { servicio: 'Fascia', canonical: 'Fascia', precioLineaMx: 4500 },
          { servicio: 'Puerta', canonical: 'Puerta', precioLineaMx: 3800 },
        ],
        vehicleDisplayLabel: 'Aveo 2015',
      },
    },
    expected: { total: 8300 },
  },
  {
    caseId: 'extra_comercial_01',
    category: 'Q. extra comercial',
    kind: 'commercial',
    description: 'Servicio comercial sin daño visual',
    input: {
      express: {
        lines: [
          { servicio: 'Pulido', canonical: 'Pulido', precioLineaMx: 1800 },
        ],
        extras: [{ label: 'Cerámico', amount: 2500 }],
        vehicleDisplayLabel: 'Civic 2017',
      },
    },
    expected: { total: 4300, quoteFlowMode: 'CANONICAL' },
  },
  {
    caseId: 'visual_mas_extra_01',
    category: 'R. carrito visual + extra express',
    kind: 'vision',
    description: 'Reparación visual + extra comercial',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({ pieza: 'Puerta', tratamiento: 'REPARAR', severidad: 'DM' }),
      ],
      extraLines: [{ label: 'Lavado premium', amount: 1500 }],
    },
    expected: {
      treatments: ['REPARAR'],
      total: 6000,
    },
  },
  {
    caseId: 'panel_manual_01',
    category: 'S. panel override manual',
    kind: 'panel_manual',
    description: 'Precio capturado por operador',
    input: { manualAmount: 8888 },
    expected: {
      total: 8888,
      pricingSource: 'MANUAL',
    },
  },
  {
    caseId: 'multi_vehiculo_01',
    category: 'T. multi-vehículo',
    kind: 'multi_vehicle',
    description: 'Quotes separados y agregado determinista',
    input: {
      express: {
        lines: [
          {
            servicio: 'Baño de Pintura Exterior',
            precioLineaMx: 15000,
            tipo: 'bano_pintura',
          },
        ],
        vehicleDisplayLabel: 'Aveo 2015',
      },
      secondVehicleExpress: {
        lines: [
          {
            servicio: 'Baño de Pintura Exterior',
            precioLineaMx: 25000,
            tipo: 'bano_pintura',
          },
        ],
        vehicleDisplayLabel: 'Jetta 2019',
      },
    },
    expected: {
      total: 40000,
      distinctVehicleIds: true,
    },
  },
  {
    caseId: 'adv_texto_vs_lock_reparar_01',
    category: 'ADV.1 texto vs lock REPARAR',
    kind: 'vision',
    description: 'Descripción “hecha pedazos” no rompe lock REPARAR',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({
          pieza: 'Puerta',
          tratamiento: 'REPARAR',
          descripcionTecnica: 'hecha pedazos',
        }),
      ],
      priorTreatments: [{ pieza: 'Puerta', treatment: 'REPARAR' }],
    },
    expected: {
      treatments: ['REPARAR'],
      forbiddenServiceTypes: ['REFACCION'],
    },
  },
  {
    caseId: 'adv_texto_vs_lock_sustituir_01',
    category: 'ADV.2 texto vs lock SUSTITUIR',
    kind: 'vision',
    description: '“rayón leve” no degrada SUSTITUIR locked',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({
          pieza: 'Fascia',
          tratamiento: 'SUSTITUIR',
          descripcionTecnica: 'rayón leve',
          precioMx: 6500,
          pricingStatus: 'OK',
        }),
      ],
      priorTreatments: [{ pieza: 'Fascia', treatment: 'SUSTITUIR' }],
    },
    expected: {
      treatments: ['SUSTITUIR'],
      quoteLines: [
        { serviceType: 'REFACCION' },
        { serviceType: 'MONTAJE_PINTURA' },
      ],
    },
  },
  {
    caseId: 'adv_amount_no_billable_01',
    category: 'ADV.3 amount+billable false',
    kind: 'adversarial_safety',
    description: 'amount>0 billable false no suma',
    input: {
      forcedQuoteLines: [
        {
          serviceType: 'REFACCION',
          amount: 9900,
          billable: false,
          pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
          description: 'Refacción fascia',
        },
        {
          serviceType: 'MONTAJE_PINTURA',
          amount: 3400,
          billable: true,
          description: 'Montaje fascia',
        },
      ],
    },
    expected: {
      total: 3400,
      isPartial: true,
    },
  },
  {
    caseId: 'adv_refaccion_amount_accidental_01',
    category: 'ADV.4 REFACCION insuficiente con amount',
    kind: 'adversarial_safety',
    description: 'INSUFFICIENT no es cobrable aunque amount>0',
    input: {
      forcedQuoteLines: [
        {
          serviceType: 'REFACCION',
          amount: 6500,
          billable: false,
          pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
          pricingSource: 'INSUFFICIENT_MARKET_SAMPLE',
        },
      ],
    },
    expected: {
      total: 0,
      isPartial: true,
      requiredWarnings: ['REFACCION_PENDIENTE_DE_COTIZAR'],
    },
  },
  {
    caseId: 'adv_filas_reordenadas_01',
    category: 'ADV.5 filas reordenadas',
    kind: 'express',
    description: 'Orden de líneas no cambia total',
    input: {
      express: {
        lines: [
          { servicio: 'Puerta', precioLineaMx: 3800 },
          { servicio: 'Fascia', precioLineaMx: 4500 },
        ],
        vehicleDisplayLabel: 'Aveo 2015',
      },
    },
    expected: { total: 8300 },
  },
  {
    caseId: 'adv_danos_reordenados_01',
    category: 'ADV.6 daños reordenados',
    kind: 'vision',
    description: 'Inventario invertido; mismo total que multi_pieza',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({
          pieza: 'Fascia',
          tratamiento: 'SUSTITUIR',
          precioMx: 6500,
          pricingStatus: 'OK',
          urls_origen: ['https://cdn.example/fd.jpg'],
        }),
        item({ pieza: 'Puerta', tratamiento: 'REPARAR', severidad: 'DM' }),
      ],
    },
    expected: { total: 14400 },
  },
  {
    caseId: 'adv_misma_pieza_dos_vehiculos_01',
    category: 'ADV.7 misma pieza dos vehículos',
    kind: 'multi_vehicle',
    description: 'Fascia en A y B no comparte DamageItem',
    input: {
      express: {
        lines: [{ servicio: 'Fascia', precioLineaMx: 4500 }],
        vehicleDisplayLabel: 'Aveo 2015',
      },
      secondVehicleExpress: {
        lines: [{ servicio: 'Fascia', precioLineaMx: 5200 }],
        vehicleDisplayLabel: 'Jetta 2019',
      },
    },
    expected: {
      total: 9700,
      distinctVehicleIds: true,
    },
  },
  {
    caseId: 'adv_llm_99000_01',
    category: 'ADV.8 LLM $99,000',
    kind: 'express',
    description: 'Narrativa intenta inventar un total',
    input: {
      express: {
        lines: [{ servicio: 'Fascia', precioLineaMx: 4500 }],
        vehicleDisplayLabel: 'Aveo 2015',
      },
      injectedLlmParts: {
        intro: 'Te lo dejo en $99,000 MXN',
        technicalExplanation: '',
        cta: 'Dime un día',
      },
    },
    expected: {
      total: 4500,
      noInventedMoney: true,
    },
  },
  {
    caseId: 'adv_llm_omite_linea_01',
    category: 'ADV.9 LLM omite línea',
    kind: 'express',
    description: 'El financialBlock determinista no puede omitir líneas',
    input: {
      express: {
        lines: [
          { servicio: 'Fascia', precioLineaMx: 4500 },
          { servicio: 'Puerta', precioLineaMx: 3800 },
        ],
        vehicleDisplayLabel: 'Aveo 2015',
      },
      injectedLlmParts: {
        intro: 'Solo te cotizo la fascia',
        technicalExplanation: '',
        cta: 'Avísame',
      },
    },
    expected: {
      total: 8300,
      quoteLines: [
        { serviceType: 'REPARACION_PINTURA' },
        { serviceType: 'REPARACION_PINTURA' },
      ],
    },
  },
  {
    caseId: 'adv_llm_anade_linea_01',
    category: 'ADV.10 LLM añade línea',
    kind: 'express',
    description: 'Texto extra no crea cargo',
    input: {
      express: {
        lines: [{ servicio: 'Fascia', precioLineaMx: 4500 }],
        vehicleDisplayLabel: 'Aveo 2015',
      },
      injectedLlmParts: {
        intro: 'También incluí pulido de faros',
        technicalExplanation: '',
        cta: 'Avísame',
      },
    },
    expected: { total: 4500 },
  },
  {
    caseId: 'adv_llm_repite_total_01',
    category: 'ADV.11 LLM repite total',
    kind: 'express',
    description: 'Importe fuera del financialBlock se descarta',
    input: {
      express: {
        lines: [{ servicio: 'Fascia', precioLineaMx: 4500 }],
        vehicleDisplayLabel: 'Aveo 2015',
      },
      injectedLlmParts: {
        intro: 'El total es $4,500 MXN otra vez',
        technicalExplanation: '',
        cta: 'Avísame',
      },
    },
    expected: { total: 4500, noInventedMoney: true },
  },
  {
    caseId: 'adv_frontend_fallback_01',
    category: 'ADV.12 frontend fallback',
    kind: 'adversarial_safety',
    description: 'Panel moderno no reconstruye total local',
    input: { simulateFrontendFallback: true },
    expected: {
      usedLocalFinance: false,
      noUnsafeLegacyFallback: true,
      quoteFlowMode: 'CANONICAL',
    },
  },
  {
    caseId: 'adv_rebuild_falla_01',
    category: 'ADV.13 rebuild moderno falla',
    kind: 'vision',
    description: 'Fallo de rebuild no degrada a legacy con dinero',
    input: {
      vehicleContext: 'Mazda 3 2020',
      visionItems: [
        item({ pieza: 'Puerta', tratamiento: 'REPARAR' }),
      ],
      simulateRebuildFailure: true,
    },
    expected: {
      noUnsafeLegacyFallback: true,
      treatments: ['REPARAR'],
    },
  },
  {
    caseId: 'adv_no_downgrade_01',
    category: 'ADV.14 carrito no downgrade',
    kind: 'adversarial_safety',
    description: 'CANONICAL locked no cae a LEGACY',
    input: { simulateDowngrade: true },
    expected: {
      quoteFlowMode: 'CANONICAL',
      noUnsafeLegacyFallback: true,
    },
  },
  {
    caseId: 'adv_openai_falla_01',
    category: 'ADV.15 OpenAI narrativo falla',
    kind: 'express',
    description: 'Fallo de narrativa → fallback determinista',
    input: {
      express: {
        lines: [{ servicio: 'Fascia', precioLineaMx: 4500 }],
        vehicleDisplayLabel: 'Aveo 2015',
      },
      simulateOpenaiFailure: true,
    },
    expected: {
      total: 4500,
      noInventedMoney: true,
      quoteFlowMode: 'CANONICAL',
    },
  },
];
