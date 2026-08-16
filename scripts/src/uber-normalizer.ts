import type { OutputRow, Product, Navigation, OfficialEstimate, Route } from "./types.js";
import { getOutputColumns } from "./uber-public-extract.js";

export { getOutputColumns };

/**
 * Normalizer merges multiple data sources into the canonical 89-column OutputRow.
 * Sources:
 *   A. Uber Products GraphQL response (public, anonymous)
 *   B. Uber navigation response (custom-api/navigation/route)
 *   C. Official Guest Rides Estimates API (when UBER_ACCESS_TOKEN available)
 *
 * Never fabricates values. Fields classified as AVAILABLE / DERIVED / UNAVAILABLE.
 */

export function normalizeRow(
  product: Product,
  route: Route,
  navigation: Navigation | null,
  defaultVVID: string | null,
  hourlyTiers: unknown | null,
  now: Date,
): OutputRow {
  const firstFare = product.fares?.[0] ?? null;
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const bjHour = bj.getUTCHours();
  const bjMinute = bj.getUTCMinutes();
  const executeWeekday = bj.getUTCDay();

  return {
    accountid: null,
    pullTime: now.toISOString(),
    executeTime: now.toISOString(),
    fare: firstFare?.fare ?? null,
    description: product.description,
    country: null,
    bjHour,
    bjMinute,
    executeWeekday,
    dayType: null,
    flng: route.pickup.lng,
    flat: route.pickup.lat,
    tlng: route.destination.lng,
    tlat: route.destination.lat,
    timeSeason: null,
    batchId: null,
    routeId: null,
    taskId: route.taskId,
    currencyCode: firstFare?.currencyCode ?? null,
    destinationLat: route.destination.lat,
    destinationLng: route.destination.lng,
    originLat: route.pickup.lat,
    originLng: route.pickup.lng,
    baseFlng: null,
    baseFlat: null,
    baseTlng: null,
    baseTlat: null,
    vehicleViewId: product.vehicleViewUuid ?? defaultVVID,
    surgeMultiplier: null,
    unmodifiedDistance: navigation?.distanceMeters ?? null,
    formattedFare: null,
    accessibilityText: null,
    defaultText: null,
    pricingTemplatesDefaultText: null,
    magnitude: null,
    unit: null,
    textDisplayed: null,
    rankedSecondaryFareAccessibilityText: null,
    styledPrimaryFareMagnitude: null,
    styledPrimaryFareAccessibilityText: null,
    hourlyTiers,
    estimatedTripTime: product.estimatedTripTime,
    estimateRequestTime: null,
    etdDisplayString: null,
    estimatedSoloOnTripTime: null,
    packageVariantsVehicleViewId: null,
    sortWeight: null,
    vehicleViewsOrderStr: null,
    defaultVehicleViewId: defaultVVID,
    title: product.tierTitle,
    preAdjustmentMagnitude: product.preAdjustmentValue ?? null,
    adjustmentMagnitude: null,
    postAdjustmentMagnitude: null,
    discountPrimaryMagnitude: firstFare?.discountPrimary ?? null,
    unmodifiedEta: navigation?.etaSeconds ?? null,
    predictEta: null,
    predictDistance: null,
    predictHaversineDistance: null,
    predictEstimatedOriginLatitude: null,
    predictEstimatedOriginLongitude: null,
    predictEstimatedDestinationLatitude: null,
    predictEstimatedDestinationLongitude: null,
    polyline: navigation?.polyline ?? null,
    etaString: null,
    etaStringShort: product.etaStringShort,
    minEta: product.etaInMin,
    averageEta: null,
    baseValue: null,
    distanceUnit: null,
    type: null,
    perDistanceUnitValue: null,
    perMinuteValue: null,
    minimumValue: null,
    cancellationValue: null,
    safeRidesFeeValue: null,
    perWaitMinuteValue: null,
    allowFareEstimate: null,
    allowedToSurge: null,
    shouldFetchUpfrontFare: null,
    upfrontPriceEnabled: null,
    estimatedTolls: null,
    fareLineItems: null,
    maxFare: null,
    minFare: null,
    isFareLineSuccess: null,
    fenceNameFrom: null,
    discountedPrice: null,
    header: null,
    screenshotBase64: null,
  };
}
