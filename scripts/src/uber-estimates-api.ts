import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const API_URL = "https://api.uber.com/v1/guests/trips/estimates";
const OUTPUT_DIR = join(process.cwd(), "output");

const pickup = { latitude: 22.395771, longitude: 114.217333 };
const dropoff = { latitude: 22.325528, longitude: 114.19081 };

function requireToken(): string {
  const token = process.env.UBER_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "UBER_ACCESS_TOKEN is required. This adapter only uses Uber's documented Guest Rides Estimates API and never attempts to obtain or bypass credentials.",
    );
  }
  return token;
}

function csv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main(): Promise<void> {
  const token = requireToken();

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

  await writeFile(
    join(OUTPUT_DIR, "official-estimates.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );

  const body = payload as {
    fares_unavailable?: boolean;
    etas_unavailable?: boolean;
    product_estimates?: Array<{
      product?: Record<string, unknown>;
      estimate_info?: Record<string, unknown>;
      fulfillment_indicator?: string;
    }>;
  };

  const rows = (body.product_estimates ?? []).map((item) => {
    const product = item.product ?? {};
    const estimate = item.estimate_info ?? {};
    const fare = (estimate.fare ?? {}) as Record<string, unknown>;
    const estimateRange = (estimate.estimate ?? {}) as Record<string, unknown>;
    const trip = (estimate.trip ?? {}) as Record<string, unknown>;

    return {
      pickup_lat: pickup.latitude,
      pickup_lng: pickup.longitude,
      dropoff_lat: dropoff.latitude,
      dropoff_lng: dropoff.longitude,
      product_id: product.product_id ?? "",
      vehicle_view_id: product.vehicle_view_id ?? "",
      display_name: product.display_name ?? "",
      description: product.description ?? "",
      capacity: product.capacity ?? "",
      upfront_fare_enabled: product.upfront_fare_enabled ?? "",
      currency_code: fare.currency_code ?? estimateRange.currency_code ?? "",
      fare_display: fare.display ?? estimateRange.display ?? "",
      fare_low: estimateRange.low_estimate ?? "",
      fare_high: estimateRange.high_estimate ?? "",
      fare_id: estimate.fare_id ?? "",
      pickup_estimate: estimate.pickup_estimate ?? "",
      distance_unit: trip.distance_unit ?? "",
      distance_estimate: trip.distance_estimate ?? "",
      travel_distance_estimate: trip.travel_distance_estimate ?? "",
      duration_estimate: trip.duration_estimate ?? "",
      fare_breakdown: fare.fare_breakdown ?? "",
      surge_multiplier: fare.surge_multiplier ?? "",
      fulfillment_indicator: item.fulfillment_indicator ?? "",
    };
  });

  const columns = Object.keys(rows[0] ?? {
    pickup_lat: "",
    pickup_lng: "",
    dropoff_lat: "",
    dropoff_lng: "",
    product_id: "",
    vehicle_view_id: "",
    display_name: "",
    description: "",
    capacity: "",
    upfront_fare_enabled: "",
    currency_code: "",
    fare_display: "",
    fare_low: "",
    fare_high: "",
    fare_id: "",
    pickup_estimate: "",
    distance_unit: "",
    distance_estimate: "",
    travel_distance_estimate: "",
    duration_estimate: "",
    fare_breakdown: "",
    surge_multiplier: "",
    fulfillment_indicator: "",
  });

  await writeFile(
    join(OUTPUT_DIR, "official-estimates.csv"),
    [columns.join(","), ...rows.map((row) => columns.map((key) => csv(row[key as keyof typeof row])).join(","))].join("\n") + "\n",
    "utf8",
  );

  console.log(`Products returned: ${rows.length}`);
  console.log(`Fares unavailable: ${Boolean(body.fares_unavailable)}`);
  console.log(`ETAs unavailable: ${Boolean(body.etas_unavailable)}`);
  console.log(`Wrote ${join(OUTPUT_DIR, "official-estimates.json")}`);
  console.log(`Wrote ${join(OUTPUT_DIR, "official-estimates.csv")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
