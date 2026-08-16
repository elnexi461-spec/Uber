# Hong Kong Uber public-flow diagnostic

- Task: `hk_202606192058594097`
- Route: 沙田醫院 (22.395771, 114.217333) → 南方花園 (22.325528, 114.19081)
- Flow status: **results_detected**
- Public flow worked: **yes**
- Exact blocker: None.
- Requests captured: **28**
- JSON responses: **17**
- Products/offers discovered: **6**
- Schema file: not found
- CSV output: **not created** — The required 89-column CSV schema file was not found.

## Strongest candidate response

- `debug/uber-responses/00026-go-graphql.json` — POST 200 https://m.uber.com/go/graphql
- Confidence: 0.95
- Reason: matched request terms: estimate, fare, product, trip, ride, upfront, eta; 5/7 pricing data indicator groups found; 100 relevant JSON paths

## Discovered values

- Product/service names: Taxi; Comfort; Lantau Taxi; UberX; UberXL; UberXXL; Car Seat (1-7yo); Electric; Car Seat (4-7yo); Elite; Uber Pet; Black; Assist
- Fare values: null; ; null; ; null; ; null; ; null; ; null; ; null; ; null; ; null; ; null; 
- Currency: 
- ETA/duration: Match with closest taxi with upfront pricing; null; ; {"originalArgs":{"destinations":[{"latitude":22.3283104,"longitude":114.1858864}],"includeRecommended":false,"payment":{"uberCashToggleOn":true},"pickup":{"latitude":22.398076,"longitude":114.21276399999999},"targetProductType":"ANONYMOUS"}}; Extra legroom with top rated driver-partners; null; ; {"originalArgs":{"destinations":[{"latitude":22.3283104,"longitude":114.1858864}],"includeRecommended":false,"payment":{"uberCashToggleOn":true},"pickup":{"latitude":22.398076,"longitude":114.21276399999999},"targetProductType":"ANONYMOUS"}}; Reserve Lantau Taxi with upfront pricing; null; ; {"originalArgs":{"destinations":[{"latitude":22.3283104,"longitude":114.1858864}],"includeRecommended":false,"payment":{"uberCashToggleOn":true},"pickup":{"latitude":22.398076,"longitude":114.21276399999999},"targetProductType":"ANONYMOUS"}}; Affordable, everyday rides; null; ; {"originalArgs":{"destinations":[{"latitude":22.3283104,"longitude":114.1858864}],"includeRecommended":false,"payment":{"uberCashToggleOn":true},"pickup":{"latitude":22.398076,"longitude":114.21276399999999},"targetProductType":"ANONYMOUS"}}; Extra seats for six, may pair with a Govt-licensed Taxi Fleet; null; ; {"originalArgs":{"destinations":[{"latitude":22.3283104,"longitude":114.1858864}],"includeRecommended":false,"payment":{"uberCashToggleOn":true},"pickup":{"latitude":22.398076,"longitude":114.21276399999999},"targetProductType":"ANONYMOUS"}}
- Promotions/discounts: ; false; ; false; ; false; ; false; ; false; ; false; ; false; ; false; ; false; ; false

## Field availability

- Directly available (5): fare, description, currencyCode, estimatedTripTime, title
- Missing (32): accountid, pullTime, executeTime, country, flng, flat, tlng, tlat, originLat, originLng, destinationLat, destinationLng, vehicleViewId, surgeMultiplier, formattedFare, etaString, predictDistance, predictEta, discountPrimaryMagnitude, discountedPrice, fareLineItems, baseValue, perDistanceUnitValue, perMinuteValue, minimumValue, minFare, maxFare, polyline, header, accessibilityText, routeId, taskId

## Assessment

The public response appears not sufficient to reproduce the client's dataset for this route.
Only values present in captured JSON were considered. No undocumented endpoint, proxy, CAPTCHA bypass, authentication bypass, or synthetic Uber value was used.

## Interaction trace

- destination selected by name: 南方花園
- pickup selected by name: 沙田醫院
- Price-like text was detected in the rendered page.
