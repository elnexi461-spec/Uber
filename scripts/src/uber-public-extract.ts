import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Route, Product, Fare, Navigation, OutputRow } from "./types.js";

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

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: Json): value is { [key: string]: Json } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function walk(value: Json, fn: (node: Json) => void): void {
  fn(value);
  if (Array.isArray(value)) {
    for (const child of value) walk(child, fn);
    return;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) walk(child, fn);
  }
}

function str(value: Json): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function num(value: Json): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: Json): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseEmbedded(value: Json): Json | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value) as Json;
  } catch {
    return null;
  }
}

function fareFromNode(node: { [key: string]: Json }): Fare | null {
  if (!node || typeof node !== "object") return null;
  const hasFareFields = "fare" in node || "fareAmountE5" in node || "capacity" in node;
  if (!hasFareFields) return null;

  return {
    capacity: num(node.capacity),
    fare: str(node.fare),
    fareAmountE5: num(node.fareAmountE5),
    currencyCode: str(node.currencyCode),
    discountPrimary: str(node.discountPrimary),
    hasPromo: bool(node.hasPromo),
    hasRidePass: bool(node.hasRidePass),
    preAdjustmentValue: str(node.preAdjustmentValue),
    meta: parseEmbedded(node.meta),
  };
}

function productFromNode(node: { [key: string]: Json }, sourceFile: string, tierTitle: string | null): Product | null {
  const looksLikeProduct =
    ("productUuid" in node || "id" in node) &&
    ("description" in node || "displayName" in node || "fares" in node);

  if (!looksLikeProduct) return null;

  const faresArray = Array.isArray(node.fares) ? node.fares : [];
  const fares: Fare[] = faresArray.filter(isObject).map(fareFromNode).filter((f): f is Fare => f !== null);

  return {
    sourceFile,
    productId: str(node.id),
    productUuid: str(node.productUuid),
    vehicleViewUuid: str(node.vehicleViewUuid),
    description: str(node.description),
    displayName: str(node.displayName),
    detailedDescription: str(node.detailedDescription),
    cityId: str(node.cityID),
    available: bool(node.isAvailable),
    is3p: bool(node.is3p),
    productType: str(node.productClassificationTypeName),
    parentProductUuid: str(node.parentProductUuid),
    imageUrl: str(node.productImageUrl),
    tierTitle,
    estimatedTripTime: num(node.estimatedTripTime),
    etaInMin: num(node.etaInMin),
    etaMax: num(node.etaMax),
    etaStringShort: str(node.etaStringShort),
    hasPromo: bool(node.hasPromo),
    hasRidePass: bool(node.hasRidePass),
    fares: fares.length > 0 ? fares : null,
  };
}

function extractNavigation(responses: Array<{ file: string; json: Json }>): Navigation | null {
  for (const { file, json } of responses) {
    if (!file.includes("navigation")) continue;
    if (!Array.isArray(json) || json.length === 0) continue;
    const nav = json[0];
    if (!isObject(nav)) continue;

    const legs = Array.isArray(nav.legs)
      ? nav.legs.filter(isObject).map((leg) => ({
          distanceMeters: num(leg.distance),
          durationSeconds: num(leg.duration),
        }))
      : null;

    return {
      sourceFile: file,
      distanceMeters: num(nav.distance),
      durationSeconds: num(nav.eta),
      etaSeconds: num(nav.eta),
      polyline: str(nav.polyline),
      legs,
    };
  }
  return null;
}

function deduplicateProducts(products: Product[]): Product[] {
  const seen = new Map<string, Product>();
  for (const p of products) {
    const key = p.productUuid ?? `${p.productId}:${p.displayName ?? "unknown"}`;
    if (!seen.has(key)) {
      seen.set(key, p);
    }
  }
  return Array.from(seen.values());
}

function productToOutputRow(product: Product, route: Route, navigation: Navigation | null): OutputRow {
  const firstFare = product.fares?.[0] ?? null;

  return {
    taskId: route.taskId,
    routeId: null,
    pullTime: null,
    executeTime: null,
    accountid: null,
    originLat: route.pickup.lat,
    originLng: route.pickup.lng,
    destinationLat: route.destination.lat,
    destinationLng: route.destination.lng,
    flat: route.pickup.lat,
    flng: route.pickup.lng,
    tlat: route.destination.lat,
    tlng: route.destination.lng,
    productId: product.productId,
    productUuid: product.productUuid,
    vehicleViewId: product.vehicleViewUuid,
    description: product.description,
    displayName: product.displayName,
    detailedDescription: product.detailedDescription,
    title: product.tierTitle,
    header: null,
    accessibilityText: null,
    available: product.available,
    is3p: product.is3p,
    productType: product.productType,
    parentProductUuid: product.parentProductUuid,
    cityId: product.cityId,
    country: null,
    imageUrl: product.imageUrl,
    capacity: firstFare?.capacity ?? null,
    fare: firstFare?.fare ?? null,
    fareAmountE5: firstFare?.fareAmountE5 ?? null,
    currencyCode: firstFare?.currencyCode ?? null,
    formattedFare: null,
    discountPrimary: firstFare?.discountPrimary ?? null,
    discountPrimaryMagnitude: null,
    discountedPrice: null,
    hasPromo: firstFare?.hasPromo ?? product.hasPromo,
    hasRidePass: firstFare?.hasRidePass ?? product.hasRidePass,
    preAdjustmentValue: firstFare?.preAdjustmentValue ?? null,
    fareLineItems: null,
    baseValue: null,
    perDistanceUnitValue: null,
    perMinuteValue: null,
    minimumValue: null,
    minFare: null,
    maxFare: null,
    estimatedTripTime: product.estimatedTripTime,
    etaString: null,
    etaStringShort: product.etaStringShort,
    etaInMin: product.etaInMin,
    etaMax: product.etaMax,
    predictDistance: null,
    predictEta: null,
    distanceMeters: navigation?.distanceMeters ?? null,
    durationSeconds: navigation?.durationSeconds ?? null,
    polyline: navigation?.polyline ?? null,
    surgeMultiplier: null,
    fareMeta: firstFare?.meta ?? null,
    sourceFile: product.sourceFile,
  };
}

function csv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function getOutputColumns(): (keyof OutputRow)[] {
  return [
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
}

export async function extractFromResponses(responseDir: string, route: Route): Promise<{
  products: Product[];
  navigation: Navigation | null;
  rows: OutputRow[];
  responseFiles: string[];
  productResponseFiles: Array<{ file: string; productObjects: number }>;
}> {
  const files = (await readdir(responseDir)).filter((name) => name.endsWith(".json"));
  const products: Product[] = [];
  const responseSummary: Array<{ file: string; productObjects: number }> = [];
  const parsedResponses: Array<{ file: string; json: Json }> = [];

  for (const file of files) {
    let parsed: Json;
    try {
      parsed = JSON.parse(await readFile(join(responseDir, file), "utf8")) as Json;
      parsedResponses.push({ file, json: parsed });
    } catch {
      continue;
    }

    let count = 0;
    walk(parsed, (node) => {
      if (!isObject(node)) return;

      if (Array.isArray(node.products) && "title" in node) {
        const tierTitle = str(node.title);
        for (const child of node.products) {
          if (!isObject(child)) continue;
          const product = productFromNode(child, file, tierTitle);
          if (product) {
            count++;
            products.push(product);
          }
        }
        return;
      }

      const product = productFromNode(node, file, null);
      if (product) {
        count++;
        products.push(product);
      }
    });

    if (count) responseSummary.push({ file, productObjects: count });
  }

  const navigation = extractNavigation(parsedResponses);
  const deduped = deduplicateProducts(products);
  const rows = deduped.map((p) => productToOutputRow(p, route, navigation));

  return {
    products: deduped,
    navigation,
    rows,
    responseFiles: files,
    productResponseFiles: responseSummary,
  };
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DEBUG_DIR, { recursive: true });

  const { products, navigation, rows, responseFiles, productResponseFiles } =
    await extractFromResponses(RESPONSE_DIR, ROUTE);

  const columns = getOutputColumns();
  const csvRows = rows.map((r) => columns.map((c) => csv(r[c])));

  await writeFile(
    join(OUTPUT_DIR, "public-products.csv"),
    [columns.join(","), ...csvRows].join("\n") + "\n",
    "utf8",
  );

  await writeFile(
    join(OUTPUT_DIR, "public-products.json"),
    JSON.stringify({ route: ROUTE, navigation, products, rows }, null, 2) + "\n",
    "utf8",
  );

  const fareRows = rows.filter((r) => !!r.fare && r.fare !== "");
  const currencyRows = rows.filter((r) => !!r.currencyCode && r.currencyCode !== "");
  const navAvailable = navigation !== null;

  await writeFile(
    join(DEBUG_DIR, "public-data-audit.json"),
    JSON.stringify(
      {
        route: ROUTE,
        responseFiles: responseFiles.length,
        productResponseFiles,
        uniqueProducts: products.length,
        productsWithFare: fareRows.length,
        productsWithCurrency: currencyRows.length,
        navigationAvailable: navAvailable,
        navigation,
        products: products.map((r) => ({
          sourceFile: r.sourceFile,
          productId: r.productId,
          productUuid: r.productUuid,
          vehicleViewUuid: r.vehicleViewUuid,
          displayName: r.displayName,
          description: r.description,
          capacity: r.fares?.[0]?.capacity ?? null,
          available: r.available,
          fare: r.fares?.[0]?.fare ?? null,
          fareAmountE5: r.fares?.[0]?.fareAmountE5 ?? null,
          currencyCode: r.fares?.[0]?.currencyCode ?? null,
          hasPromo: r.fares?.[0]?.hasPromo ?? null,
          tierTitle: r.tierTitle,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`Responses scanned: ${responseFiles.length}`);
  console.log(`Unique products: ${products.length}`);
  console.log(`Products with fare: ${fareRows.length}`);
  console.log(`Products with currency: ${currencyRows.length}`);
  console.log(`Navigation available: ${navAvailable}`);
  if (navigation) {
    console.log(`  Distance: ${navigation.distanceMeters}m`);
    console.log(`  Duration: ${navigation.durationSeconds}s`);
    console.log(`  Polyline: ${navigation.polyline ? navigation.polyline.slice(0, 50) + "..." : "none"}`);
  }
  console.log(`Wrote ${join(OUTPUT_DIR, "public-products.csv")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
