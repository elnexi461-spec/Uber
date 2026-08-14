# Schema Blocker Documentation

## Status
The exact 89-column client schema was **not found** in this repository.

## Search Performed
- Searched for filename: `2026-08-11_21_N_price_V04.csv`
- Searched directories: `artifacts/`, `debug/`, `output/`, `scripts/`, root
- Searched file contents for: `89`, column headers, field mapping references
- Existing `debug/field-mapping.json` contains only **37 fields**, not 89.

## Existing Field Mapping
The only authoritative mapping file is `debug/field-mapping.json` (37 fields):
- Directly available (5): `fare`, `description`, `currencyCode`, `estimatedTripTime`, `title`
- Missing (32): `accountid`, `pullTime`, `executeTime`, `country`, `flng`, `flat`, `tlng`, `tlat`, `originLat`, `originLng`, `destinationLat`, `destinationLng`, `vehicleViewId`, `surgeMultiplier`, `formattedFare`, `etaString`, `predictDistance`, `predictEta`, `discountPrimaryMagnitude`, `discountedPrice`, `fareLineItems`, `baseValue`, `perDistanceUnitValue`, `perMinuteValue`, `minimumValue`, `minFare`, `maxFare`, `polyline`, `header`, `accessibilityText`, `routeId`, `taskId`

## Conclusion
The 89-column schema is **unverified**. All pipeline output is built on the normalized internal model derived strictly from captured public web data and documented official APIs. No missing schema columns are invented.
