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

export interface OutputRow {
  taskId: string;
  routeId: string | null;
  pullTime: string | null;
  executeTime: string | null;
  accountid: string | null;
  originLat: number | null;
  originLng: number | null;
  destinationLat: number | null;
  destinationLng: number | null;
  flat: number | null;
  flng: number | null;
  tlat: number | null;
  tlng: number | null;
  productId: string | null;
  productUuid: string | null;
  vehicleViewId: string | null;
  description: string | null;
  displayName: string | null;
  detailedDescription: string | null;
  title: string | null;
  header: string | null;
  accessibilityText: string | null;
  available: boolean | null;
  is3p: boolean | null;
  productType: string | null;
  parentProductUuid: string | null;
  cityId: string | null;
  country: string | null;
  imageUrl: string | null;
  capacity: number | null;
  fare: string | null;
  fareAmountE5: number | null;
  currencyCode: string | null;
  formattedFare: string | null;
  discountPrimary: string | null;
  discountPrimaryMagnitude: string | null;
  discountedPrice: string | null;
  hasPromo: boolean | null;
  hasRidePass: boolean | null;
  preAdjustmentValue: string | null;
  fareLineItems: Json | null;
  baseValue: string | null;
  perDistanceUnitValue: string | null;
  perMinuteValue: string | null;
  minimumValue: string | null;
  minFare: string | null;
  maxFare: string | null;
  estimatedTripTime: number | null;
  etaString: string | null;
  etaStringShort: string | null;
  etaInMin: number | null;
  etaMax: number | null;
  predictDistance: number | null;
  predictEta: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  polyline: string | null;
  surgeMultiplier: string | null;
  fareMeta: Json | null;
  sourceFile: string;
}

export interface FieldCoverage {
  source: string;
  status: "AVAILABLE" | "DERIVED" | "UNAVAILABLE";
  coverage: number;
  notes: string;
}
