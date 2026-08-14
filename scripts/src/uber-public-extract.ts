import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const RESPONSE_DIR = join(ROOT, "debug", "uber-responses");
const OUTPUT_DIR = join(ROOT, "output");
const DEBUG_DIR = join(ROOT, "debug");

const ROUTE = {
  taskId: "hk_202606192058594097",
  pickup: { lat: 22.395771, lng: 114.217333 },
  destination: { lat: 22.325528, lng: 114.19081 },
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ProductRecord = {
  sourceFile: string;
  productId: string | null;
  productUuid: string | null;
  vehicleViewUuid: string | null;
  description: string | null;
  displayName: string | null;
  detailedDescription: string | null;
  capacity: number | null;
  cityId: string | null;
  available: boolean | null;
  is3p: boolean | null;
  productType: string | null;
  parentProductUuid: string | null;
  imageUrl: string | null;
  fare: {
    fare: string | null;
    fareAmountE5: number | null;
    currencyCode: string | null;
    discountPrimary: string | null;
    hasPromo: boolean | null;
    hasRidePass: boolean | null;
    preAdjustmentValue: string | null;
    meta: Json | null;
  } | null;
};

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

function productFromNode(node: { [key: string]: Json }, sourceFile: string): ProductRecord | null {
  const looksLikeProduct =
    ("productUuid" in node || "id" in node) &&
    ("description" in node || "displayName" in node || "fares" in node);

  if (!looksLikeProduct) return null;

  const fares = Array.isArray(node.fares) ? node.fares : [];
  const fareNode = fares.find(isObject) ?? null;

  return {
    sourceFile,
    productId: str(node.id),
    productUuid: str(node.productUuid),
    vehicleViewUuid: str(node.vehicleViewUuid),
    description: str(node.description),
    displayName: str(node.displayName),
    detailedDescription: str(node.detailedDescription),
    capacity: fareNode ? num(fareNode.capacity) : null,
    cityId: str(node.cityID),
    available: bool(node.isAvailable),
    is3p: bool(node.is3p),
    productType: str(node.productClassificationTypeName),
    parentProductUuid: str(node.parentProductUuid),
    imageUrl: str(node.productImageUrl),
    fare: fareNode
      ? {
          fare: str(fareNode.fare),
          fareAmountE5: num(fareNode.fareAmountE5),
          currencyCode: str(node.currencyCode) ?? str(fareNode.currencyCode),
          discountPrimary: str(fareNode.discountPrimary),
          hasPromo: bool(fareNode.hasPromo),
          hasRidePass: bool(fareNode.hasRidePass),
          preAdjustmentValue: str(fareNode.preAdjustmentValue),
          meta: parseEmbedded(fareNode.meta),
        }
      : null,
  };
}

function csv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(DEBUG_DIR, { recursive: true });

  const files = (await readdir(RESPONSE_DIR)).filter((name) => name.endsWith(".json"));
  const products = new Map<string, ProductRecord>();
  const responseSummary: Array<Record<string, unknown>> = [];

  for (const file of files) {
    let parsed: Json;
    try {
      parsed = JSON.parse(await readFile(join(RESPONSE_DIR, file), "utf8")) as Json;
    } catch {
      continue;
    }

    let count = 0;
    walk(parsed, (node) => {
      if (!isObject(node)) return;
      const product = productFromNode(node, file);
      if (!product) return;
      count++;
      const key = product.productUuid ?? `${product.productId}:${product.displayName}`;
      if (!products.has(key)) products.set(key, product);
    });

    if (count) responseSummary.push({ file, productObjects: count });
  }

  const rows = [...products.values()];
  const columns = [
    "taskId", "sourceFile", "productId", "productUuid", "vehicleViewUuid",
    "description", "displayName", "detailedDescription", "capacity", "cityId",
    "available", "is3p", "productType", "parentProductUuid", "imageUrl",
    "fare", "fareAmountE5", "currencyCode", "discountPrimary", "hasPromo",
    "hasRidePass", "preAdjustmentValue", "fareMeta",
    "pickupLat", "pickupLng", "destinationLat", "destinationLng",
  ];

  const csvRows = rows.map((r) => [
    ROUTE.taskId, r.sourceFile, r.productId, r.productUuid, r.vehicleViewUuid,
    r.description, r.displayName, r.detailedDescription, r.capacity, r.cityId,
    r.available, r.is3p, r.productType, r.parentProductUuid, r.imageUrl,
    r.fare?.fare, r.fare?.fareAmountE5, r.fare?.currencyCode, r.fare?.discountPrimary,
    r.fare?.hasPromo, r.fare?.hasRidePass, r.fare?.preAdjustmentValue, r.fare?.meta,
    ROUTE.pickup.lat, ROUTE.pickup.lng, ROUTE.destination.lat, ROUTE.destination.lng,
  ]);

  await writeFile(
    join(OUTPUT_DIR, "public-products.csv"),
    [columns.join(","), ...csvRows.map((row) => row.map(csv).join(","))].join("\n") + "\n",
    "utf8",
  );

  await writeFile(
    join(OUTPUT_DIR, "public-products.json"),
    JSON.stringify({ route: ROUTE, products: rows }, null, 2) + "\n",
    "utf8",
  );

  const fareRows = rows.filter((r) => !!r.fare?.fare || r.fare?.fareAmountE5 != null);
  const currencyRows = rows.filter((r) => !!r.fare?.currencyCode);

  await writeFile(
    join(DEBUG_DIR, "public-data-audit.json"),
    JSON.stringify(
      {
        route: ROUTE,
        responseFiles: files.length,
        productResponseFiles: responseSummary,
        uniqueProducts: rows.length,
        productsWithFare: fareRows.length,
        productsWithCurrency: currencyRows.length,
        products: rows.map((r) => ({
          sourceFile: r.sourceFile,
          productId: r.productId,
          productUuid: r.productUuid,
          vehicleViewUuid: r.vehicleViewUuid,
          displayName: r.displayName,
          description: r.description,
          capacity: r.capacity,
          available: r.available,
          fare: r.fare?.fare ?? null,
          fareAmountE5: r.fare?.fareAmountE5 ?? null,
          currencyCode: r.fare?.currencyCode ?? null,
          hasPromo: r.fare?.hasPromo ?? null,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`Responses scanned: ${files.length}`);
  console.log(`Unique products: ${rows.length}`);
  console.log(`Products with fare: ${fareRows.length}`);
  console.log(`Products with currency: ${currencyRows.length}`);
  console.log(`Wrote ${join(OUTPUT_DIR, "public-products.csv")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
