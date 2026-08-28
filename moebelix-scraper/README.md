# Möbelix Furniture Category Scraper

Apify actor that scrapes all furniture items from a chosen category on [moebelix.cz](https://www.moebelix.cz/).

## Input

| Field | Type | Description |
| --- | --- | --- |
| `categoryUrl` | string | URL of the category listing to scrape, e.g. `https://www.moebelix.cz/sedaci-soupravy-C1C1`. A path (`/sedaci-soupravy-C1C1`) or bare slug (`sedaci-soupravy-C1C1`) works too. |
| `maxItems` | integer | Maximum number of products to store. `0` (default) scrapes the whole category. |
| `proxyConfiguration` | object | Standard Apify proxy configuration. Defaults to `{ "useApifyProxy": true }`. |

Use category **listing** pages — their URLs end with `-C<number>` (e.g. `zahradni-nabytek-C16`, `postele-C2C2`). These list all products of the category including subcategories. If you pass a category *overview* page (like `/c/nabytek`) that has no product listing, the run fails with a message listing its subcategory URLs to use instead.

## Output

One dataset item per product:

```json
{
    "productId": "002099000207",
    "name": "Dvoumístná pohovka MONIQUE, béžová žinylka",
    "url": "https://www.moebelix.cz/p/bessagi-home-dvoumistna-pohovka-monique-bezova-zinylka-002099000207",
    "subtitle": "Bessagi Home",
    "price": 4844,
    "oldPrice": 5699,
    "currency": "CZK",
    "imageUrl": "https://media.moebelix.com/i/moebelix/PI...",
    "category": "Sedací soupravy",
    "categoryUrl": "https://www.moebelix.cz/sedaci-soupravy-C1C1",
    "page": 1
}
```

`oldPrice` and `subtitle` are `null` when the product is not discounted / has no brand line.

## Proxy

The actor uses the Apify proxy through `Actor.createProxyConfiguration()`. The proxy password is read from the `APIFY_PROXY_PASSWORD` environment variable — it is **never hardcoded**. On the Apify platform the variable is injected automatically; for a local run, export it yourself:

```bash
export APIFY_PROXY_PASSWORD=...   # from https://console.apify.com/proxy
```

## Anti-blocking

moebelix.cz sits behind Cloudflare, which intermittently serves "Just a moment…" / "JavaScript is required" interstitials and blocks some TLS fingerprints:

- Requests use Firefox desktop browser fingerprints (via `got-scraping` header generation) — these pass the challenge reliably, while some Chrome fingerprints receive 403s.
- Challenge pages are detected in the response and the request is retried with a fresh session (and a fresh proxy IP when the Apify proxy is enabled) after a backoff, because Cloudflare blocks in short bursts per IP.
- If runs still get blocked, switch the proxy to the `RESIDENTIAL` group in the input.

## Local development

```bash
cd moebelix-scraper
npm install
# input lives in storage/key_value_stores/default/INPUT.json
npm start
```

Results are written to `storage/datasets/default/`.

## Deployment

```bash
cd moebelix-scraper
apify login
apify push
```
