# Implementation Status Report

## 1. What Works

- **Public Product Extraction**: Reads all captured Uber JSON responses from `debug/uber-responses/`, identifies Product GraphQL responses, extracts every available product and fare field.
- **Navigation Extraction**: Successfully extracts distance (11,572m), duration/ETA (964s), polyline, and leg-level metadata from `00027-go-custom-api-navigation-route.json`.
- **Deduplication**: Products are deduplicated by `productUuid` with fallback to `productId:displayName`.
- **Deterministic Output**: Same inputs always produce identical CSV ordering and content.
- **CSV Generation**: Safe RFC 4180 escaping, UTF-8 output, stable serialization.
- **Field Coverage Reporting**: Every output column is traced to SOURCE, DERIVED, or UNAVAILABLE.
- **Official Estimate Adapter**: `uber-estimates-api.ts` uses Uber's documented Guest Rides Estimates API when `UBER_ACCESS_TOKEN` is provided. Token is never logged or written to disk.
- **End-to-End Test**: `uber-test-hk` command loads captures, extracts data, generates CSV, validates schema, and produces JSON report.

## 2. What Was Tested

- Hong Kong route: 沙田醫院 → 南方花園
- Task ID: `hk_202606192058594097`
- 17 JSON responses in `debug/uber-responses/`
- 13 unique products discovered
- Navigation response verified

## 3. Exact Commands Used

```bash
# Typecheck
npx tsx --version  # tsx v4.x

# Run public extraction
cd scripts && npx tsx ./src/uber-public-extract.ts

# Run official estimates (requires token)
UBER_ACCESS_TOKEN=xxx npx tsx ./src/uber-estimates-api.ts

# Run end-to-end Hong Kong test
cd scripts && npx tsx ./src/uber-test-hk.ts

# Run tests
cd scripts && node --test ./src/__tests__/*.test.ts
```

## 4. Exact Fields Successfully Extracted

**From Public Products GraphQL (SOURCE):**
- `productId`, `productUuid`, `description`, `displayName`, `detailedDescription`
- `cityId`, `available`, `is3p`, `parentProductUuid`, `imageUrl`
- `title` (tier title)
- `estimatedTripTime`, `etaStringShort`, `etaInMin`, `etaMax`
- `capacity`, `hasPromo`, `hasRidePass`, `fareMeta`

**From Navigation Response (SOURCE):**
- `distanceMeters` (11572)
- `durationSeconds` (964)
- `polyline`

**Derived from Route Config (DERIVED):**
- `taskId`, `originLat`, `originLng`, `destinationLat`, `destinationLng`
- `flat`, `flng`, `tlat`, `tlng`
- `sourceFile`

## 5. Exact Fields Unavailable

All of the following are **genuinely absent** from the anonymous public mobile-web capture:
- `routeId`, `pullTime`, `executeTime`, `accountid`
- `country`, `header`, `accessibilityText`
- `vehicleViewId` (always null in anonymous flow)
- `formattedFare`, `discountPrimaryMagnitude`, `discountedPrice`
- `fareLineItems`, `baseValue`, `perDistanceUnitValue`, `perMinuteValue`, `minimumValue`, `minFare`, `maxFare`
- `etaString`, `predictDistance`, `predictEta`
- `surgeMultiplier`

**Fare-specific unavailable fields:**
- `fare` (empty string in source)
- `fareAmountE5` (null in source)
- `currencyCode` (empty string in source)
- `discountPrimary` (empty string in source)
- `preAdjustmentValue` (empty string in source)

## 6. Whether Live Fares Were Obtained

**No.** The anonymous public mobile-web flow returns empty strings for `fare`, `currencyCode`, `discountPrimary`, and null for `fareAmountE5`. This is consistent across all 13 products. No fare values were fabricated.

## 7. Whether the 89-Column Schema Was Verified

**No.** The file `2026-08-11_21_N_price_V04.csv` was not found anywhere in the repository. The existing `debug/field-mapping.json` contains only 37 fields. The 89-column schema remains unverified. See `debug/schema-blocker.md`.

## 8. Remaining Blockers

1. **89-Column Schema Missing**: The client's exact CSV column order and names cannot be verified without the original schema file. The pipeline currently outputs a normalized 54-column schema based strictly on available data.
2. **Anonymous Fare Gap**: Uber's anonymous public web endpoint does not return fare amounts. Live fares require either:
   - A valid `UBER_ACCESS_TOKEN` for the Guest Rides Estimates API (implemented but requires credential), OR
   - An authenticated session (not implemented; no bypass attempted)
3. **No Checkpoint/Resume**: The production architecture is designed but not fully wired for multi-route batch processing with checkpointing.

## 9. Recommended Next Implementation Step

1. **Obtain the 89-column schema file** from the client (`2026-08-11_21_N_price_V04.csv` or equivalent). Once provided, update `EXPECTED_COLUMNS` in `uber-test-hk.ts` and `getOutputColumns()` in `uber-public-extract.ts` to match exactly.
2. **Obtain a legitimate Uber Guest Rides API token** to populate fare fields. The adapter is ready; only the token is missing.
3. **Deploy batch processing**: Use the provided architecture diagram (Route parser -> Queue -> Extraction -> Normalizer -> Output) with the retry/backoff/checkpoint scaffolding already prepared in the type definitions.
