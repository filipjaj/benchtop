# Sourcing stores

Read this when sourcing parts. `scripts/source.ts` gathers candidates from the API stores below;
you choose listings and write them to `project.sourcing`. Checked 2026-11-13. Prices are single
units, ex-shipping, in the store's own currency (not converted). Always state the currency.

Run: `bun scripts/source.ts <projectDir> [--stores jlc,adafruit,pimoroni] [--limit 3] [--json] [--fresh]`
or `--query "<text>"`. Results are cached 24 h; `--fresh` bypasses the cache. A "store unavailable"
line means that store failed this run, not that it has no stock.

## jlc (JLCPCB / LCSC parts mirror)

- Endpoint: `https://jlcsearch.tscircuit.com/api/search?q=<text>&limit=N`. A community mirror, not JLCPCB itself.
- Good for: bare chips and passives for `pcb-assembled` builds; `is_basic` (basic parts have no
  per-part assembly fee, extended parts do). Searching `C<number>` returns exactly that part, which
  is how `footprint.lcsc` is looked up.
- Limits:
  - Free-text search is incomplete: "BME280" and "bmp280" returned nothing on 2026-11-13 while the
    LCSC number `C92489` found the BME280. Prefer setting `footprint.lcsc` on parts you want here.
  - `stock` is often `null` (shown as `?`); treat it as unknown and check the LCSC page.
  - The mirror gives no currency. Prices are taken as USD (unconfirmed).
  - Module breakouts (BME280 board etc.) are not here, only components.
- Links go to `https://www.lcsc.com/product-detail/C<number>.html` (opens). The
  `jlcpcb.com/partdetails/C<number>` URL answered 404 to a plain request, so it is not used.

## adafruit

- Endpoint: `https://www.adafruit.com/api/products` (whole catalogue, about 5,600 items, 8 MB), searched
  locally. Cached trimmed for 24 h, so only the first run pays for the download.
- Good for: breakouts, Feathers, STEMMA QT parts, displays. Reliable stock.
- Limits: USD, no shipping or VAT info. Stock is "in stock" or a count; `9999` and similar are
  not real counts. Discontinued items are reported as not in stock. Title search only; there is
  no relevance score from the store, so the ranking in `source.ts` is all you get.
  Adafruit ships to Norway but import VAT and carrier fees apply (unconfirmed for current terms).

## pimoroni

- Endpoint: `https://shop.pimoroni.com/search/suggest.json?q=<text>&resources[type]=product`
  (Shopify predictive search, 10 results per query).
- Good for: UK-sourced breakouts, Pico and Raspberry Pi accessories, and Adafruit/Pimoroni resales.
- Limits: GBP (confirmed via the store's cart currency). Only an in-stock flag, no counts. At most
  10 hits, so a vague query misses things; use a model number. UK to Norway is a customs
  border: expect VAT and carrier fees on top (unconfirmed for current thresholds).

# Stores without an API

Search these on the web (WebSearch, or open the pattern below) when the API stores miss a part or
a Nordic source is wanted. Opened on 2026-11-13; "ships to Norway" means the site offers Norway
as a delivery country or has a Norwegian storefront. Confirm shipping and total at checkout.

- AliExpress: cheapest for generic modules (ESP32 boards, OLEDs, sensors), 2 to 4 weeks, quality
  varies and dimensions drift between sellers. Search: `https://www.aliexpress.com/wholesale?SearchText=<text>`
  (not opened, bot-protected). Match the board revision in photos before ordering.
- Elkim (elkim.no): Norwegian shop, NOK, hobby modules, sensors, components. Confirmed.
  Search: `https://elkim.no/?s=<text>&post_type=product`
  An eval run on 2026-11-13 reported a 59 NOK fee on small orders and shipping from
  69 NOK (free above 890 NOK); confirm both at checkout.
- fibel.no: Norwegian shop, NOK, modules and single components, often the cheapest
  Norwegian price for a controller board. Search answers a plain request:
  `https://www.fibel.no/?s=<text>&post_type=product`. Shipping terms not checked.
- RoboNordic (robonordic.no): Norwegian shop, NOK, sensors and controller boards.
  Search answers a plain request: `https://robonordic.no/?s=<text>&post_type=product`.
  An eval run reported letter shipping at 39 NOK and that prices may be shown without
  VAT; confirm at checkout.
- Kjell & Company (kjell.com/no): Norwegian chain, NOK, Arduino and ESP boards, cables, tools,
  batteries. Confirmed. Search: `https://www.kjell.com/no/sok?q=<text>&search=true` (results load client side).
- Electrokit (electrokit.com): Swedish hobby electronics, kits, modules, components. Norway is
  listed as a delivery country with its own currency selector. Confirmed for shipping. Search:
  `https://www.electrokit.com/search.php?keyword=<text>` (checked 2026-11-14, results in static HTML).
- Reichelt (reichelt.com): German, broad components and modules, has a Norwegian storefront
  `/no/de/`. Confirmed. Search: `https://www.reichelt.com/no/de/shop/suche?search=<text>`

Not confirmed, do not list to the user as verified:
- Digitalimpuls: homepage opened but showed no hobby electronics content; not confirmed.
- Berrybase (berrybase.de): site opens and searches (`/search?search=<text>`), but no Norway
  shipping information was found in the pages fetched. Unconfirmed.
- Kiwi Electronics (kiwi-electronics.com): site opens and searches (`/en/search?search=<text>`),
  Norway shipping not found in the pages fetched. Unconfirmed.
- TME (tme.eu): refused automated requests (HTTP 403); not opened. Unconfirmed.

# Search patterns re-checked 2026-11-14

Each pattern in `assets/stores.json` was opened for two terms (BME280, INMP441) and the results
had to differ and be relevant. Corrections found: Kjell uses `/no/sok?q=<text>&search=true`
(`?query=` always answered "no hits"); Electrokit uses `/search.php?keyword=<text>` (the field is
`keyword`, not `search`); Berrybase uses `/search?search=<text>` (`sSearch=` ignored the term and
listed all 16680 products). fibel.no and LCSC render results client side: a plain HTTP request
sees a default listing or empty shell, a browser sees the matches. Elkim, RoboNordic, Electrokit,
fibel.no and Kjell match every word against Norwegian or Swedish titles, so "INMP441 I2S microphone"
finds nothing while "INMP441" does; those stores carry `"query": "model"` and the shopping page
searches them by model number only. Reichelt, DigiKey, Amazon and eBay refuse automated requests
and were not re-checked. A store marked `"checked": "broken"` is not offered.

# Currencies

`project.sourcing.currency` is the default; a line or a shipping entry can set its own `currency`
(a SEK shop, a USD shop). Never convert: totals are shown per currency ("515 NOK + 12.50 USD").
Never invent an exchange rate in a note either.

# PCB fabrication notes

- JLCPCB: registered in Norway's VOEC scheme; it collects 25 percent VAT at checkout on consumer
  orders up to NOK 3000, which avoids carrier clearance fees. (Stated in the task brief; not
  re-verified against the Norwegian Tax Administration or JLCPCB. Unconfirmed.) Check the VAT line
  at checkout before relying on it, and note orders over NOK 3000 fall outside VOEC.
- Aisler and PCBWay: orders are cleared by the carrier, so expect carrier VAT and a handling fee
  on delivery. (Stated in the task brief; unconfirmed.)
- Assembly (`pcb-assembled`): use the `jlc` adapter, set `footprint.lcsc` on each part, and prefer
  basic parts to avoid per-part fees. Check stock on lcsc.com before finalising.
