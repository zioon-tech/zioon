# Zion Mobile Client

Independent mobile web/PWA client for Zion Runtime.

## Boundary

- no Desktop Workbench imports;
- no CodeMirror, PanelManager, Activity Bar, or browser Agent loop;
- all durable state comes from Runtime or a Resource Host behind Runtime;
- browser storage is limited to drafts, the generated device id, and UI
  preferences.

## Development

Start a Runtime, then run:

```bash
ZION_MOBILE_RUNTIME_URL=http://127.0.0.1:8766 npm run dev:mobile
```

Open `http://127.0.0.1:5180/mobile/`.

## Build

```bash
npm run build:mobile
```

The default output is `dist/mobile`. A deployment can override it:

```bash
npm run build:mobile -- --outDir /var/lib/zion-next/workbench-dist/mobile
```

Runtime serves this directory as the `/mobile/` SPA while `/` continues to
serve Desktop Workbench.

## Verification

```bash
npx tsc -p apps/mobile-client/tsconfig.json --noEmit
npm run test:mobile
npm run build:mobile
```
