/**
 * Coordinate-Anchored Opt-In Synthetic Demo Property & AVM Generator
 * (`src/server/property/syntheticFixtures.ts`)
 *
 * Used ONLY when `config.enableSyntheticDemoMode` is true and the caller explicitly
 * opts into `useSyntheticDemo: true`.
 *
 * Key Guarantees:
 * - Anchors listings dynamically around ANY user-selected US `AnalysisArea`
 *   (never hardcoded to Berkeley, CA).
 * - Explicitly tags every listing and AVM record with `dataProvenance: "synthetic_demo"`.
 * - Initial search returns `avmPrice: null` (`rangePosition: "no_avm"`), and on-demand
 *   `buildSyntheticAvmForProperty` populates distinct `avmPrice`, `avmLow`, `avmHigh`,
 *   `avmFetchedAt`, `lastSalePrice`, `lastSaleDate`, `assessedValue`, `comparablesSummary`,
 *   `priceGap`, and `contraryEvidence` covering all required verification scenarios.
 */

import type {
  AnalysisArea,
  ComparableListingRecord,
  ComparablesSummary,
  PropertyDetailRecord,
  PropertyListingSummary,
} from '../../shared/types';
import { computePriceGap } from '../geospatial/scoring';
import { buildContraryEvidence } from './rentcastClient';

interface SyntheticPropertyBlueprint {
  readonly suffix: string;
  readonly streetNumber: number;
  readonly streetName: string;
  readonly latOffsetFactor: number;
  readonly lngOffsetFactor: number;
  readonly propertyType: string;
  readonly bedrooms: number;
  readonly bathrooms: number;
  readonly squareFootage: number;
  readonly lotSize: number;
  readonly yearBuilt: number;
  readonly askingPrice: number;
  readonly avmPrice: number;
  readonly avmLow: number | null;
  readonly avmHigh: number | null;
  readonly lastSalePrice: number;
  readonly lastSaleDate: string;
  readonly assessedValue: number;
  readonly assessedYear: number;
  readonly includeSubjectInComps: boolean;
}

const SYNTHETIC_BLUEPRINTS: readonly SyntheticPropertyBlueprint[] = [
  {
    suffix: '01',
    streetNumber: 412,
    streetName: 'Oak Ridge Ave (Synthetic Demo)',
    latOffsetFactor: 0.22,
    lngOffsetFactor: -0.18,
    propertyType: 'Single Family',
    bedrooms: 3,
    bathrooms: 2,
    squareFootage: 1840,
    lotSize: 5400,
    yearBuilt: 1998,
    askingPrice: 450_000,
    avmPrice: 500_000,
    avmLow: 465_000,
    avmHigh: 535_000,
    lastSalePrice: 368_000,
    lastSaleDate: '2021-06-15T00:00:00.000Z',
    assessedValue: 412_000,
    assessedYear: 2025,
    includeSubjectInComps: false,
  },
  {
    suffix: '02',
    streetNumber: 1234,
    streetName: 'Cedar Park Blvd (Synthetic Demo)',
    latOffsetFactor: -0.19,
    lngOffsetFactor: 0.24,
    propertyType: 'Single Family',
    bedrooms: 4,
    bathrooms: 3,
    squareFootage: 2620,
    lotSize: 6800,
    yearBuilt: 2012,
    // Canonical scenario: AVM=1,000,000, ask=900,000, range=[850,000, 1,150,000] => +10.0% AND in_range
    askingPrice: 900_000,
    avmPrice: 1_000_000,
    avmLow: 850_000,
    avmHigh: 1_150_000,
    lastSalePrice: 745_000,
    lastSaleDate: '2019-09-20T00:00:00.000Z',
    assessedValue: 820_000,
    assessedYear: 2025,
    includeSubjectInComps: false,
  },
  {
    suffix: '03',
    streetNumber: 788,
    streetName: 'Maple Commons Way #3B (Synthetic Demo)',
    latOffsetFactor: 0.31,
    lngOffsetFactor: 0.27,
    propertyType: 'Condo',
    bedrooms: 2,
    bathrooms: 2,
    squareFootage: 1310,
    lotSize: 1500,
    yearBuilt: 2017,
    askingPrice: 540_000,
    avmPrice: 575_000,
    avmLow: 520_000,
    avmHigh: 630_000,
    lastSalePrice: 482_000,
    lastSaleDate: '2022-04-11T00:00:00.000Z',
    assessedValue: 505_000,
    assessedYear: 2025,
    includeSubjectInComps: true,
  },
  {
    suffix: '04',
    streetNumber: 915,
    streetName: 'Highland Terrace Dr (Synthetic Demo)',
    latOffsetFactor: -0.28,
    lngOffsetFactor: -0.25,
    propertyType: 'Townhouse',
    bedrooms: 3,
    bathrooms: 2.5,
    squareFootage: 1960,
    lotSize: 2800,
    yearBuilt: 2015,
    askingPrice: 695_000,
    avmPrice: 630_000,
    avmLow: 590_000,
    avmHigh: 670_000,
    lastSalePrice: 560_000,
    lastSaleDate: '2020-11-03T00:00:00.000Z',
    assessedValue: 598_000,
    assessedYear: 2025,
    includeSubjectInComps: false,
  },
  {
    suffix: '05',
    streetNumber: 204,
    streetName: 'Elmwood Station Ln (Synthetic Demo)',
    latOffsetFactor: 0.08,
    lngOffsetFactor: -0.34,
    propertyType: 'Single Family',
    bedrooms: 4,
    bathrooms: 2.5,
    squareFootage: 2290,
    lotSize: 6100,
    yearBuilt: 2004,
    askingPrice: 780_000,
    avmPrice: 815_000,
    avmLow: null,
    avmHigh: null,
    lastSalePrice: 625_000,
    lastSaleDate: '2018-08-14T00:00:00.000Z',
    assessedValue: 710_000,
    assessedYear: 2025,
    includeSubjectInComps: false,
  },
  {
    suffix: '06',
    streetNumber: 1510,
    streetName: 'Sycamore Grove Ct (Synthetic Demo)',
    latOffsetFactor: -0.12,
    lngOffsetFactor: 0.09,
    propertyType: 'Single Family',
    bedrooms: 3,
    bathrooms: 2,
    squareFootage: 1750,
    lotSize: 5100,
    yearBuilt: 1994,
    askingPrice: 615_000,
    avmPrice: 650_000,
    avmLow: 595_000,
    avmHigh: 705_000,
    lastSalePrice: 490_000,
    lastSaleDate: '2020-02-28T00:00:00.000Z',
    assessedValue: 572_000,
    assessedYear: 2025,
    includeSubjectInComps: false,
  },
];

function areaSlug(area: AnalysisArea): string {
  return area.areaId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 48);
}

/**
 * Generates up to `limit` (`<= 25`) synthetic demo listings anchored around `analysisArea`.
 * Consistent with live search rules, AVMs are NOT pre-populated during search (`avmPrice: null`).
 */
export function buildSyntheticListingsForArea(
  analysisArea: AnalysisArea,
  limit = 6,
  propertyTypeFilter?: string
): PropertyListingSummary[] {
  const safeLimit = Math.max(1, Math.min(25, limit));
  const latRadiusDeg = (analysisArea.radiusMeters / 111_320) * 0.85;
  const cosLat = Math.max(0.2, Math.cos((analysisArea.centerLat * Math.PI) / 180));
  const lngRadiusDeg = ((analysisArea.radiusMeters / 111_320) / cosLat) * 0.85;

  const cityLabel = analysisArea.city ?? analysisArea.label.split(',')[0]?.trim() ?? 'US Metro';
  const stateLabel = analysisArea.state ?? 'US';
  const zipLabel = analysisArea.zipCode ?? '00000';
  const slug = areaSlug(analysisArea);

  const filteredBlueprints =
    propertyTypeFilter && propertyTypeFilter !== 'Other'
      ? SYNTHETIC_BLUEPRINTS.filter(
          (b) => b.propertyType.toLowerCase() === propertyTypeFilter.toLowerCase()
        )
      : SYNTHETIC_BLUEPRINTS;

  const sourceBlueprints =
    filteredBlueprints.length > 0 ? filteredBlueprints : SYNTHETIC_BLUEPRINTS;

  return sourceBlueprints.slice(0, safeLimit).map((bp) => {
    const lat = Number(
      (analysisArea.centerLat + bp.latOffsetFactor * latRadiusDeg).toFixed(6)
    );
    const lng = Number(
      (analysisArea.centerLng + bp.lngOffsetFactor * lngRadiusDeg).toFixed(6)
    );
    const formattedAddress = `${bp.streetNumber} ${bp.streetName}, ${cityLabel}, ${stateLabel} ${zipLabel}`;
    const id = `syn-${slug}-${bp.suffix}`;

    return {
      id,
      formattedAddress,
      city: cityLabel,
      state: stateLabel,
      zipCode: zipLabel,
      latitude: lat,
      longitude: lng,
      propertyType: bp.propertyType,
      bedrooms: bp.bedrooms,
      bathrooms: bp.bathrooms,
      squareFootage: bp.squareFootage,
      lotSize: bp.lotSize,
      yearBuilt: bp.yearBuilt,
      askingPrice: bp.askingPrice,
      listingLastSeenAt: '2026-11-13T18:00:00.000Z',
      avmPrice: null,
      avmLow: null,
      avmHigh: null,
      avmFetchedAt: null,
      lastSalePrice: bp.lastSalePrice,
      lastSaleDate: bp.lastSaleDate,
      assessedValue: bp.assessedValue,
      assessedYear: bp.assessedYear,
      comparablesSummary: null,
      priceGap: computePriceGap({
        askingPrice: bp.askingPrice,
        avmPrice: null,
        avmLow: null,
        avmHigh: null,
      }),
      accessibility: null,
      nearbyEnvironmentalCount: 0,
      dataProvenance: 'synthetic_demo',
    };
  });
}

/**
 * Generates on-demand synthetic demo AVM valuation & comparables for a selected property.
 */
export function buildSyntheticAvmForProperty(
  subject: PropertyListingSummary,
  fetchedAt = new Date().toISOString()
): PropertyDetailRecord {
  const matchedBlueprint =
    SYNTHETIC_BLUEPRINTS.find((bp) => subject.id.endsWith(`-${bp.suffix}`)) ??
    SYNTHETIC_BLUEPRINTS[0]!;

  const askingPrice = subject.askingPrice ?? matchedBlueprint.askingPrice;
  const avmPrice = matchedBlueprint.avmPrice;
  const avmLow = matchedBlueprint.avmLow;
  const avmHigh = matchedBlueprint.avmHigh;

  const cityLabel = subject.city ?? 'US Metro';
  const stateLabel = subject.state ?? 'US';
  const zipLabel = subject.zipCode ?? '00000';

  const comparables: ComparableListingRecord[] = [
    {
      id: `${subject.id}-comp-1`,
      formattedAddress: `108 Neighboring Elm St (Synthetic Comp), ${cityLabel}, ${stateLabel} ${zipLabel}`,
      propertyType: subject.propertyType,
      bedrooms: subject.bedrooms,
      bathrooms: subject.bathrooms,
      squareFootage: subject.squareFootage ? subject.squareFootage - 40 : 1800,
      price: Math.round(avmPrice * 0.98),
      status: 'Active',
      lastSeenAt: '2026-11-10T12:00:00.000Z',
      distanceMiles: 0.24,
      correlation: 0.96,
      daysOld: 14,
      isSubjectDuplicate: false,
    },
    {
      id: `${subject.id}-comp-2`,
      formattedAddress: `245 Nearby Pine Rd (Synthetic Comp), ${cityLabel}, ${stateLabel} ${zipLabel}`,
      propertyType: subject.propertyType,
      bedrooms: subject.bedrooms,
      bathrooms: subject.bathrooms,
      squareFootage: subject.squareFootage ? subject.squareFootage + 65 : 1920,
      price: Math.round(avmPrice * 1.03),
      status: 'Active',
      lastSeenAt: '2026-11-08T15:30:00.000Z',
      distanceMiles: 0.41,
      correlation: 0.94,
      daysOld: 22,
      isSubjectDuplicate: false,
    },
    {
      id: `${subject.id}-comp-3`,
      formattedAddress: `519 Birchwood Ln (Synthetic Comp), ${cityLabel}, ${stateLabel} ${zipLabel}`,
      propertyType: subject.propertyType,
      bedrooms: subject.bedrooms,
      bathrooms: subject.bathrooms,
      squareFootage: subject.squareFootage ?? 1850,
      price: avmPrice,
      status: 'Active',
      lastSeenAt: '2026-11-05T09:15:00.000Z',
      distanceMiles: 0.58,
      correlation: 0.91,
      daysOld: 31,
      isSubjectDuplicate: false,
    },
  ];

  if (matchedBlueprint.includeSubjectInComps) {
    comparables.unshift({
      id: subject.id,
      formattedAddress: subject.formattedAddress,
      propertyType: subject.propertyType,
      bedrooms: subject.bedrooms,
      bathrooms: subject.bathrooms,
      squareFootage: subject.squareFootage,
      price: askingPrice,
      status: 'Active',
      lastSeenAt: subject.listingLastSeenAt ?? '2026-11-13T18:00:00.000Z',
      distanceMiles: 0,
      correlation: 1.0,
      daysOld: 2,
      isSubjectDuplicate: true,
    });
  }

  const comparablesSummary: ComparablesSummary = {
    compCount: comparables.length,
    medianCompPrice: avmPrice,
    minDistanceMiles: matchedBlueprint.includeSubjectInComps ? 0 : 0.24,
    maxDistanceMiles: 0.58,
    meanCorrelation: 0.94,
    subjectIncludedInComps: matchedBlueprint.includeSubjectInComps,
    comparables,
  };

  const priceGap = computePriceGap({
    askingPrice,
    avmPrice,
    avmLow,
    avmHigh,
  });

  const updatedBase: PropertyListingSummary = {
    ...subject,
    askingPrice,
    avmPrice,
    avmLow,
    avmHigh,
    avmFetchedAt: fetchedAt,
    lastSalePrice: subject.lastSalePrice ?? matchedBlueprint.lastSalePrice,
    lastSaleDate: subject.lastSaleDate ?? matchedBlueprint.lastSaleDate,
    assessedValue: subject.assessedValue ?? matchedBlueprint.assessedValue,
    assessedYear: subject.assessedYear ?? matchedBlueprint.assessedYear,
    comparablesSummary,
    priceGap,
    dataProvenance: 'synthetic_demo',
  };

  const contraryEvidence = buildContraryEvidence({
    property: updatedBase,
    comparablesSummary,
    priceGap,
  });

  return {
    ...updatedBase,
    contraryEvidence,
  };
}
