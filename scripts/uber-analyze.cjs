#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const DEBUG = path.join(ROOT, "debug");
const RESPONSES = path.join(DEBUG, "uber-responses");
const OUTPUT = path.join(ROOT, "output");

fs.mkdirSync(OUTPUT, { recursive: true });

const ROUTE = {
  taskId: "hk_202606192058594097",
  country: "HK",
  pickup: {
    name: "沙田醫院",
    lat: 22.395771,
    lng: 114.217333,
  },
  destination: {
    name: "南方花園",
    lat: 22.325528,
    lng: 114.190810,
  },
};

const CSV_COLUMNS = [
  "accountid",
  "pullTime",
  "executeTime",
  "fare",
  "description",
  "country",
  "currencyCode",
  "flng",
  "flat",
  "tlng",
  "tlat",
  "originLat",
  "originLng",
  "destinationLat",
  "destinationLng",
  "vehicleViewId",
  "surgeMultiplier",
  "formattedFare",
  "estimatedTripTime",
  "etaString",
  "predictDistance",
  "predictEta",
  "discountPrimaryMagnitude",
  "discountedPrice",
  "fareLineItems",
  "baseValue",
  "perDistanceUnitValue",
  "perMinuteValue",
  "minimumValue",
  "cancellationValue",
  "safeRidesFeeValue",
  "perWaitMinuteValue",
  "minFare",
  "maxFare",
  "polyline",
  "title",
  "header",
  "accessibilityText",
  "routeId",
  "taskId",
  "batchId",
  "bjHour",
  "bjMinute",
  "executeWeekday",
  "dayType",
  "timeSeason",
  "accountType",
  "vehicleViewUuid",
  "productUuid",
  "defaultVehicleViewId",
  "packageVariantsVehicleViewId",
  "vehicleViewsOrderStr",
  "sortWeight",
  "allowFareEstimate",
  "allowedToSurge",
  "shouldFetchUpfrontFare",
  "upfrontPriceEnabled",
  "distanceUnit",
  "unmodifiedDistance",
  "predictHaversineDistance",
  "unmodifiedEta",
  "minEta",
  "averageEta",
  "etaStringShort",
  "etdDisplayString",
  "magnitude",
  "styledPrimaryFareMagnitude",
  "textDisplayed",
  "pricingTemplatesDefaultText",
  "preAdjustmentMagnitude",
  "adjustmentMagnitude",
  "postAdjustmentMagnitude",
  "isFareLineSuccess",
  "fenceNameFrom",
  "screenshotBase64",
  "defaultText",
  "fareId",
  "pricingExplanation",
  "productType",
  "capacity",
  "currency",
  "rawProduct"
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function walk(value, callback, pathParts = []) {
  if (value === null || value === undefined) return;

  callback(value, pathParts);

  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, callback, [...pathParts, i]));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      walk(v, callback, [...pathParts, k]);
    }
  }
}

function findObjects(value, predicate) {
  const results = [];

  walk(value, (node, p) => {
    if (
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      predicate(node)
    ) {
      results.push({ node, path: p.join(".") });
    }
  });

  return results;
}

function first(obj, paths, fallback = null) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;

    for (const part of parts) {
      if (cur === null || cur === undefined) break;
      cur = cur[part];
    }

    if (cur !== undefined && cur !== null && cur !== "") {
      return cur;
    }
  }

  return fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  return String(value);
}

function flattenJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function loadResponses() {
  if (!fs.existsSync(RESPONSES)) {
    throw new Error(`Missing directory: ${RESPONSES}`);
  }

  return fs
    .readdirSync(RESPONSES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      file: f,
      fullPath: path.join(RESPONSES, f),
      data: readJson(path.join(RESPONSES, f)),
    }))
    .filter((x) => x.data);
}

function findProducts(responses) {
  const products = [];

  for (const response of responses) {
    const matches = findObjects(
      response.data,
      (obj) =>
        (
          "productUuid" in obj ||
          "vehicleViewUuid" in obj ||
          "vehicleViewId" in obj
        ) &&
        (
          "description" in obj ||
          "displayName" in obj ||
          "title" in obj ||
          "fares" in obj
        )
    );

    for (const match of matches) {
      const p = match.node;

      const fare =
        Array.isArray(p.fares) && p.fares.length
          ? p.fares[0]
          : p.fare && typeof p.fare === "object"
            ? p.fare
            : {};

      const product = {
        sourceFile: response.file,
        sourcePath: match.path,
        product: p,
        fare,
      };

      products.push(product);
    }
  }

  return products;
}

function findNavigation(responses) {
  const candidates = [];

  for (const response of responses) {
    const matches = findObjects(
      response.data,
      (obj) =>
        "polyline" in obj ||
        "distance" in obj ||
        "duration" in obj ||
        "legs" in obj ||
        "eta" in obj
    );

    for (const match of matches) {
      candidates.push({
        sourceFile: response.file,
        sourcePath: match.path,
        node: match.node,
      });
    }
  }

  return candidates;
}

function getNavigationValue(navigation, keys) {
  for (const nav of navigation) {
    const value = first(nav.node, keys);
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }

  return null;
}

function makeRow(item, navigation, index) {
  const p = item.product || {};
  const fare = item.fare || {};

  const description =
    first(p, [
      "description",
      "displayName",
      "displayName.text",
      "title",
      "name",
    ]) || null;

  const title =
    first(p, [
      "title",
      "displayName",
      "displayName.text",
      "description",
      "name",
    ]) || description;

  const currency =
    first(fare, [
      "currencyCode",
      "currency",
      "currency.code",
    ]) ||
    first(p, [
      "currencyCode",
      "currency",
    ]) ||
    "";

  const fareValue = first(fare, [
    "fare",
    "fareAmount",
    "fareAmountE5",
    "magnitude",
  ]);

  let normalizedFare = numberOrNull(fareValue);

  // Uber sometimes exposes E5 integer pricing.
  if (
    normalizedFare !== null &&
    normalizedFare > 1000 &&
    String(fareValue).indexOf(".") === -1
  ) {
    normalizedFare = normalizedFare / 100000;
  }

  const eta =
    first(fare, [
      "etaInMin",
      "estimatedTripTime",
      "eta",
      "duration",
    ]) ??
    first(p, [
      "etaInMin",
      "estimatedTripTime",
      "eta",
    ]);

  const productId =
    first(p, [
      "vehicleViewId",
      "vehicleViewID",
      "id",
    ]) || null;

  const vehicleViewUuid =
    first(p, [
      "vehicleViewUuid",
      "vehicleViewUUID",
    ]) || null;

  const productUuid =
    first(p, [
      "productUuid",
      "productUUID",
      "uuid",
    ]) || null;

  const now = new Date();

  const row = Object.fromEntries(
    CSV_COLUMNS.map((column) => [column, ""])
  );

  row.pullTime = now.toISOString();
  row.executeTime = now.toISOString();

  row.country = ROUTE.country;

  row.flng = ROUTE.pickup.lng;
  row.flat = ROUTE.pickup.lat;
  row.tlng = ROUTE.destination.lng;
  row.tlat = ROUTE.destination.lat;

  row.originLat = ROUTE.pickup.lat;
  row.originLng = ROUTE.pickup.lng;
  row.destinationLat = ROUTE.destination.lat;
  row.destinationLng = ROUTE.destination.lng;

  row.routeId = `hk_${ROUTE.taskId}`;
  row.taskId = ROUTE.taskId;

  row.description = description || "";
  row.title = title || "";

  row.vehicleViewId = productId || "";
  row.vehicleViewUuid = vehicleViewUuid || "";
  row.productUuid = productUuid || "";

  row.fare = normalizedFare ?? "";
  row.magnitude = normalizedFare ?? "";

  row.currencyCode = currency;
  row.currency = currency;

  row.estimatedTripTime =
    numberOrNull(
      first(fare, [
        "estimatedTripTime",
        "tripTime",
        "duration",
      ])
    ) ?? "";

  row.etaString =
    first(fare, [
      "etaString",
      "etaStringLong",
    ]) ||
    "";

  row.etaStringShort =
    first(fare, [
      "etaStringShort",
    ]) ||
    "";

  row.predictEta =
    numberOrNull(
      first(fare, [
        "predictEta",
        "etaInMin",
      ])
    ) ?? "";

  row.minEta =
    numberOrNull(first(fare, ["minEta"])) ?? "";

  row.averageEta =
    numberOrNull(first(fare, ["averageEta"])) ?? "";

  row.predictDistance =
    numberOrNull(
      first(fare, [
        "predictDistance",
        "distance",
      ])
    ) ?? "";

  row.unmodifiedDistance =
    numberOrNull(first(fare, ["unmodifiedDistance"])) ?? "";

  row.predictHaversineDistance =
    numberOrNull(first(fare, ["predictHaversineDistance"])) ?? "";

  row.surgeMultiplier =
    numberOrNull(
      first(fare, [
        "surgeMultiplier",
        "surge",
      ])
    ) ?? "";

  row.discountPrimaryMagnitude =
    numberOrNull(
      first(fare, [
        "discountPrimaryMagnitude",
        "discountPrimary",
      ])
    ) ?? "";

  row.discountedPrice =
    numberOrNull(
      first(fare, [
        "discountedPrice",
        "postAdjustmentMagnitude",
      ])
    ) ?? "";

  row.preAdjustmentMagnitude =
    numberOrNull(
      first(fare, [
        "preAdjustmentMagnitude",
      ])
    ) ?? "";

  row.adjustmentMagnitude =
    numberOrNull(
      first(fare, [
        "adjustmentMagnitude",
      ])
    ) ?? "";

  row.postAdjustmentMagnitude =
    numberOrNull(
      first(fare, [
        "postAdjustmentMagnitude",
      ])
    ) ?? "";

  row.formattedFare =
    first(fare, [
      "formattedFare",
      "fareString",
      "textDisplayed",
      "displayFare",
    ]) || "";

  row.textDisplayed =
    first(fare, [
      "textDisplayed",
      "formattedFare",
    ]) || "";

  row.pricingTemplatesDefaultText =
    first(fare, [
      "pricingTemplatesDefaultText",
    ]) || "";

  row.fareId =
    first(fare, [
      "fareId",
      "id",
    ]) || "";

  row.pricingExplanation =
    first(fare, [
      "pricingExplanation",
      "explanation",
    ]) || "";

  row.header =
    first(fare, [
      "header",
    ]) || "";

  row.accessibilityText =
    first(fare, [
      "accessibilityText",
    ]) || "";

  row.fareLineItems =
    first(fare, [
      "fareLineItems",
      "fareBreakdown",
      "breakdown",
    ]);

  if (
    row.fareLineItems &&
    typeof row.fareLineItems !== "string"
  ) {
    row.fareLineItems = flattenJson(row.fareLineItems);
  }

  row.baseValue =
    numberOrNull(
      first(fare, [
        "baseValue",
        "baseFare",
      ])
    ) ?? "";

  row.perDistanceUnitValue =
    numberOrNull(
      first(fare, [
        "perDistanceUnitValue",
      ])
    ) ?? "";

  row.perMinuteValue =
    numberOrNull(
      first(fare, [
        "perMinuteValue",
      ])
    ) ?? "";

  row.minimumValue =
    numberOrNull(
      first(fare, [
        "minimumValue",
        "minimumFare",
      ])
    ) ?? "";

  row.cancellationValue =
    numberOrNull(
      first(fare, [
        "cancellationValue",
      ])
    ) ?? "";

  row.safeRidesFeeValue =
    numberOrNull(
      first(fare, [
        "safeRidesFeeValue",
      ])
    ) ?? "";

  row.perWaitMinuteValue =
    numberOrNull(
      first(fare, [
        "perWaitMinuteValue",
      ])
    ) ?? "";

  row.minFare =
    numberOrNull(first(fare, ["minFare"])) ?? "";

  row.maxFare =
    numberOrNull(first(fare, ["maxFare"])) ?? "";

  row.allowFareEstimate =
    first(fare, ["allowFareEstimate"]) ?? "";

  row.allowedToSurge =
    first(fare, ["allowedToSurge"]) ?? "";

  row.shouldFetchUpfrontFare =
    first(fare, ["shouldFetchUpfrontFare"]) ?? "";

  row.upfrontPriceEnabled =
    first(fare, ["upfrontPriceEnabled"]) ?? "";

  row.distanceUnit =
    first(fare, ["distanceUnit"]) || "";

  row.unmodifiedEta =
    numberOrNull(first(fare, ["unmodifiedEta"])) ?? "";

  row.etdDisplayString =
    first(fare, ["etdDisplayString"]) || "";

  row.styledPrimaryFareMagnitude =
    numberOrNull(
      first(fare, [
        "styledPrimaryFareMagnitude",
      ])
    ) ?? "";

  row.isFareLineSuccess =
    first(fare, ["isFareLineSuccess"]) ?? "";

  row.fenceNameFrom =
    first(p, ["fenceNameFrom"]) || "";

  row.polyline =
    getNavigationValue(navigation, [
      "polyline",
      "overviewPolyline",
      "encodedPolyline",
    ]) || "";

  row.defaultVehicleViewId =
    first(p, [
      "defaultVehicleViewId",
    ]) || "";

  row.packageVariantsVehicleViewId =
    first(p, [
      "packageVariantsVehicleViewId",
    ]) || "";

  row.vehicleViewsOrderStr =
    first(p, [
      "vehicleViewsOrderStr",
    ]) || "";

  row.sortWeight =
    first(p, [
      "sortWeight",
    ]) ?? "";

  row.productType =
    first(p, [
      "productType",
      "type",
    ]) || "";

  row.capacity =
    first(p, [
      "capacity",
      "seats",
      "vehicleCapacity",
    ]) ?? "";

  row.rawProduct = flattenJson(p);

  return row;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";

  let text;

  if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function toCsv(rows) {
  const header = CSV_COLUMNS.join(",");

  const body = rows.map((row) =>
    CSV_COLUMNS
      .map((column) => csvEscape(row[column]))
      .join(",")
  );

  return [header, ...body].join("\n");
}

function analyzeRawResponses(responses) {
  const results = [];

  for (const response of responses) {
    const text = JSON.stringify(response.data);

    const keywords = [
      "fare",
      "fareAmountE5",
      "currencyCode",
      "productUuid",
      "vehicleViewUuid",
      "estimatedTripTime",
      "etaInMin",
      "discount",
      "surge",
      "polyline",
      "distance",
    ];

    const hits = keywords.filter((k) =>
      text.toLowerCase().includes(k.toLowerCase())
    );

    if (hits.length) {
      results.push({
        file: response.file,
        score: hits.length,
        matchedKeys: hits,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

function main() {
  console.log("=== Uber Hong Kong Analyzer ===");

  const responses = loadResponses();

  console.log(`Loaded ${responses.length} JSON responses.`);

  const ranked = analyzeRawResponses(responses);

  fs.writeFileSync(
    path.join(DEBUG, "candidate-responses.json"),
    JSON.stringify(ranked, null, 2)
  );

  console.log("\nTop candidate responses:");

  for (const item of ranked.slice(0, 10)) {
    console.log(
      `${item.score} hits | ${item.file} | ${item.matchedKeys.join(", ")}`
    );
  }

  const products = findProducts(responses);
  const navigation = findNavigation(responses);

  console.log(`\nProduct-like objects found: ${products.length}`);
  console.log(`Navigation objects found: ${navigation.length}`);

  const unique = new Map();

  for (const item of products) {
    const p = item.product;

    const id =
      first(p, [
        "productUuid",
        "vehicleViewUuid",
        "vehicleViewId",
        "id",
      ]) ||
      `${item.sourceFile}:${item.sourcePath}`;

    if (!unique.has(id)) {
      unique.set(id, item);
    }
  }

  const uniqueProducts = [...unique.values()];

  console.log(
    `Unique products found: ${uniqueProducts.length}`
  );

  const rows = uniqueProducts.map((item, index) =>
    makeRow(item, navigation, index)
  );

  const csv = toCsv(rows);

  fs.writeFileSync(
    path.join(OUTPUT, "hong-kong-test.csv"),
    csv
  );

  fs.writeFileSync(
    path.join(OUTPUT, "raw-products.json"),
    JSON.stringify(
      uniqueProducts,
      null,
      2
    )
  );

  const mapping = {};

  for (const column of CSV_COLUMNS) {
    const populated = rows.filter(
      (r) =>
        r[column] !== "" &&
        r[column] !== null &&
        r[column] !== undefined
    ).length;

    mapping[column] = {
      populated,
      total: rows.length,
      coverage:
        rows.length
          ? Number((populated / rows.length).toFixed(3))
          : 0,
    };
  }

  fs.writeFileSync(
    path.join(DEBUG, "field-coverage.json"),
    JSON.stringify(mapping, null, 2)
  );

  const report = [];

  report.push("# Hong Kong Uber Test Report");
  report.push("");
  report.push(`Task: ${ROUTE.taskId}`);
  report.push(
    `Route: ${ROUTE.pickup.name} → ${ROUTE.destination.name}`
  );
  report.push("");
  report.push(`JSON responses analyzed: ${responses.length}`);
  report.push(`Product objects found: ${products.length}`);
  report.push(`Unique products: ${uniqueProducts.length}`);
  report.push(`CSV rows generated: ${rows.length}`);
  report.push("");

  report.push("## Products");

  for (const item of uniqueProducts) {
    const p = item.product;
    const fare = item.fare;

    report.push(
      `- ${
        first(p, [
          "description",
          "displayName",
          "title",
          "name",
        ]) || "Unknown"
      }`
    );

    report.push(
      `  - productUuid: ${
        first(p, ["productUuid", "uuid"]) || ""
      }`
    );

    report.push(
      `  - vehicleViewUuid: ${
        first(p, ["vehicleViewUuid"]) || ""
      }`
    );

    report.push(
      `  - fare: ${
        first(fare, [
          "fare",
          "fareAmount",
          "fareAmountE5",
        ]) ?? ""
      }`
    );

    report.push(
      `  - currency: ${
        first(fare, ["currencyCode", "currency"]) || ""
      }`
    );

    report.push(
      `  - ETA: ${
        first(fare, [
          "etaInMin",
          "estimatedTripTime",
        ]) ?? ""
      }`
    );
  }

  report.push("");
  report.push("## Fare availability");

  const fareRows = rows.filter(
    (r) => r.fare !== "" && r.fare !== null
  );

  report.push(
    `Rows with non-empty fare: ${fareRows.length}/${rows.length}`
  );

  report.push("");
  report.push("## Important output files");
  report.push("");
  report.push("- output/hong-kong-test.csv");
  report.push("- output/raw-products.json");
  report.push("- debug/candidate-responses.json");
  report.push("- debug/field-coverage.json");

  fs.writeFileSync(
    path.join(DEBUG, "test-report.md"),
    report.join("\n")
  );

  console.log("\n=== COMPLETE ===");
  console.log(
    `CSV: ${path.join(OUTPUT, "hong-kong-test.csv")}`
  );
  console.log(
    `Report: ${path.join(DEBUG, "test-report.md")}`
  );
  console.log(
    `Coverage: ${path.join(DEBUG, "field-coverage.json")}`
  );

  console.log("\nFare check:");

  if (fareRows.length === 0) {
    console.log(
      "No non-empty fares were found in the captured anonymous responses."
    );
  } else {
    console.log(
      `${fareRows.length} product rows contain fare values.`
    );
  }
}

main();
