import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Reglas de multiplicadores por taller (JSON). */
@Entity({ name: 'catalog_pricing_rules' })
export class CatalogPricingRulesEntity {
  @PrimaryColumn({ type: 'uuid' })
  tallerId: string;

  @Column({ type: 'text' })
  rulesJson: string;
}
