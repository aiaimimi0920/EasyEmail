# NMail Platform Account API Contract

NMail currently uses a local fake platform account server so the left-rail
account UI can be developed before the real NeuroPlatform identity service is
available.

## Development server

- Server kind: `fake_platform_account_server`
- Server URL: `nmail-dev://platform-account.local`
- Auth mode: `unsigned_dev_session`
- API version: `2026-06-15.dev`

## Tauri commands used by the desktop app

### `platform_account_get_session`

Returns the current platform session, including account profile, quota summary,
and the future HTTP endpoint contract.

Response shape:

```ts
type PlatformAccountSessionDto = {
  server_kind: string;
  server_url: string;
  api_version: string;
  auth_mode: string;
  account: PlatformAccountDto;
  usage: PlatformAccountUsageDto;
  endpoints: PlatformAccountEndpointDto[];
};
```

### `platform_account_query_data`

Request:

```ts
type PlatformAccountQueryRequest = {
  resource: "session" | "profile" | "usage" | "entitlements";
};
```

Response:

```ts
type PlatformAccountQueryDto = {
  resource: string;
  status: "ok";
  payload: unknown;
};
```

## Future platform HTTP endpoints

The fake service advertises the endpoints expected from the real shared
platform account service:

- `GET /v1/account/session`
- `GET /v1/account/profile`
- `GET /v1/account/entitlements`
- `GET /v1/account/usage`

When the real platform server exists, replace the local fake service behind the
same Tauri commands first. The UI should not need to change unless the visual
account presentation changes.
