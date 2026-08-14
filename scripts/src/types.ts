export type Json = unknown;

export interface Route {
  taskId: string;
  pickupName: string;
  destinationName: string;
  pickup: { lat: number; lng: number };
  destination: { lat: number; lng: number };
}

export interface Navigation {
  sourceFile: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  etaSeconds: number | null;
  polyline: string | null;
  legs: Array<{ distanceMeters: number | null; durationSeconds: number | null }> | null;
}

export interface Fare {
  capacity: number | null;
  fare: string | null;
  fareAmountE5: number | null;
  currencyCode: string | null;
  discountPrimary: string | null;
  hasPromo: boolean | null;
  hasRidePass: boolean | null;
  preAdjustmentValue: string | null;
  meta: Json | null;
}

export interface Product {
  sourceFile: string;
  productId: string | null;
  productUuid: string | null;
  vehicleViewUuid: string | null;
  description: string | null;
  displayName: string | null;
  detailedDescription: string | null;
  cityId: string | null;
  available: boolean | null;
  is3p: boolean | null;
  productType: string | null;
  parentProductUuid: string | null;
  imageUrl: string | null;
  tierTitle: string | null;
  estimatedTripTime: number | null;
  etaInMin: number | null;
  etaMax: number | null;
  etaStringShort: string | null;
  hasPromo: boolean | null;
  hasRidePass: boolean | null;
  preAdjustmentValue: string | null;
  fares: Fare[] | null;
}

export interface OfficialEstimate {
  productId: string | null;
  vehicleViewId: string | null;
  displayName: string | null;
  description: string | null;
  capacity: string | null;
  upfrontFareEnabled: string | null;
  currencyCode: string | null;
  fareDisplay: string | null;
  fareLow: string | null;
  fareHigh: string | null;
  fareId: string | null;
  pickupEstimate: string | null;
  distanceUnit: string | null;
  distanceEstimate: string | null;
  travelDistanceEstimate: string | null;
  durationEstimate: string | null;
  fareBreakdown: Json | null;
  surgeMultiplier: string | null;
  fulfillmentIndicator: string | null;
}

// Exact 89-column client schema — authoritative
export interface OutputRow {
  accountid: string | null;
  pullTime: string | null;
  executeTime: string | null;
  fare: string | null;
  description: string | null;
  country: string | null;
  bjHour: number | null;
  bjMinute: number | null;
  executeWeekday: number | null;
  dayType: string | null;
  flng: number | null;
  flat: number | null;
  tlng: number | null;
  tlat: number | null;
  timeSeason: string | null;
  batchId: string | null;
  routeId: string | null;
  taskId: string | null;
  currencyCode: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
  originLat: number | null;
  originLng: number | null;
  baseFlng: number | null;
  baseFlat: number | null;
  baseTlng: number | null;
  baseTlat: number | null;
  vehicleViewId: string | null;
  surgeMultiplier: string | null;
  unmodifiedDistance: number | null;
  formattedFare: string | null;
  accessibilityText: string | null;
  defaultText: string | null;
  pricingTemplatesDefaultText: string | null;
  magnitude: string | null;
  unit: string | null;
  textDisplayed: string | null;
  rankedSecondaryFareAccessibilityText: string | null;
  styledPrimaryFareMagnitude: string | null;
  styledPrimaryFareAccessibilityText: string | null;
  hourlyTiers: Json | null;
  estimatedTripTime: number | null;
  estimateRequestTime: string | null;
  etdDisplayString: string | null;
  estimatedSoloOnTripTime: string | null;
  packageVariantsVehicleViewId: string | null;
  sortWeight: number | null;
  vehicleViewsOrderStr: string | null;
  defaultVehicleViewId: string | null;
  title: string | null;
  preAdjustmentMagnitude: string | null;
  adjustmentMagnitude: string | null;
  postAdjustmentMagnitude: string | null;
  discountPrimaryMagnitude: string | null;
  unmodifiedEta: number | null;
  predictEta: number | null;
  predictDistance: number | null;
  predictHaversineDistance: number | null;
  predictEstimatedOriginLatitude: number | null;
  predictEstimatedOriginLongitude: number | null;
  predictEstimatedDestinationLatitude: number | null;
  predictEstimatedDestinationLongitude: number | null;
  polyline: string | null;
  etaString: string | null;
  etaStringShort: string | null;
  minEta: number | null;
  averageEta: number | null;
  baseValue: string | null;
  distanceUnit: string | null;
  type: string | null;
  perDistanceUnitValue: string | null;
  perMinuteValue: string | null;
  minimumValue: string | null;
  cancellationValue: string | null;
  safeRidesFeeValue: string | null;
  perWaitMinuteValue: string | null;
  allowFareEstimate: boolean | null;
  allowedToSurge: boolean | null;
  shouldFetchUpfrontFare: boolean | null;
  upfrontPriceEnabled: boolean | null;
  estimatedTolls: string | null;
  fareLineItems: Json | null;
  maxFare: string | null;
  minFare: string | null;
  isFareLineSuccess: boolean | null;
  fenceNameFrom: string | null;
  discountedPrice: string | null;
  header: string | null;
  screenshotBase64: string | null;
}

export interface FieldCoverage {
  source: string;
  status: "AVAILABLE" | "DERIVED" | "UNAVAILABLE";
  coverage: number;
  notes: string;
}
