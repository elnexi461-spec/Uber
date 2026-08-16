import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireAccessToken } from "./uber-auth.js";
import type { OfficialEstimate } from "./types.js";

const API_URL = "https://api.uber.com/v1/guests/trips/estimates";
const OUTPUT_DIR = join(process.cwd(), "output");

const pickup = { latitude: 22.395771, longitude: 114.217333 };
const dropoff = { latitude: 22.325528, longitude: 114.19081 };

function csv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(text)) {
    return `\"${text.replaceAll('"', '""')}\"`;
  }
  return text;
}

interface UberEstimateResponse {
  fares_unavailable?: boolean;
  etas_unavailable?: boolean;
  product_estimates?: Array<{
    product?: Record<string, unknown>;
    estimate_info?: Record<string, unknown>;
    fulfillment_indicator?: string;
  }>;
}

export async function fetchEstimates(): Promise<{
  estimates: OfficialEstimate[];
  raw: unknown;
  faresUnavailable: boolean;
  etasUnavailable: boolean;
}> {
  const token = await acquireAccessToken();

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ pickup, dropoff }),
  });

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Uber Estimates API returned ${response.status}: ${JSON.stringify(payload)}`);
  }

  const body = payload as UberEstimateResponse;

  const estimates: OfficialEstimate[] = (body.product_estimates ?? []).map((item) => {
    const product = (item.product ?? {}) as Record<string, unknown>;
    const estimate = (item.estimate_info ?? {}) as Record<string, unknown>;
    const fare = (estimate.fare ?? {}) as Record<string, unknown>;
    const estimateRange = (estimate.estimate ?? {}) as Record<string, unknown>;
    const trip = (estimate.trip ?? {}) as Record<string, unknown>;

    return {
      productId: String(product.product_id ?? ""),
      vehicleViewId: String(product.vehicle_view_id ?? ""),
      displayName: String(product.display_name ?? ""),
      description: String(product.description ?? ""),
      capacity: String(product.capacity ?? ""),
      upfrontFareEnabled: String(product.upfront_fare_enabled ?? ""),
      currencyCode: String(fare.currency_code ?? estimateRange.currency_code ?? ""),
      fareDisplay: String(fare.display ?? estimateRange.display ?? ""),
      fareLow: String(estimateRange.low_estimate ?? ""),
      fareHigh: String(estimateRange.high_estimate ?? ""),
      fareId: String(estimate.fare_id ?? ""),
      pickupEstimate: String(estimate.pickup_estimate ?? ""),
      distanceUnit: String(trip.distance_unit ?? ""),
      distanceEstimate: String(trip.distance_estimate ?? ""),
      travelDistanceEstimate: String(trip.travel_distance_estimate ?? ""),
      durationEstimate: String(trip.duration_estimate ?? ""),
      fareBreakdown: fare.fare_breakdown ?? null,
      surgeMultiplier: String(fare.surge_multiplier ?? ""),
      fulfillmentIndicator: String(item.fulfillment_indicator ?? ""),
    };
  });

  return {
    estimates,
    raw: payload,
    faresUnavailable: Boolean(body.fares_unavailable),
    etasUnavailable: Boolean(body.etas_unavailable),
  };
}

async function main(): Promise<void> {
  const { estimates, raw, faresUnavailable, etasUnavailable } = await fetchEstimates();

  await writeFile(
    join(OUTPUT_DIR, "official-estimates.json"),
    JSON.stringify(raw, null, 2) + "\n",
    "utf8",
  );

  const columns: (keyof OfficialEstimate)[] = [
    "productId", "vehicleViewId", "displayName", "description", "capacity",
    "upfrontFareEnabled", "currencyCode", "fareDisplay", "fareLow", "fareHigh",
    "fareId", "pickupEstimate", "distanceUnit", "distanceEstimate",
    "travelDistanceEstimate", "durationEstimate", "fareBreakdown",
    "surgeMultiplier", "fulfillmentIndicator",
  ];

  const csvLines = [
    columns.join(","),
    ...estimates.map((row) => columns.map((key) => csv(row[key])).join(",")),
  ];

  await writeFile(
    join(OUTPUT_DIR, "official-estimates.csv"),
    csvLines.join("\n") + "\n",
    "utf8",
  );

  console.log(`Products returned: ${estimates.length}`);
  console.log(`Fares unavailable: ${faresUnavailable}`);
  console.log(`ETAs unavailable: ${etasUnavailable}`);
  console.log(`Wrote ${join(OUTPUT_DIR, "official-estimates.json")}`);
  console.log(`Wrote ${join(OUTPUT_DIR, "official-estimates.csv")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
