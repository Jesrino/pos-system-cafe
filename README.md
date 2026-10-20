# Juniper & Co. POS

A tablet-first React point-of-sale demo built with Vite and Tailwind CSS. Menu prices, tender amounts, reports, and receipts use Philippine pesos (PHP). The app includes product search and categories, configurable items, cart and tax calculations, cash/card/split checkout flows, a shift report, barcode-wedge input, a printable 80 mm receipt preview, locally persisted catalog and inventory in IndexedDB, and a simulated offline sync queue.

## Run locally

```sh
npm install
npm run dev
```

Create a production build with `npm run build`, then serve the `dist` directory over HTTPS (or localhost) to test PWA installation and service-worker caching.

## POS behavior

- Use the Online/Offline control in the header to simulate a connectivity change. Orders completed offline are stored in local storage and are cleared from the pending queue after the simulated `/api/sync` request completes when connectivity is restored.
- Barcode scanners that emulate a keyboard can scan the sample product codes `1010001` through `1010012`, followed by Enter. Scanner input is ignored while typing in a field.
- Select **Edit catalog** and enter the demo manager PIN `2468` to add products or update product prices and inventory. Use **Scan barcode** in the product form to capture a scanner-wedge SKU. Catalog records and their sync mutations are stored in IndexedDB.
- Cash change, split tender totals, and the card-terminal progression are simulated in the browser. The ESC/POS helper generates receipt bytes; the receipt action opens the browser print flow, which can be configured to print to an 80 mm thermal printer.
- Product catalog, tax rate, and store details are sample data. Replace the simulated sync step and catalog with the production API and database before deployment.

The PWA service worker is registered for production builds. It caches the application shell and same-origin static resources for repeat/offline visits.
