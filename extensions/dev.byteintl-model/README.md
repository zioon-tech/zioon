# ByteIntl Model Runtime Plugin

`dev.byteintl-model` exposes ByteIntl ModelHub as a loopback
OpenAI-compatible endpoint for Zion Runtime.

The plugin keeps the upstream AK out of Model Profile URLs. Zion Runtime injects
the profile's write-only API Key as a loopback Bearer credential; the adapter
converts that credential into the upstream `ak` query parameter and converts
Zion's streaming request into the non-streaming ModelHub request shape.

## Package and install

Build the ZIP from the Zion repository:

```bash
npm run plugin:package:byteintl-model
```

Install it into a Runtime external plugin root:

```bash
node scripts/install-runtime-plugin.mjs \
  --archive /path/to/dev.byteintl-model-0.1.0.zip \
  --plugin-root /var/lib/zion-next/plugins \
  --plugin-id dev.byteintl-model
```

## Runtime configuration

Configure the adapter in the Runtime environment:

```bash
ZION_BYTEINTL_MODEL=gpt-6-astra
ZION_BYTEINTL_ADAPTER_HOST=127.0.0.1
ZION_BYTEINTL_ADAPTER_PORT=8771
ZION_BYTEINTL_TIMEOUT_MS=180000
ZION_BYTEINTL_DEFAULT_MAX_TOKENS=500
```

Optional:

```bash
ZION_BYTEINTL_UPSTREAM_URL=https://aidp.byteintl.net/api/modelhub/online/v2/crawl
ZION_BYTEINTL_MAX_REQUEST_BYTES=1048576
ZION_BYTEINTL_MAX_RESPONSE_BYTES=8388608
```

`ZION_BYTEINTL_UPSTREAM_URL` must use HTTPS and must not contain `ak` or other
credentials. The adapter listener is restricted to loopback.

## Install the model profile

Install the profile before starting or restarting Runtime:

```bash
node /var/lib/zion-next/plugins/dev.byteintl-model/install-profile.mjs \
  --profile-path /var/lib/zion-next/model-profiles.json
```

The generated profile points to:

```text
http://127.0.0.1:8771/v1/chat/completions
```

It contains no upstream credential. After Runtime restarts, open the model from
the Workbench model selector and enter the rotated AK in its `API Key` field.
Runtime stores it as a write-only credential and sends it only to the loopback
adapter.

## Enable the plugin

For an external package installation, include the plugin in both Runtime lists:

```text
--external-runtime-plugins dev.identity,dev.byteintl-model
--runtime-plugins ...,dev.byteintl-model
```

The adapter health endpoint is available only on the Runtime host:

```bash
curl -fsS http://127.0.0.1:8771/health
```

## Network boundary

`aidp.byteintl.net` currently resolves to a private `10.0.0.0/8` address. The
machine running Zion Runtime must have a route to that network. Installing this
plugin on an Aliyun ECS host without corporate network egress does not make the
upstream reachable; in that deployment the adapter must run on an authorized
network node or use an approved private-network connection.

## Security

- Never put the AK in the model profile endpoint.
- Never commit the AK to this plugin package.
- Rotate any AK pasted into chat, shell history, or logs.
- The plugin converts the inbound loopback Bearer credential into `ak` and does
  not forward the authorization header upstream.
- Redirects are disabled so query credentials cannot cross origins.
