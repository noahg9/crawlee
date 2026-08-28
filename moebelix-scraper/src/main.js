import { Actor, log } from 'apify';
import { CheerioCrawler, sleep } from 'crawlee';

const BASE_URL = 'https://www.moebelix.cz';
const PRODUCTS_PER_PAGE = 60;

/**
 * Normalizes user input into an absolute moebelix.cz category URL.
 * Accepts a full URL, an absolute path ("/zahradni-nabytek-C16"),
 * or a bare category slug ("zahradni-nabytek-C16").
 */
function normalizeCategoryUrl(categoryUrl) {
    const trimmed = categoryUrl.trim();
    const url = /^https?:\/\//i.test(trimmed) ? new URL(trimmed) : new URL(trimmed.replace(/^\/?/, '/'), BASE_URL);

    if (!/(^|\.)moebelix\.cz$/i.test(url.hostname)) {
        throw new Error(`The categoryUrl must point to moebelix.cz, got: ${categoryUrl}`);
    }

    // Drop any existing paging/query so we always start from page 1.
    url.search = '';
    url.hash = '';
    return url.href;
}

function buildPageUrl(categoryUrl, page) {
    if (page <= 1) return categoryUrl;
    const url = new URL(categoryUrl);
    url.searchParams.set('page', String(page));
    return url.href;
}

/** Parses Czech price strings like "4 900,‒ Kč", "místo 6 999,‒ Kč" or "1 234,50 Kč" into a number. */
function parsePrice(text) {
    if (!text) return null;
    const normalized = text.replace(/[  \s]/g, '');
    const match = normalized.match(/(\d+)(?:,(\d{1,2}))?/);
    if (!match) return null;
    const integer = Number(match[1]);
    const decimals = match[2] ? Number(`0.${match[2]}`) : 0;
    return integer + decimals;
}

/**
 * Detects the Cloudflare "Just a moment..." / "JavaScript is required" interstitials
 * that the site intermittently serves. Note that legitimate pages also reference the
 * Cloudflare challenge script, so only page titles/headings are reliable markers.
 */
function isBlockedPage($) {
    if ($('[data-testid="productTile"]').length > 0) return false;
    const title = $('title').first().text().trim();
    return title.startsWith('Just a moment') || /JavaScript is required/i.test($('h1').first().text());
}

function extractProducts($, request) {
    const products = [];

    $('[data-testid="productTile"]').each((_, tile) => {
        const $tile = $(tile);
        const $link = $tile.find('a[data-purpose="productTile.link.product"]').first();
        const href = $link.attr('href');
        if (!href) return;

        const $img = $tile.find('[data-testid="productCard.preview"] img').first();
        // srcSet entries look like "https://media.moebelix.com/i/moebelix/<id>/?fmt=auto&w=210 210w, ..."
        const srcSet = $img.attr('srcset') ?? $img.attr('srcSet') ?? '';
        const imageUrl = srcSet.split(',')[0]?.trim().split(' ')[0]?.split('/?')[0] || $img.attr('src') || null;

        const currentPriceText = $tile.find('[data-purpose="product.price.current"]').first().text().trim();
        const oldPriceText = $tile.find('[data-purpose="product.price.old"]').first().text().trim();

        products.push({
            productId: $link.attr('data-product-id') ?? null,
            name: $link.text().trim() || null,
            url: new URL(href, BASE_URL).href,
            subtitle: $tile.find('[data-testid="productCard.subtitle"]').first().text().trim() || null,
            price: parsePrice(currentPriceText),
            oldPrice: parsePrice(oldPriceText),
            currency: 'CZK',
            imageUrl,
            category: request.userData.categoryName ?? null,
            categoryUrl: request.userData.categoryUrl,
            page: request.userData.page,
        });
    });

    return products;
}

/** Reads the total product count of the category, e.g. from a "539 produktů" element. */
function extractTotalProductCount($) {
    let total = null;
    $('div, span').each((_, el) => {
        const text = $(el).text().trim();
        const match = text.match(/^([\d\s  ]+)\s*produkt(?:ů|y)?$/i);
        if (match) {
            const count = Number(match[1].replace(/\D/g, ''));
            if (Number.isFinite(count) && count > 0) total = count;
        }
    });
    return total;
}

await Actor.init();

const {
    categoryUrl = 'https://www.moebelix.cz/zahradni-nabytek-C16',
    maxItems = 0,
    proxyConfiguration: proxyConfigurationInput = { useApifyProxy: true },
} = (await Actor.getInput()) ?? {};

const startUrl = normalizeCategoryUrl(categoryUrl);
log.info(`Scraping furniture category: ${startUrl}`, { maxItems: maxItems || 'unlimited' });

// Uses the Apify proxy with the password taken from the APIFY_PROXY_PASSWORD
// environment variable (injected automatically on the Apify platform).
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigurationInput);

// Persisted state so maxItems and deduplication survive actor migrations/restarts.
const state = await Actor.useState('SCRAPER_STATE', { pushedCount: 0, seenProductIds: {} });

const crawler = new CheerioCrawler({
    proxyConfiguration,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxConcurrency: 5,
    maxRequestRetries: 8,
    requestHandlerTimeoutSecs: 90,
    sessionPoolOptions: {
        sessionOptions: { maxUsageCount: 20 },
    },
    preNavigationHooks: [
        (_crawlingContext, gotOptions) => {
            // Firefox desktop TLS/header fingerprints pass the site's Cloudflare
            // protection reliably; some Chrome fingerprints get 403s.
            gotOptions.headerGeneratorOptions = {
                browsers: ['firefox'],
                devices: ['desktop'],
                operatingSystems: ['windows', 'macos', 'linux'],
                locales: ['cs-CZ', 'en-US'],
            };
        },
    ],
    async requestHandler({ request, $, session, crawler: crawlerRef, log: requestLog }) {
        if (isBlockedPage($)) {
            session?.retire();
            throw new Error('Got a JS challenge / blocked page, retrying with a new session...');
        }

        const { page } = request.userData;

        if (page === 1) {
            request.userData.categoryName = $('h1').first().text().trim() || null;

            const totalCount = extractTotalProductCount($);
            const tilesOnPage = $('[data-testid="productTile"]').length;

            if (tilesOnPage === 0) {
                const subcategories = $('[data-testid="categoryCard"] a')
                    .map((_, el) => $(el).attr('href'))
                    .get()
                    .slice(0, 20);
                // A page that rendered fine but has no listing won't grow one on retry.
                request.noRetry = true;
                throw new Error(
                    `No products found on ${request.url}. It may be a category overview page without a product listing`
                    + (subcategories.length ? ` — try one of its subcategories: ${subcategories.join(', ')}` : '.'),
                );
            }

            requestLog.info(`Category "${request.userData.categoryName}" has ${totalCount ?? 'unknown'} products.`);

            if (totalCount && totalCount > tilesOnPage) {
                const wantedItems = maxItems > 0 ? Math.min(maxItems, totalCount) : totalCount;
                const totalPages = Math.ceil(wantedItems / PRODUCTS_PER_PAGE);
                const pageRequests = [];
                for (let nextPage = 2; nextPage <= totalPages; nextPage++) {
                    pageRequests.push({
                        url: buildPageUrl(request.userData.categoryUrl, nextPage),
                        userData: { ...request.userData, page: nextPage },
                    });
                }
                if (pageRequests.length > 0) {
                    requestLog.info(`Enqueueing ${pageRequests.length} more listing pages.`);
                    await crawlerRef.addRequests(pageRequests);
                }
            }
        }

        const products = extractProducts($, request);
        if (products.length === 0) {
            session?.retire();
            throw new Error(`No product tiles found on listing page ${request.url}, retrying...`);
        }

        const newProducts = products.filter((product) => {
            const key = product.productId ?? product.url;
            if (state.seenProductIds[key]) return false;
            state.seenProductIds[key] = true;
            return true;
        });

        let toPush = newProducts;
        if (maxItems > 0) {
            const remaining = maxItems - state.pushedCount;
            if (remaining <= 0) return;
            toPush = newProducts.slice(0, remaining);
        }

        if (toPush.length > 0) {
            state.pushedCount += toPush.length;
            await Actor.pushData(toPush);
            requestLog.info(`Page ${page}: stored ${toPush.length} products (total: ${state.pushedCount}).`);
        }
    },
    async errorHandler({ request }, error) {
        // Cloudflare blocks in short bursts per IP, so instant retries would
        // just get blocked again — back off first. With the Apify proxy the
        // retired session also gets a fresh IP on retry.
        if (/blocked|403|429|challenge/i.test(error.message)) {
            await sleep(Math.min(5000 * request.retryCount, 30000));
        }
    },
    failedRequestHandler({ request, log: requestLog }) {
        requestLog.error(`Request ${request.url} failed too many times.`);
    },
});

await crawler.run([{ url: startUrl, userData: { page: 1, categoryUrl: startUrl } }]);

log.info(`Done. Stored ${state.pushedCount} products in the dataset.`);

await Actor.exit();
