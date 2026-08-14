# Implementation Status Report

## 1. What Works

- **89-Column Schema Implemented**: Exact client schema with all 89 columns in correct order.
- **Public Product Extraction**: Reads all captured Uber JSON responses, extracts every available product and fare field.
- **Navigation Extraction**: Successfully extracts distance (11,572m), duration/ETA (964s), polyline from `00027-go-custom-api-navigation-route.json`.
- **Deduplication**: Products deduplicated by `productUuid`.
- **Deterministic Output**: Same inputs always produce identical CSV ordering and content.
- **CSV Generation**: Safe RFC 4180 escaping, UTF-8 output, stable serialization.
- **Field Coverage Reporting**: Every output column traced to AVAILABLE / DERIVED / UNAVAILABLE.
- **Official Estimate Adapter**: `uber-estimates-api.ts` uses Uber's documented Guest Rides Estimates API when authenticated.
- **OAuth 2.0 Implementation**: `uber-auth.ts` implements the official client credentials flow with in-memory token caching, actionable error messages, and never logs credentials.
- **End-to-End Test**: `uber-test-hk` command loads captures, extracts data, generates 89-column CSV, validates schema, attempts official estimates, and produces JSON report.
- **Schema Validation**: Fails if output has anything other than 89 columns or wrong order.

## 2. What Was Tested

- Hong Kong route: 沙田醫院 → 南方花園
- Task ID: `hk_202606192058594097`
- 17 JSON responses in `debug/uber-responses/`
- 13 unique products discovered across 4 tiers (Popular, Economy, Premium, More)
- Navigation response verified
- OAuth token endpoint tested with both testing and production credentials

## 3. Exact Commands Used

```bash
# Typecheck (requires tsx/typescript installed)
pnpm --filter @workspace/scripts run typecheck

# Run public extraction
cd scripts && npx tsx ./src/uber-public-extract.ts

# Run official estimates (requires valid credentials)
UBER_CLIENT_ID=xxx UBER_CLIENT_SECRET=xxx npx tsx ./src/uber-estimates-api.ts

# Run end-to-end Hong Kong test (89-column)
cd scripts && npx tsx ./src/uber-test-hk.ts

# Run tests
cd scripts && node --test ./src/__tests__/*.test.ts
```

## 4. Exact Fields Successfully Extracted

**AVAILABLE (from capture):**
- `fare` (empty string in anonymous — preserved as-is, not fabricated)
- `description`, `displayName`, `detailedDescription`
- `productId`, `productUuid`
- `cityId`, `available`, `is3p`, `parentProductUuid`, `imageUrl`
- `title` (tier title: Popular, Economy, Premium, More)
- `estimatedTripTime`, `etaStringShort`, `etaInMin`, `etaMax`
- `capacity`, `hasPromo`, `hasRidePass`
- `preAdjustmentMagnitude` (from product.preAdjustmentValue)
- `discountPrimaryMagnitude` (from fares[0].discountPrimary)
- `vehicleViewId` (fallback to defaultVVID=9697)
- `defaultVehicleViewId` (9697)
- `hourlyTiers` (null in capture)
- `unmodifiedDistance` (11572m from navigation)
- `unmodifiedEta` (964s from navigation)
- `polyline` (636 chars from navigation)

**DERIVED (from config/timestamp):**
- `taskId`, `originLat`, `originLng`, `destinationLat`, `destinationLng`
- `flng`, `flat`, `tlng`, `tlat`
- `pullTime`, `executeTime` (ISO 8601 UTC)
- `bjHour`, `bjMinute`, `executeWeekday` (Beijing timezone UTC+8)

**UNAVAILABLE (genuinely absent from anonymous capture):**
- `accountid`, `country`, `dayType`, `timeSeason`, `batchId`, `routeId`
- `baseFlng`, `baseFlat`, `baseTlng`, `baseTlat`
- `surgeMultiplier`, `formattedFare`, `accessibilityText`, `defaultText`
- `pricingTemplatesDefaultText`, `magnitude`, `unit`, `textDisplayed`
- `rankedSecondaryFareAccessibilityText`, `styledPrimaryFareMagnitude`, `styledPrimaryFareAccessibilityText`
- `estimateRequestTime`, `etdDisplayString`, `estimatedSoloOnTripTime`
- `packageVariantsVehicleViewId`, `sortWeight`, `vehicleViewsOrderStr`
- `adjustmentMagnitude`, `postAdjustmentMagnitude`
- `predictEta`, `predictDistance`, `predictHaversineDistance`
- `predictEstimatedOriginLatitude`, `predictEstimatedOriginLongitude`
- `predictEstimatedDestinationLatitude`, `predictEstimatedDestinationLongitude`
- `etaString`, `minEta`, `averageEta`
- `baseValue`, `distanceUnit`, `type`, `perDistanceUnitValue`, `perMinuteValue`
- `minimumValue`, `cancellationValue`, `safeRidesFeeValue`, `perWaitMinuteValue`
- `allowFareEstimate`, `allowedToSurge`, `shouldFetchUpfrontFare`, `upfrontPriceEnabled`
- `estimatedTolls`, `fareLineItems`, `maxFare`, `minFare`, `isFareLineSuccess`
- `fenceNameFrom`, `discountedPrice`, `header`, `screenshotBase64`

## 5. Exact Fields Unavailable — Fare Details

**Anonymous flow returns empty/null for all fare fields:**
- `fare`: `""` (empty string) — NOT a real price
- `fareAmountE5`: `null`
- `currencyCode`: `""` (empty string)
- `discountPrimary`: `""` (empty string)
- `preAdjustmentValue`: `""` (empty string)

These are preserved exactly as captured. No fabrication.

## 6. Whether Live Fares Were Obtained

**No.** The OAuth token endpoint returned errors for both credential sets:

- **Testing credentials** (`ORlb3wxPzdKgODzQJhCRj5ZFqPKWZohA` / `XvOxVAkuhKr4KhlyWsu0zKYBA_ISqAxshSOtvho5`):
  - Production: `unauthorized_client` — "environment mismatched"
  - Sandbox: `invalid_scope` — "scope(s) are invalid"
  - Conclusion: Testing credentials cannot access the Guest Rides Estimates scope

- **Production credentials** (`rgCz2_-kDEHX8nC04TiMjzRFZlZo0Sfb` / `N47VGwA9XPFUG3kYfWb7eqv_pHBQCz1xqZg`):
  - Production: `access_denied` — "client secret mismatch"
  - Sandbox: `unauthorized_client` — "environment mismatched"
  - Conclusion: The client_secret does not match the client_id, OR the app is not activated

**Blocker:** Valid Uber OAuth credentials with the `guests.trips` scope are required to obtain live fares.

## 7. Whether the 89-Column Schema Is Now Reproduced

**Yes.** The exact 89-column schema from `2026-08-11_21_N_price_V04.csv` is implemented:
- All 89 columns in exact order
- Column names match exactly
- CSV output validated to have exactly 89 columns
- Schema validation fails if column count or order is wrong

## 8. Remaining Blockers

1. **OAuth Credential Mismatch**: Production credentials return `access_denied: client secret mismatch`. Possible causes:
   - The client_secret was copy-pasted incorrectly or truncated
   - The app is not yet activated/published in the Uber Developer Dashboard
   - The client_secret was regenerated and the old value is no longer valid
   - **Action required**: Verify credentials at https://developer.uber.com/dashboard

2. **Testing Credentials Invalid**: Testing credentials cannot access the `guests.trips` scope. They may be limited to sandbox-only endpoints or different scopes.

3. **~54 fields unavailable in anonymous flow**: These require authenticated endpoints.

## 9. Recommended Next Steps

1. **Fix OAuth credentials**:
   - Go to https://developer.uber.com/dashboard
   - Verify the App has "Guest Rides Estimates" API enabled
   - Copy the exact `client_id` and `client_secret` (ensure no trailing spaces)
   - If the secret was regenerated, use the new value
   - Ensure the app status is "Active" or "Published"

2. **Re-run the test**:
   ```bash
   export UBER_CLIENT_ID="your-correct-client-id"
   export UBER_CLIENT_SECRET="your-correct-client-secret"
   pnpm --filter @workspace/scripts run uber-test-hk
   ```

3. **If credentials are correct**, the test will:
   - Exchange credentials for an access token
   - Call `api.uber.com/v1/guests/trips/estimates`
   - Populate additional fields: `currencyCode`, `formattedFare`, `surgeMultiplier`, `fareLineItems`, `maxFare`, `minFare`, `distanceUnit`, `perDistanceUnitValue`, `perMinuteValue`, `minimumValue`
