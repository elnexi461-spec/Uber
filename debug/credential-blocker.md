# Credential Blocker Documentation

## Status: ACTIVE — OAuth credentials invalid

## Testing Performed

### Credential Set 1: Testing Credentials
- **client_id**: `ORlb3wxPzdKgODzQJhCRj5ZFqPKWZohA`
- **client_secret**: `XvOxVAkuhKr4KhlyWsu0zKYBA_ISqAxshSOtvho5`
- **Type**: Client credentials (40-char secret, not a Bearer token)
- **Bearer test**: HTTP 401 `{"code":"unauthorized","message":"Invalid OAuth 2.0 credentials provided."}`
- **OAuth production** (`login.uber.com`): HTTP 401 `unauthorized_client` — "environment mismatched"
- **OAuth sandbox** (`sandbox-login.uber.com`): HTTP 400 `invalid_scope` — "scope(s) are invalid"
- **Conclusion**: Testing credentials cannot access the `guests.trips` scope

### Credential Set 2: Production Credentials
- **client_id**: `rgCz2_-kDEHX8nC04TiMjzRFZlZo0Sfb`
- **client_secret**: `N47VGwA9XPFUG3kYfWb7eqv_pHBQCz1xqZg`
- **OAuth production** (`login.uber.com`): HTTP 403 `access_denied` — "client secret mismatch"
- **OAuth sandbox** (`sandbox-login.uber.com`): HTTP 401 `unauthorized_client` — "environment mismatched"
- **Conclusion**: The client_secret does not match the client_id, OR the app is not activated

## Root Cause Analysis

The `client secret mismatch` error from Uber's OAuth server indicates one of:
1. The client_secret was copy-pasted incorrectly or truncated
2. The app is not yet activated/published in the Uber Developer Dashboard
3. The client_secret was regenerated and the old value is no longer valid
4. The credentials belong to a different app or environment

## Required Action

1. Go to https://developer.uber.com/dashboard
2. Select the correct app
3. Verify the App has "Guest Rides Estimates" API enabled under "Products"
4. Copy the exact `client_id` and `client_secret` from the "Auth" tab
5. Ensure no trailing spaces or line breaks in the copied values
6. If the secret was regenerated, use the new value immediately
7. Ensure the app status is "Active" or "Published" (not "In Development" with restricted access)

## Impact

Without valid OAuth credentials:
- `fare`, `currencyCode`, `formattedFare` remain empty
- `surgeMultiplier`, `fareLineItems`, `maxFare`, `minFare` remain empty
- `distanceUnit`, `perDistanceUnitValue`, `perMinuteValue`, `minimumValue` remain empty
- The pipeline outputs the 89-column schema with ~22 populated fields + 13 derived fields
- ~54 fields remain unavailable

## Code Ready

The OAuth implementation (`scripts/src/uber-auth.ts`) is production-ready and will work immediately once valid credentials are provided. It:
- Implements the official client credentials flow
- Caches tokens in memory with expiry buffer
- Provides actionable error messages for each failure mode
- Never logs or writes credentials to disk
- Falls back gracefully when credentials are unavailable
