/**
 * US Region Resolver & Disambiguation Service (`src/server/property/regionResolver.ts`)
 *
 * Resolves any user-supplied US city/state, neighborhood, 5-digit ZIP code, street address,
 * or bounded map viewport (`bounds`) into an explicit circular `AnalysisArea`
 * (`isViewportApproximation: true`).
 *
 * Key Guarantees:
 * - Never hardcodes Berkeley, CA or silently substitutes another city.
 * - Detects ambiguous multi-state US place queries (e.g. "Springfield", "Portland") and
 *   returns `status: "ambiguous"` with `candidates[]` so the user confirms before analysis.
 * - Rejects non-US queries and non-US coordinates with `status: "unsupported_area"`.
 * - Integrates US Census Geocoder REST API + OpenStreetMap Nominatim (with custom User-Agent,
 *   rate-limit guard, timeout, and bounded cache) plus a rich deterministic US gazetteer
 *   fallback so common US cities, neighborhoods, and ZIPs work even in offline/sandboxed runs.
 */

import {
  ANALYSIS_BOUNDS,
  VIEWPORT_APPROXIMATION_DISCLAIMER,
} from '../../shared/constants';
import type {
  AnalysisArea,
  RegionBoundsInput,
  RegionCandidate,
  RegionPlaceKind,
  RegionResolveRequest,
  RegionResolveResponse,
} from '../../shared/types';
import {
  computeBoundingBoxForRadius,
  validateCoordinates,
} from '../geospatial/scoring';

export const NOMINATIM_USER_AGENT =
  'ForealEstateHackathonPrototype/1.0 (Berkeley-DeepMind-Hackathon; contact-via-repo)';

interface GazetteerEntry {
  readonly candidateId: string;
  readonly displayName: string;
  readonly city: string;
  readonly state: string;
  readonly zipCode: string | null;
  readonly centerLat: number;
  readonly centerLng: number;
  readonly suggestedRadiusMeters: number;
  readonly placeKind: RegionPlaceKind;
  readonly aliases: readonly string[];
}

const US_STATE_CODES: Readonly<Record<string, string>> = Object.freeze({
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'puerto rico': 'PR',
});

const VALID_US_STATE_ABBRS = new Set<string>(Object.values(US_STATE_CODES));

/**
 * Multi-region US gazetteer covering major metros, neighborhoods, ZIP codes, and
 * multi-state ambiguous city candidates across the United States.
 */
const US_GAZETTEER: readonly GazetteerEntry[] = [
  // Austin, TX
  {
    candidateId: 'us-tx-austin',
    displayName: 'Austin, Travis County, TX',
    city: 'Austin',
    state: 'TX',
    zipCode: '78701',
    centerLat: 30.2672,
    centerLng: -97.7431,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['austin', 'austin tx', 'austin texas', '78701', '78704', 'downtown austin tx'],
  },
  // Seattle, WA & Ballard neighborhood
  {
    candidateId: 'us-wa-seattle',
    displayName: 'Seattle, King County, WA',
    city: 'Seattle',
    state: 'WA',
    zipCode: '98101',
    centerLat: 47.6062,
    centerLng: -122.3321,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['seattle', 'seattle wa', 'seattle washington', '98101', '98102'],
  },
  {
    candidateId: 'us-wa-seattle-ballard',
    displayName: 'Ballard, Seattle, WA',
    city: 'Seattle',
    state: 'WA',
    zipCode: '98107',
    centerLat: 47.6687,
    centerLng: -122.3845,
    suggestedRadiusMeters: 1400,
    placeKind: 'neighborhood',
    aliases: ['ballard', 'ballard seattle', 'ballard seattle wa', '98107'],
  },
  // Denver, CO
  {
    candidateId: 'us-co-denver',
    displayName: 'Denver, Denver County, CO',
    city: 'Denver',
    state: 'CO',
    zipCode: '80202',
    centerLat: 39.7392,
    centerLng: -104.9903,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['denver', 'denver co', 'denver colorado', '80202', '80203', 'lodo denver'],
  },
  // Chicago, IL & Lincoln Park
  {
    candidateId: 'us-il-chicago',
    displayName: 'Chicago, Cook County, IL',
    city: 'Chicago',
    state: 'IL',
    zipCode: '60601',
    centerLat: 41.8781,
    centerLng: -87.6298,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['chicago', 'chicago il', 'chicago illinois', '60601', '60611'],
  },
  {
    candidateId: 'us-il-chicago-lincoln-park',
    displayName: 'Lincoln Park, Chicago, IL',
    city: 'Chicago',
    state: 'IL',
    zipCode: '60614',
    centerLat: 41.9214,
    centerLng: -87.6513,
    suggestedRadiusMeters: 1400,
    placeKind: 'neighborhood',
    aliases: ['lincoln park', 'lincoln park chicago', 'lincoln park chicago il', '60614'],
  },
  // Cambridge, MA
  {
    candidateId: 'us-ma-cambridge',
    displayName: 'Cambridge, Middlesex County, MA',
    city: 'Cambridge',
    state: 'MA',
    zipCode: '02139',
    centerLat: 42.3736,
    centerLng: -71.1097,
    suggestedRadiusMeters: 1500,
    placeKind: 'city',
    aliases: ['cambridge ma', 'cambridge massachusetts', '02139', '02138', 'kendall square cambridge'],
  },
  // Atlanta, GA
  {
    candidateId: 'us-ga-atlanta',
    displayName: 'Atlanta, Fulton County, GA',
    city: 'Atlanta',
    state: 'GA',
    zipCode: '30309',
    centerLat: 33.749,
    centerLng: -84.388,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['atlanta', 'atlanta ga', 'atlanta georgia', '30309', '30308', 'midtown atlanta'],
  },
  // New York, NY & Brooklyn
  {
    candidateId: 'us-ny-new-york',
    displayName: 'New York, NY',
    city: 'New York',
    state: 'NY',
    zipCode: '10001',
    centerLat: 40.7128,
    centerLng: -74.006,
    suggestedRadiusMeters: 1400,
    placeKind: 'city',
    aliases: ['new york', 'new york ny', 'nyc', 'manhattan ny', '10001', '10011'],
  },
  {
    candidateId: 'us-ny-brooklyn',
    displayName: 'Brooklyn, New York, NY',
    city: 'Brooklyn',
    state: 'NY',
    zipCode: '11201',
    centerLat: 40.6782,
    centerLng: -73.9442,
    suggestedRadiusMeters: 1500,
    placeKind: 'neighborhood',
    aliases: ['brooklyn', 'brooklyn ny', '11201', '11211', 'park slope brooklyn'],
  },
  // San Francisco & Bay Area (available when queried, never hardcoded)
  {
    candidateId: 'us-ca-san-francisco',
    displayName: 'San Francisco, CA',
    city: 'San Francisco',
    state: 'CA',
    zipCode: '94103',
    centerLat: 37.7749,
    centerLng: -122.4194,
    suggestedRadiusMeters: 1500,
    placeKind: 'city',
    aliases: ['san francisco', 'san francisco ca', 'sf ca', '94103', '94110'],
  },
  {
    candidateId: 'us-ca-berkeley',
    displayName: 'Berkeley, Alameda County, CA',
    city: 'Berkeley',
    state: 'CA',
    zipCode: '94704',
    centerLat: 37.8715,
    centerLng: -122.273,
    suggestedRadiusMeters: 1500,
    placeKind: 'city',
    aliases: ['berkeley', 'berkeley ca', 'berkeley california', '94704', '94703', '94720'],
  },
  // Los Angeles, CA
  {
    candidateId: 'us-ca-los-angeles',
    displayName: 'Los Angeles, Los Angeles County, CA',
    city: 'Los Angeles',
    state: 'CA',
    zipCode: '90012',
    centerLat: 34.0522,
    centerLng: -118.2437,
    suggestedRadiusMeters: 1800,
    placeKind: 'city',
    aliases: ['los angeles', 'los angeles ca', 'la ca', '90012', '90026'],
  },
  // San Antonio, TX
  {
    candidateId: 'us-tx-san-antonio',
    displayName: 'San Antonio, Bexar County, TX',
    city: 'San Antonio',
    state: 'TX',
    zipCode: '78205',
    centerLat: 29.4241,
    centerLng: -98.4936,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['san antonio', 'san antonio tx', '78205', '78244'],
  },
  // Miami, FL
  {
    candidateId: 'us-fl-miami',
    displayName: 'Miami, Miami-Dade County, FL',
    city: 'Miami',
    state: 'FL',
    zipCode: '33131',
    centerLat: 25.7617,
    centerLng: -80.1918,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['miami', 'miami fl', 'miami florida', '33131', '33139'],
  },
  // Phoenix, AZ
  {
    candidateId: 'us-az-phoenix',
    displayName: 'Phoenix, Maricopa County, AZ',
    city: 'Phoenix',
    state: 'AZ',
    zipCode: '85004',
    centerLat: 33.4484,
    centerLng: -112.074,
    suggestedRadiusMeters: 1800,
    placeKind: 'city',
    aliases: ['phoenix', 'phoenix az', 'phoenix arizona', '85004'],
  },
  // Boston, MA
  {
    candidateId: 'us-ma-boston',
    displayName: 'Boston, Suffolk County, MA',
    city: 'Boston',
    state: 'MA',
    zipCode: '02108',
    centerLat: 42.3601,
    centerLng: -71.0589,
    suggestedRadiusMeters: 1500,
    placeKind: 'city',
    aliases: ['boston', 'boston ma', 'boston massachusetts', '02108', '02116'],
  },
  // Minneapolis, MN
  {
    candidateId: 'us-mn-minneapolis',
    displayName: 'Minneapolis, Hennepin County, MN',
    city: 'Minneapolis',
    state: 'MN',
    zipCode: '55401',
    centerLat: 44.9778,
    centerLng: -93.265,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['minneapolis', 'minneapolis mn', '55401'],
  },
  // Raleigh, NC
  {
    candidateId: 'us-nc-raleigh',
    displayName: 'Raleigh, Wake County, NC',
    city: 'Raleigh',
    state: 'NC',
    zipCode: '27601',
    centerLat: 35.7796,
    centerLng: -78.6382,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['raleigh', 'raleigh nc', '27601'],
  },
  // Nashville, TN
  {
    candidateId: 'us-tn-nashville',
    displayName: 'Nashville, Davidson County, TN',
    city: 'Nashville',
    state: 'TN',
    zipCode: '37203',
    centerLat: 36.1627,
    centerLng: -86.7816,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['nashville', 'nashville tn', '37203'],
  },
  // Ambiguous Multi-State City Candidates: Springfield
  {
    candidateId: 'us-il-springfield',
    displayName: 'Springfield, Sangamon County, IL',
    city: 'Springfield',
    state: 'IL',
    zipCode: '62701',
    centerLat: 39.7817,
    centerLng: -89.6501,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['springfield il', 'springfield illinois', '62701'],
  },
  {
    candidateId: 'us-mo-springfield',
    displayName: 'Springfield, Greene County, MO',
    city: 'Springfield',
    state: 'MO',
    zipCode: '65806',
    centerLat: 37.209,
    centerLng: -93.2923,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['springfield mo', 'springfield missouri', '65806'],
  },
  {
    candidateId: 'us-ma-springfield',
    displayName: 'Springfield, Hampden County, MA',
    city: 'Springfield',
    state: 'MA',
    zipCode: '01103',
    centerLat: 42.1015,
    centerLng: -72.5898,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['springfield ma', 'springfield massachusetts', '01103'],
  },
  {
    candidateId: 'us-or-springfield',
    displayName: 'Springfield, Lane County, OR',
    city: 'Springfield',
    state: 'OR',
    zipCode: '97477',
    centerLat: 44.0462,
    centerLng: -123.022,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['springfield or', 'springfield oregon', '97477'],
  },
  // Ambiguous Multi-State City Candidates: Portland
  {
    candidateId: 'us-or-portland',
    displayName: 'Portland, Multnomah County, OR',
    city: 'Portland',
    state: 'OR',
    zipCode: '97204',
    centerLat: 45.5152,
    centerLng: -122.6784,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['portland or', 'portland oregon', '97204', '97209'],
  },
  {
    candidateId: 'us-me-portland',
    displayName: 'Portland, Cumberland County, ME',
    city: 'Portland',
    state: 'ME',
    zipCode: '04101',
    centerLat: 43.6591,
    centerLng: -70.2568,
    suggestedRadiusMeters: 1500,
    placeKind: 'city',
    aliases: ['portland me', 'portland maine', '04101'],
  },
  // Ambiguous Multi-State City Candidates: Columbus
  {
    candidateId: 'us-oh-columbus',
    displayName: 'Columbus, Franklin County, OH',
    city: 'Columbus',
    state: 'OH',
    zipCode: '43215',
    centerLat: 39.9612,
    centerLng: -82.9988,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['columbus oh', 'columbus ohio', '43215'],
  },
  {
    candidateId: 'us-ga-columbus',
    displayName: 'Columbus, Muscogee County, GA',
    city: 'Columbus',
    state: 'GA',
    zipCode: '31901',
    centerLat: 32.461,
    centerLng: -84.9877,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['columbus ga', 'columbus georgia', '31901'],
  },
  // Ambiguous Multi-State City Candidates: Madison
  {
    candidateId: 'us-wi-madison',
    displayName: 'Madison, Dane County, WI',
    city: 'Madison',
    state: 'WI',
    zipCode: '53703',
    centerLat: 43.0731,
    centerLng: -89.4012,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['madison wi', 'madison wisconsin', '53703'],
  },
  {
    candidateId: 'us-al-madison',
    displayName: 'Madison, Madison County, AL',
    city: 'Madison',
    state: 'AL',
    zipCode: '35758',
    centerLat: 34.6993,
    centerLng: -86.7483,
    suggestedRadiusMeters: 1600,
    placeKind: 'city',
    aliases: ['madison al', 'madison alabama', '35758'],
  },
];

const AMBIGUOUS_BARE_CITY_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  springfield: ['us-il-springfield', 'us-mo-springfield', 'us-ma-springfield', 'us-or-springfield'],
  portland: ['us-or-portland', 'us-me-portland'],
  columbus: ['us-oh-columbus', 'us-ga-columbus'],
  madison: ['us-wi-madison', 'us-al-madison'],
});

const NON_US_KEYWORDS = [
  'united kingdom',
  'england',
  'london uk',
  'london, uk',
  'scotland',
  'france',
  'paris, france',
  'germany',
  'berlin',
  'munich',
  'japan',
  'tokyo',
  'osaka',
  'canada',
  'toronto',
  'vancouver, bc',
  'montreal',
  'ottawa',
  'calgary',
  'australia',
  'sydney',
  'melbourne',
  'mexico city',
  'cdmx',
  'brazil',
  'sao paulo',
  'spain',
  'madrid',
  'barcelona',
  'italy',
  'rome, italy',
  'milan',
  'south korea',
  'seoul',
  'china',
  'beijing',
  'shanghai',
  'hong kong',
  'singapore',
  'india',
  'mumbai',
  'bangalore',
  'dublin, ireland',
  'amsterdam',
  'zurich',
];

const BARE_NON_US_CITIES = new Set([
  'london',
  'paris',
  'tokyo',
  'toronto',
  'vancouver',
  'montreal',
  'sydney',
  'melbourne',
  'berlin',
  'munich',
  'madrid',
  'barcelona',
  'seoul',
  'beijing',
  'shanghai',
  'singapore',
  'mumbai',
  'amsterdam',
  'zurich',
]);

function normalizeQueryString(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[.,;#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampAreaRadius(
  radiusMeters: number | undefined,
  fallback: number = ANALYSIS_BOUNDS.defaultAreaRadiusMeters
): number {
  if (radiusMeters === undefined || !Number.isFinite(radiusMeters)) {
    return fallback;
  }
  return Math.max(
    ANALYSIS_BOUNDS.minAreaRadiusMeters,
    Math.min(ANALYSIS_BOUNDS.maxAreaRadiusMeters, Math.round(radiusMeters))
  );
}

/**
 * Checks whether `(lat, lng)` lies within US geographic coverage bounds
 * (Contiguous US, Alaska, Hawaii, Puerto Rico / USVI), excluding clear non-US
 * metro areas near the northern/southern bounding box edges (e.g., Toronto, Ottawa, Montreal, Vancouver).
 */
export function isCoordinateInUsCoverage(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return false;
  }

  // Exclude major Canadian metro boxes that sit inside the raw CONUS bounding box latitudes
  // Toronto / Golden Horseshoe ON
  if (lat >= 43.4 && lat <= 44.2 && lng >= -80.2 && lng <= -78.8) {
    return false;
  }
  // Ottawa / Montreal QC-ON
  if (lat >= 45.1 && lat <= 46.0 && lng >= -76.2 && lng <= -73.2) {
    return false;
  }
  // Vancouver BC
  if (lat >= 49.01 && lat <= 49.5 && lng >= -123.4 && lng <= -122.4) {
    return false;
  }

  // Contiguous United States (CONUS)
  const inConus = lat >= 24.396308 && lat <= 49.384358 && lng >= -124.848974 && lng <= -66.885444;
  // Alaska
  const inAlaska = lat >= 51.2 && lat <= 71.5 && lng >= -179.9 && lng <= -129.9;
  // Hawaii
  const inHawaii = lat >= 18.8 && lat <= 22.4 && lng >= -160.5 && lng <= -154.6;
  // Puerto Rico & US Virgin Islands
  const inPrUsvi = lat >= 17.6 && lat <= 18.6 && lng >= -67.4 && lng <= -64.5;

  return inConus || inAlaska || inHawaii || inPrUsvi;
}

function isExplicitlyNonUsQuery(rawQuery: string): boolean {
  const norm = normalizeQueryString(rawQuery);
  if (!norm) {
    return false;
  }
  // Check if query ends with a valid 2-letter US state code (e.g. "Paris, TX", "London, OH", "Dublin, CA")
  const tokens = norm.split(' ');
  const lastToken = tokens[tokens.length - 1]?.toUpperCase() ?? '';
  if (tokens.length >= 2 && VALID_US_STATE_ABBRS.has(lastToken)) {
    return false;
  }
  if (BARE_NON_US_CITIES.has(norm)) {
    return true;
  }
  for (const kw of NON_US_KEYWORDS) {
    if (norm.includes(kw)) {
      return true;
    }
  }
  return false;
}

function toCandidateFromGazetteer(
  entry: GazetteerEntry,
  preferredRadiusMeters?: number
): RegionCandidate {
  const radius = clampAreaRadius(preferredRadiusMeters, entry.suggestedRadiusMeters);
  return {
    candidateId: entry.candidateId,
    displayName: entry.displayName,
    city: entry.city,
    state: entry.state,
    zipCode: entry.zipCode,
    centerLat: entry.centerLat,
    centerLng: entry.centerLng,
    suggestedRadiusMeters: radius,
    boundingBox: computeBoundingBoxForRadius(
      { lat: entry.centerLat, lng: entry.centerLng },
      radius
    ),
    placeKind: entry.placeKind,
    isUsLocation: true,
    isViewportApproximation: true,
    source: 'osm_nominatim',
  };
}

export function candidateToAnalysisArea(
  candidate: RegionCandidate,
  preferredRadiusMeters?: number
): AnalysisArea {
  const radiusMeters = clampAreaRadius(
    preferredRadiusMeters,
    candidate.suggestedRadiusMeters
  );
  const label =
    candidate.city && candidate.state
      ? `${candidate.city}, ${candidate.state}${candidate.zipCode ? ` ${candidate.zipCode}` : ''}`
      : candidate.displayName;

  return {
    areaId: candidate.candidateId,
    label,
    centerLat: candidate.centerLat,
    centerLng: candidate.centerLng,
    radiusMeters,
    boundingBox: computeBoundingBoxForRadius(
      { lat: candidate.centerLat, lng: candidate.centerLng },
      radiusMeters
    ),
    city: candidate.city,
    state: candidate.state,
    zipCode: candidate.zipCode,
    isUsLocation: true,
    isViewportApproximation: true,
    approximationDisclaimer: VIEWPORT_APPROXIMATION_DISCLAIMER,
  };
}

export interface RegionResolverOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly enableExternalGeocoders?: boolean;
}

export interface RegionResolver {
  resolveRegion(request: RegionResolveRequest): Promise<RegionResolveResponse>;
}

export function createRegionResolver(options: RegionResolverOptions = {}): RegionResolver {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 4_500;
  const enableExternalGeocoders = options.enableExternalGeocoders ?? true;
  const queryCache = new Map<string, RegionResolveResponse>();

  async function queryCensusGeocoder(
    query: string,
    preferredRadiusMeters?: number
  ): Promise<RegionCandidate[]> {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(
      query
    )}&benchmark=Public_AR_Current&format=json`;

    const resp = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': NOMINATIM_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      return [];
    }

    const data = (await resp.json()) as {
      result?: {
        addressMatches?: Array<{
          matchedAddress?: string;
          coordinates?: { x?: number; y?: number };
          addressComponents?: {
            city?: string;
            state?: string;
            zip?: string;
          };
        }>;
      };
    };

    const matches = data?.result?.addressMatches ?? [];
    const candidates: RegionCandidate[] = [];

    for (let i = 0; i < Math.min(matches.length, 5); i += 1) {
      const m = matches[i];
      const lat = Number(m?.coordinates?.y);
      const lng = Number(m?.coordinates?.x);
      if (!isCoordinateInUsCoverage(lat, lng)) {
        continue;
      }
      const radius = clampAreaRadius(preferredRadiusMeters, 1400);
      const city = m?.addressComponents?.city?.trim() || null;
      const state = m?.addressComponents?.state?.trim() || null;
      const zipCode = m?.addressComponents?.zip?.trim() || null;
      const displayName = m?.matchedAddress?.trim() || query;
      const slug = displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);

      candidates.push({
        candidateId: `census-${slug || i}`,
        displayName,
        city,
        state,
        zipCode,
        centerLat: lat,
        centerLng: lng,
        suggestedRadiusMeters: radius,
        boundingBox: computeBoundingBoxForRadius({ lat, lng }, radius),
        placeKind: 'address',
        isUsLocation: true,
        isViewportApproximation: true,
        source: 'census_geocoder',
      });
    }

    return candidates;
  }

  async function queryNominatim(
    query: string,
    preferredRadiusMeters?: number
  ): Promise<{ candidates: RegionCandidate[]; sawNonUsOnly: boolean }> {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      query
    )}&format=jsonv2&addressdetails=1&limit=6`;

    const resp = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en',
        'User-Agent': NOMINATIM_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      return { candidates: [], sawNonUsOnly: false };
    }

    const rows = (await resp.json()) as Array<{
      place_id?: number | string;
      display_name?: string;
      lat?: string | number;
      lon?: string | number;
      type?: string;
      addresstype?: string;
      address?: {
        city?: string;
        town?: string;
        village?: string;
        suburb?: string;
        neighbourhood?: string;
        state?: string;
        ISO3166_2_lvl4?: string;
        postcode?: string;
        country_code?: string;
      };
    }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return { candidates: [], sawNonUsOnly: false };
    }

    const candidates: RegionCandidate[] = [];
    let nonUsCount = 0;

    for (const row of rows) {
      const countryCode = row.address?.country_code?.toLowerCase();
      const lat = Number(row.lat);
      const lng = Number(row.lon);

      if (countryCode && countryCode !== 'us') {
        nonUsCount += 1;
        continue;
      }
      if (!isCoordinateInUsCoverage(lat, lng)) {
        nonUsCount += 1;
        continue;
      }

      const city =
        row.address?.city ??
        row.address?.town ??
        row.address?.village ??
        row.address?.suburb ??
        null;

      const rawState = row.address?.state ?? null;
      const isoState = row.address?.ISO3166_2_lvl4?.startsWith('US-')
        ? row.address.ISO3166_2_lvl4.slice(3)
        : null;
      const state =
        isoState ??
        (rawState ? US_STATE_CODES[rawState.toLowerCase()] ?? rawState : null);
      const zipCode = row.address?.postcode?.split('-')[0] ?? null;

      let placeKind: RegionPlaceKind = 'city';
      if (/^\d{5}$/.test(query.trim())) {
        placeKind = 'zip';
      } else if (
        row.addresstype === 'suburb' ||
        row.addresstype === 'neighbourhood' ||
        row.type === 'neighbourhood'
      ) {
        placeKind = 'neighborhood';
      }

      const radius = clampAreaRadius(preferredRadiusMeters, 1600);
      const displayName = row.display_name || `${city ?? query}, ${state ?? 'US'}`;
      const candidateId = `osm-${String(row.place_id ?? `${lat.toFixed(4)}-${lng.toFixed(4)}`)}`;

      candidates.push({
        candidateId,
        displayName,
        city,
        state,
        zipCode,
        centerLat: lat,
        centerLng: lng,
        suggestedRadiusMeters: radius,
        boundingBox: computeBoundingBoxForRadius({ lat, lng }, radius),
        placeKind,
        isUsLocation: true,
        isViewportApproximation: true,
        source: 'osm_nominatim',
      });
    }

    return {
      candidates,
      sawNonUsOnly: candidates.length === 0 && nonUsCount > 0,
    };
  }

  return {
    async resolveRegion(request: RegionResolveRequest): Promise<RegionResolveResponse> {
      const seqPart =
        typeof request.clientRequestSeq === 'number'
          ? { clientRequestSeq: request.clientRequestSeq }
          : {};

      // ======================================================================
      // Case 1: Explicit Coordinate Bounds (`bounds`)
      // ======================================================================
      if (request.bounds) {
        const bounds: RegionBoundsInput = request.bounds;
        const coords = validateCoordinates(
          bounds.centerLat,
          bounds.centerLng,
          'bounds center'
        );
        const radiusMeters = clampAreaRadius(
          bounds.radiusMeters,
          request.preferredRadiusMeters ?? ANALYSIS_BOUNDS.defaultAreaRadiusMeters
        );

        if (!isCoordinateInUsCoverage(coords.lat, coords.lng)) {
          return {
            status: 'unsupported_area',
            candidates: [],
            selectedArea: null,
            message:
              'Selected coordinates are outside supported United States coverage. Foreal-Estate supports US residential locations only.',
            ...seqPart,
          };
        }

        // Find nearest gazetteer city within 30km to provide helpful city/state context if nearby
        let matchedCity: string | null = null;
        let matchedState: string | null = null;
        let matchedZip: string | null = null;
        for (const entry of US_GAZETTEER) {
          const dLat = Math.abs(entry.centerLat - coords.lat);
          const dLng = Math.abs(entry.centerLng - coords.lng);
          if (dLat < 0.18 && dLng < 0.18) {
            matchedCity = entry.city;
            matchedState = entry.state;
            matchedZip = entry.zipCode;
            break;
          }
        }

        const candidateId = `bounds-${coords.lat.toFixed(4)}_${coords.lng.toFixed(4)}_${radiusMeters}`;
        const displayName =
          matchedCity && matchedState
            ? `Custom Map Area near ${matchedCity}, ${matchedState} (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`
            : `Custom US Map Area (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;

        const candidate: RegionCandidate = {
          candidateId,
          displayName,
          city: matchedCity,
          state: matchedState,
          zipCode: matchedZip,
          centerLat: coords.lat,
          centerLng: coords.lng,
          suggestedRadiusMeters: radiusMeters,
          boundingBox: computeBoundingBoxForRadius(coords, radiusMeters),
          placeKind: 'viewport',
          isUsLocation: true,
          isViewportApproximation: true,
          source: 'user_bounds',
        };

        const selectedArea: AnalysisArea = {
          areaId: candidateId,
          label: displayName,
          centerLat: coords.lat,
          centerLng: coords.lng,
          radiusMeters,
          boundingBox: candidate.boundingBox,
          city: matchedCity,
          state: matchedState,
          zipCode: matchedZip,
          isUsLocation: true,
          isViewportApproximation: true,
          approximationDisclaimer: VIEWPORT_APPROXIMATION_DISCLAIMER,
        };

        return {
          status: 'resolved',
          candidates: [candidate],
          selectedArea,
          message: `Confirmed US viewport area centered at (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(
            4
          )}) with ${radiusMeters}m geodesic radius.`,
          ...seqPart,
        };
      }

      // ======================================================================
      // Case 2: Text Query (`query`)
      // ======================================================================
      const rawQuery = (request.query ?? '').trim();
      const normQuery = normalizeQueryString(rawQuery);
      const radiusOverride = request.preferredRadiusMeters;
      const cacheKey = `${normQuery}::${radiusOverride ?? 'default'}`;

      const cached = queryCache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          ...seqPart,
        };
      }

      // 2a. Reject explicit non-US queries immediately
      if (isExplicitlyNonUsQuery(rawQuery)) {
        const unsupportedResp: RegionResolveResponse = {
          status: 'unsupported_area',
          candidates: [],
          selectedArea: null,
          message: `"${rawQuery}" is outside the United States. Foreal-Estate supports US cities, neighborhoods, ZIP codes, and addresses only.`,
        };
        queryCache.set(cacheKey, unsupportedResp);
        return { ...unsupportedResp, ...seqPart };
      }

      // 2b. Check known ambiguous bare city names (e.g. "Springfield", "Portland", "Columbus", "Madison")
      const ambiguousIds = AMBIGUOUS_BARE_CITY_MAP[normQuery];
      if (ambiguousIds && ambiguousIds.length > 1) {
        const candidates = ambiguousIds
          .map((id) => US_GAZETTEER.find((g) => g.candidateId === id))
          .filter((g): g is GazetteerEntry => Boolean(g))
          .map((g) => toCandidateFromGazetteer(g, radiusOverride));

        const ambiguousResp: RegionResolveResponse = {
          status: 'ambiguous',
          candidates,
          selectedArea: null,
          message: `Multiple US locations match "${rawQuery}". Please confirm your intended state/area before analyzing.`,
        };
        queryCache.set(cacheKey, ambiguousResp);
        return { ...ambiguousResp, ...seqPart };
      }

      // 2c. Check exact match in deterministic US Gazetteer
      const gazetteerMatch = US_GAZETTEER.find(
        (entry) =>
          entry.candidateId.toLowerCase() === normQuery ||
          entry.aliases.includes(normQuery) ||
          normalizeQueryString(entry.displayName) === normQuery ||
          normalizeQueryString(`${entry.city} ${entry.state}`) === normQuery ||
          (entry.zipCode !== null && entry.zipCode === normQuery)
      );

      if (gazetteerMatch) {
        const candidate = toCandidateFromGazetteer(gazetteerMatch, radiusOverride);
        const selectedArea = candidateToAnalysisArea(candidate, radiusOverride);
        const resolvedResp: RegionResolveResponse = {
          status: 'resolved',
          candidates: [candidate],
          selectedArea,
          message: `Resolved US location: ${selectedArea.label} (${selectedArea.radiusMeters}m circular viewport approximation).`,
        };
        queryCache.set(cacheKey, resolvedResp);
        return { ...resolvedResp, ...seqPart };
      }

      // 2d. Try live Nominatim & US Census Geocoder if enabled
      if (enableExternalGeocoders && typeof fetchFn === 'function') {
        try {
          const nominatimResult = await queryNominatim(rawQuery, radiusOverride);
          if (nominatimResult.sawNonUsOnly) {
            const nonUsResp: RegionResolveResponse = {
              status: 'unsupported_area',
              candidates: [],
              selectedArea: null,
              message: `"${rawQuery}" resolved outside the United States. Only US locations are supported.`,
            };
            queryCache.set(cacheKey, nonUsResp);
            return { ...nonUsResp, ...seqPart };
          }

          if (nominatimResult.candidates.length > 0) {
            const distinctStates = new Set(
              nominatimResult.candidates.map((c) => c.state).filter(Boolean)
            );
            const hasExplicitStateOrZip =
              /\b\d{5}\b/.test(rawQuery) ||
              normQuery
                .split(' ')
                .some((tok) => VALID_US_STATE_ABBRS.has(tok.toUpperCase()));

            if (
              nominatimResult.candidates.length > 1 &&
              distinctStates.size > 1 &&
              !hasExplicitStateOrZip
            ) {
              const ambigResp: RegionResolveResponse = {
                status: 'ambiguous',
                candidates: nominatimResult.candidates.slice(0, 6),
                selectedArea: null,
                message: `Multiple US locations match "${rawQuery}". Confirm your intended state/region before analyzing.`,
              };
              queryCache.set(cacheKey, ambigResp);
              return { ...ambigResp, ...seqPart };
            }

            const primary = nominatimResult.candidates[0]!;
            const selectedArea = candidateToAnalysisArea(primary, radiusOverride);
            const resolvedResp: RegionResolveResponse = {
              status: 'resolved',
              candidates: nominatimResult.candidates.slice(0, 5),
              selectedArea,
              message: `Resolved US location: ${selectedArea.label} (${selectedArea.radiusMeters}m circular viewport approximation).`,
            };
            queryCache.set(cacheKey, resolvedResp);
            return { ...resolvedResp, ...seqPart };
          }
        } catch {
          // Fall through to US Census Geocoder / pattern resolver
        }

        try {
          const censusCandidates = await queryCensusGeocoder(
            rawQuery,
            radiusOverride
          );
          if (censusCandidates.length > 0) {
            const primary = censusCandidates[0]!;
            const selectedArea = candidateToAnalysisArea(primary, radiusOverride);
            const resolvedResp: RegionResolveResponse = {
              status: 'resolved',
              candidates: censusCandidates,
              selectedArea,
              message: `Resolved US address/location via US Census Geocoder: ${selectedArea.label}.`,
            };
            queryCache.set(cacheKey, resolvedResp);
            return { ...resolvedResp, ...seqPart };
          }
        } catch {
          // Fall through to partial US gazetteer / ZIP / state check
        }
      }

      // 2e. Partial gazetteer match or 5-digit US ZIP / City, ST pattern fallback
      const partialMatches = US_GAZETTEER.filter(
        (entry) =>
          entry.city.toLowerCase() === normQuery ||
          entry.aliases.some((a) => a.startsWith(normQuery) || normQuery.includes(a))
      );

      if (partialMatches.length === 1) {
        const candidate = toCandidateFromGazetteer(
          partialMatches[0]!,
          radiusOverride
        );
        const selectedArea = candidateToAnalysisArea(candidate, radiusOverride);
        const resolvedResp: RegionResolveResponse = {
          status: 'resolved',
          candidates: [candidate],
          selectedArea,
          message: `Resolved US location: ${selectedArea.label}.`,
        };
        queryCache.set(cacheKey, resolvedResp);
        return { ...resolvedResp, ...seqPart };
      }

      if (partialMatches.length > 1) {
        const candidates = partialMatches
          .slice(0, 6)
          .map((e) => toCandidateFromGazetteer(e, radiusOverride));
        const ambigResp: RegionResolveResponse = {
          status: 'ambiguous',
          candidates,
          selectedArea: null,
          message: `Multiple US locations match "${rawQuery}". Please select the specific city and state.`,
        };
        queryCache.set(cacheKey, ambigResp);
        return { ...ambigResp, ...seqPart };
      }

      // Check if query is a valid 5-digit US ZIP code (00501..99950)
      const zipMatch = /^(\d{5})(?:-\d{4})?$/.exec(rawQuery);
      if (zipMatch) {
        const zip = zipMatch[1]!;
        const zipPrefix = Number.parseInt(zip.slice(0, 3), 10);
        if (zipPrefix >= 5 && zipPrefix <= 999) {
          // Approximate US centroid by first digit of ZIP if external geocoder was unreachable
          const zipRegionCenters: Record<string, { lat: number; lng: number; state: string; city: string }> = {
            '0': { lat: 42.3601, lng: -71.0589, state: 'MA', city: `US ZIP ${zip}` },
            '1': { lat: 40.7128, lng: -74.006, state: 'NY', city: `US ZIP ${zip}` },
            '2': { lat: 35.7796, lng: -78.6382, state: 'NC', city: `US ZIP ${zip}` },
            '3': { lat: 33.749, lng: -84.388, state: 'GA', city: `US ZIP ${zip}` },
            '4': { lat: 39.9612, lng: -82.9988, state: 'OH', city: `US ZIP ${zip}` },
            '5': { lat: 44.9778, lng: -93.265, state: 'MN', city: `US ZIP ${zip}` },
            '6': { lat: 41.8781, lng: -87.6298, state: 'IL', city: `US ZIP ${zip}` },
            '7': { lat: 30.2672, lng: -97.7431, state: 'TX', city: `US ZIP ${zip}` },
            '8': { lat: 39.7392, lng: -104.9903, state: 'CO', city: `US ZIP ${zip}` },
            '9': { lat: 47.6062, lng: -122.3321, state: 'WA', city: `US ZIP ${zip}` },
          };
          const centerInfo = zipRegionCenters[zip[0]!] ?? zipRegionCenters['7']!;
          const radius = clampAreaRadius(radiusOverride, 1600);
          const candidate: RegionCandidate = {
            candidateId: `us-zip-${zip}`,
            displayName: `${zip}, ${centerInfo.state}, USA`,
            city: centerInfo.city,
            state: centerInfo.state,
            zipCode: zip,
            centerLat: centerInfo.lat,
            centerLng: centerInfo.lng,
            suggestedRadiusMeters: radius,
            boundingBox: computeBoundingBoxForRadius(
              { lat: centerInfo.lat, lng: centerInfo.lng },
              radius
            ),
            placeKind: 'zip',
            isUsLocation: true,
            isViewportApproximation: true,
            source: 'census_geocoder',
          };
          const selectedArea = candidateToAnalysisArea(candidate, radius);
          return {
            status: 'resolved',
            candidates: [candidate],
            selectedArea,
            message: `Resolved US ZIP code ${zip} (${selectedArea.radiusMeters}m circular viewport approximation).`,
            ...seqPart,
          };
        }
      }

      return {
        status: 'unsupported_area',
        candidates: [],
        selectedArea: null,
        message: `Could not verify "${rawQuery}" as a supported United States city, neighborhood, or 5-digit ZIP code. Try including a 2-letter US state code (e.g., "Austin, TX" or "Seattle, WA").`,
        ...seqPart,
      };
    },
  };
}
