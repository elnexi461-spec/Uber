import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractFromResponses } from "./uber-public-extract.js";
import { generateCsv } from "./uber-output.js";
import type { Route, OutputRow, FieldCoverage } from "./types.js";

const ROOT = process.cwd();
const RESPONSE_DIR = join(ROOT, "debug", "uber-responses");
const OUTPUT_DIR = join(ROOT, "output");
const DEBUG_DIR = join(ROOT, "debug");

const ROUTE: Route = {
  taskId: "hk_202606192058594097",
  pickupName: "沙田醫院",
  destinationName: "南方花園",
  pickup: { lat: 22.395771, lng: 114.217333 },
  destination: { lat: 22.325528, lng: 114.19081 },
};

const EXPECTED_COLUMNS: (keyof OutputRow)[] = [
  "taskId", "routeId", "pullTime", "executeTime", "accountid",
  "originLat", "originLng", "destinationLat", "destinationLng",
  "flat", "flng", "tlat", "tlng",
  "productId", "productUuid", "vehicleViewId", "description", "displayName",
  "detailedDescription", "title", "header", "accessibilityText",
  "available", "is3p", "productType", "parentProductUuid", "cityId", "country", "imageUrl",
  "capacity", "fare", "fareAmountE5", "currencyCode", "formattedFare",
  "discountPrimary", "discountPrimaryMagnitude", "discountedPrice",
  "hasPromo", "hasRidePass", "preAdjustmentValue",
  "fareLineItems", "baseValue", "perDistanceUnitValue", "perMinuteValue",
  "minimumValue", "minFare", "maxFare",
  "estimatedTripTime", "etaString", "etaStringShort", "etaInMin", "etaMax",
  "predictDistance", "predictEta",
  "distanceMeters", "durationSeconds", "polyline",
  "surgeMultiplier", "fareMeta", "sourceFile",
];

function computeCoverage(rows: OutputRow[]): Record<string, FieldCoverage> {
  const coverage: Record<string, FieldCoverage> = {};

  for (const col of EXPECTED_COLUMNS) {
    const populated = rows.filter((r) => {
      const v = r[col];
      return v !== null && v !== undefined && v !== "";
    }).length;
    const ratio = rows.length > 0 ? populated / rows.length : 0;

    let source = "capture";
    let status: "AVAILABLE" | "DERIVED" | "UNAVAILABLE" = "UNAVAILABLE";
    let notes = "";

    if (["taskId", "originLat", "originLng", "destinationLat", "destinationLng", "flat", "flng", "tlat", "tlng"].includes(col)) {
      status = "DERIVED";
      notes = "Derived from route input configuration";
    } else if (["distanceMeters", "durationSeconds", "polyline"].includes(col)) {
      status = ratio > 0 ? "AVAILABLE" : "UNAVAILABLE";
      notes = "From navigation response (custom-api/navigation/route)";
    } else if (["productId", "productUuid", "description", "displayName", "detailedDescription", "cityId", "available", "is3p", "productType", "parentProductUuid", "imageUrl", "title", "estimatedTripTime", "etaStringShort", "etaInMin", "etaMax"].includes(col)) {
      status = ratio > 0 ? "AVAILABLE" : "UNAVAILABLE";
      notes = "From public Products GraphQL response";
    } else if (["capacity", "fare", "fareAmountE5", "currencyCode", "discountPrimary", "hasPromo", "hasRidePass", "preAdjustmentValue", "fareMeta"].includes(col)) {
      status = ratio > 0 ? "AVAILABLE" : "UNAVAILABLE";
      notes = "From fares[] array in public response (empty in anonymous flow)";
    } else if (["vehicleViewId", "routeId", "pullTime", "executeTime", "accountid", "country", "header", "accessibilityText", "formattedFare", "discountPrimaryMagnitude", "discountedPrice", "fareLineItems", "baseValue", "perDistanceUnitValue", "perMinuteValue", "minimumValue", "minFare", "maxFare", "etaString", "predictDistance", "predictEta", "surgeMultiplier"].includes(col)) {
      status = "UNAVAILABLE";
      notes = "Not present in anonymous public web capture";
    } else if (col === "sourceFile") {
      status = "DERIVED";
      notes = "Traceability field added by extractor";
    }

    coverage[col] = {
      source,
      status,
      coverage: Number(ratio.toFixed(4)),
      notes,
    };
  }

  return coverage;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DEBUG_DIR, { recursive: true });

  console.log("=== Hong Kong End-to-End Test ===\n");

  console.log("1. Loading captured responses...");
  const { products, navigation, rows, responseFiles, productResponseFiles } =
    await extractFromResponses(RESPONSE_DIR, ROUTE);

  console.log("2. Generating CSV...");
  const csv = generateCsv(rows, EXPECTED_COLUMNS);
  await writeFile(join(OUTPUT_DIR, "hong-kong-final.csv"), csv, "utf8");

  console.log("3. Computing field coverage...");
  const coverage = computeCoverage(rows);
  await writeFile(join(DEBUG_DIR, "field-coverage.json"), JSON.stringify(coverage, null, 2) + "\n", "utf8");

  console.log("4. Validating schema...");
  const csvLines = csv.trim().split("\n");
  const headerColumns = csvLines[0].split(",").length;
  const schemaValid = headerColumns === EXPECTED_COLUMNS.length;

  const fareAvailable = rows.some((r) => !!r.fare && r.fare !== "");
  const currencyAvailable = rows.some((r) => !!r.currencyCode && r.currencyCode !== "");
  const navAvailable = navigation !== null;

  const populatedFields = EXPECTED_COLUMNS.filter((col) =>
    rows.some((r) => {
      const v = r[col];
      return v !== null && v !== undefined && v !== "";
    })
  );

  const unavailableFields = EXPECTED_COLUMNS.filter((col) =>
    !rows.some((r) => {
      const v = r[col];
      return v !== null && v !== undefined && v !== "";
    })
  );

  const report = {
    taskId: ROUTE.taskId,
    timestamp: new Date().toISOString(),
    sourceResponses: responseFiles.length,
    productResponseFiles,
    productsFound: products.length,
    productsDeduplicated: products.length,
    fieldsPopulated: populatedFields.length,
    fieldsUnavailable: unavailableFields.length,
    populatedFields,
    unavailableFields,
    fareAvailability: fareAvailable,
    currencyAvailability: currencyAvailable,
    navigationAvailability: navAvailable,
    navigation: navigation ? {
      distanceMeters: navigation.distanceMeters,
      durationSeconds: navigation.durationSeconds,
      polylineLength: navigation.polyline?.length ?? 0,
    } : null,
    schemaValidation: {
      expectedColumns: EXPECTED_COLUMNS.length,
      actualColumns: headerColumns,
      valid: schemaValid,
    },
    outputFiles: {
      csv: "output/hong-kong-final.csv",
      coverage: "debug/field-coverage.json",
    },
  };

  await writeFile(join(DEBUG_DIR, "hong-kong-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("\n=== Results ===");
  console.log(`Source responses scanned: ${responseFiles.length}`);
  console.log(`Products found: ${products.length}`);
  console.log(`Navigation extracted: ${navAvailable}`);
  console.log(`Fields populated: ${populatedFields.length} / ${EXPECTED_COLUMNS.length}`);
  console.log(`Fare available: ${fareAvailable}`);
  console.log(`Currency available: ${currencyAvailable}`);
  console.log(`Schema valid: ${schemaValid} (${headerColumns} columns)`);
  console.log(`\nOutput: ${join(OUTPUT_DIR, "hong-kong-final.csv")}`);
  console.log(`Report: ${join(DEBUG_DIR, "hong-kong-report.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
