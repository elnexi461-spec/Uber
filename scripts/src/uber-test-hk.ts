import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractFromResponses, getOutputColumns } from "./uber-public-extract.js";
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

const EXPECTED_COLUMNS = getOutputColumns();

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

    // DERIVED fields
    if (["pullTime", "executeTime", "bjHour", "bjMinute", "executeWeekday"].includes(col)) {
      status = "DERIVED";
      notes = "Derived from execution timestamp (Beijing timezone UTC+8)";
    } else if (["taskId", "originLat", "originLng", "destinationLat", "destinationLng", "flng", "flat", "tlng", "tlat"].includes(col)) {
      status = "DERIVED";
      notes = "Derived from route input configuration";
    } else if (["distanceMeters", "durationSeconds", "polyline"].includes(col)) {
      status = ratio > 0 ? "AVAILABLE" : "UNAVAILABLE";
      notes = "From navigation response (custom-api/navigation/route)";
    } else if (["productId", "productUuid", "description", "displayName", "detailedDescription", "cityId", "available", "is3p", "productType", "parentProductUuid", "imageUrl", "title", "estimatedTripTime", "etaStringShort", "etaInMin", "etaMax", "preAdjustmentValue"].includes(col)) {
      status = ratio > 0 ? "AVAILABLE" : "UNAVAILABLE";
      notes = "From public Products GraphQL response";
    } else if (["capacity", "fare", "fareAmountE5", "currencyCode", "discountPrimary", "hasPromo", "hasRidePass", "preAdjustmentMagnitude"].includes(col)) {
      status = ratio > 0 ? "AVAILABLE" : "UNAVAILABLE";
      notes = "From fares[] array in public response (empty in anonymous flow)";
    } else if (["vehicleViewId", "defaultVehicleViewId", "hourlyTiers"].includes(col)) {
      status = ratio > 0 ? "AVAILABLE" : "UNAVAILABLE";
      notes = "From top-level products metadata in GraphQL response";
    } else if (["unmodifiedDistance", "unmodifiedEta"].includes(col)) {
      status = ratio > 0 ? "AVAILABLE" : "UNAVAILABLE";
      notes = "From navigation response";
    } else if (["accountid", "country", "dayType", "timeSeason", "batchId", "routeId", "baseFlng", "baseFlat", "baseTlng", "baseTlat", "surgeMultiplier", "formattedFare", "accessibilityText", "defaultText", "pricingTemplatesDefaultText", "magnitude", "unit", "textDisplayed", "rankedSecondaryFareAccessibilityText", "styledPrimaryFareMagnitude", "styledPrimaryFareAccessibilityText", "estimateRequestTime", "etdDisplayString", "estimatedSoloOnTripTime", "packageVariantsVehicleViewId", "sortWeight", "vehicleViewsOrderStr", "adjustmentMagnitude", "postAdjustmentMagnitude", "predictEta", "predictDistance", "predictHaversineDistance", "predictEstimatedOriginLatitude", "predictEstimatedOriginLongitude", "predictEstimatedDestinationLatitude", "predictEstimatedDestinationLongitude", "etaString", "minEta", "averageEta", "baseValue", "distanceUnit", "type", "perDistanceUnitValue", "perMinuteValue", "minimumValue", "cancellationValue", "safeRidesFeeValue", "perWaitMinuteValue", "allowFareEstimate", "allowedToSurge", "shouldFetchUpfrontFare", "upfrontPriceEnabled", "estimatedTolls", "fareLineItems", "maxFare", "minFare", "isFareLineSuccess", "fenceNameFrom", "discountedPrice", "header", "screenshotBase64"].includes(col)) {
      status = "UNAVAILABLE";
      notes = "Not present in anonymous public web capture";
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

function validateSchema(csvText: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const lines = csvText.trim().split("\n");
  if (lines.length === 0) {
    errors.push("CSV is empty");
    return { valid: false, errors };
  }

  const header = lines[0].split(",");
  if (header.length !== 89) {
    errors.push(`Expected 89 columns, got ${header.length}`);
  }

  for (let i = 0; i < EXPECTED_COLUMNS.length; i++) {
    if (header[i] !== EXPECTED_COLUMNS[i]) {
      errors.push(`Column ${i + 1} mismatch: expected "${EXPECTED_COLUMNS[i]}", got "${header[i] ?? "(missing)"}"`);
    }
  }

  // Check data rows have same column count
  for (let rowIdx = 1; rowIdx < lines.length; rowIdx++) {
    const cols = lines[rowIdx].split(",");
    if (cols.length !== 89) {
      errors.push(`Row ${rowIdx} has ${cols.length} columns, expected 89`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DEBUG_DIR, { recursive: true });

  console.log("=== Hong Kong End-to-End Test (89-column schema) ===\n");

  console.log("1. Loading captured responses...");
  const { products, navigation, rows, responseFiles, productResponseFiles, defaultVVID, hourlyTiers } =
    await extractFromResponses(RESPONSE_DIR, ROUTE);

  console.log("2. Generating 89-column CSV...");
  const csv = generateCsv(rows, EXPECTED_COLUMNS);
  await writeFile(join(OUTPUT_DIR, "hong-kong-final.csv"), csv, "utf8");

  console.log("3. Validating schema...");
  const validation = validateSchema(csv);
  if (!validation.valid) {
    console.error("Schema validation FAILED:");
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    process.exitCode = 1;
  } else {
    console.log("  Schema validation PASSED (89 columns, correct order)");
  }

  console.log("4. Computing field coverage...");
  const coverage = computeCoverage(rows);
  await writeFile(join(DEBUG_DIR, "89-field-coverage.json"), JSON.stringify(coverage, null, 2) + "\n", "utf8");

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
    defaultVVID,
    hourlyTiersPresent: hourlyTiers !== null,
    schemaValidation: {
      expectedColumns: 89,
      actualColumns: csv.trim().split("\n")[0]?.split(",").length ?? 0,
      valid: validation.valid,
      errors: validation.errors,
    },
    outputFiles: {
      csv: "output/hong-kong-final.csv",
      coverage: "debug/89-field-coverage.json",
    },
  };

  await writeFile(join(DEBUG_DIR, "hong-kong-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("\n=== Results ===");
  console.log(`Source responses scanned: ${responseFiles.length}`);
  console.log(`Products found: ${products.length}`);
  console.log(`Navigation extracted: ${navAvailable}`);
  console.log(`Fields populated: ${populatedFields.length} / 89`);
  console.log(`Fare available: ${fareAvailable}`);
  console.log(`Currency available: ${currencyAvailable}`);
  console.log(`Schema valid: ${validation.valid}`);
  console.log(`\nOutput: ${join(OUTPUT_DIR, "hong-kong-final.csv")}`);
  console.log(`Report: ${join(DEBUG_DIR, "hong-kong-report.json")}`);
  console.log(`Coverage: ${join(DEBUG_DIR, "89-field-coverage.json")}`);

  if (!validation.valid) {
    throw new Error(`Schema validation failed with ${validation.errors.length} error(s)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
