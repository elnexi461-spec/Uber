# Public Uber Products operation

Captured from the Hong Kong public mobile-web run.

## Operation

`POST https://m.uber.com/go/graphql`

GraphQL operation: `Products`

## Observed public variables

```json
{
  "includeRecommended": false,
  "destinations": [
    {
      "latitude": 22.3283104,
      "longitude": 114.1858864
    }
  ],
  "payment": {
    "uberCashToggleOn": true
  },
  "pickup": {
    "latitude": 22.398076,
    "longitude": 114.21276399999999
  },
  "targetProductType": "ANONYMOUS"
}
```

## Fields observed in the response

Product-level data includes:

- `id`
- `productUuid`
- `vehicleViewUuid`
- `description`
- `displayName`
- `detailedDescription`
- `cityID`
- `isAvailable`
- `is3p`
- `parentProductUuid`
- `productClassificationTypeName`
- `productImageUrl`
- `fares[]`

Fare objects include:

- `capacity`
- `fare`
- `fareAmountE5`
- `discountPrimary`
- `hasPromo`
- `hasRidePass`
- `meta`
- `preAdjustmentValue`
- `suggestedUpfrontTipAmounts`

## Public-flow limitation observed

The anonymous product response returned empty/null fare and currency values in the captured run. The browser telemetry also reported an unauthenticated session and a product-selection render error.

This artifact intentionally contains **no cookies, authorization headers, session tokens, or raw network headers**.
