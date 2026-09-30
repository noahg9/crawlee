import type { Request as CrawleeRequest } from '@crawlee/core';
import type { BaseHttpClient } from '@crawlee/http-client';
import type { HttpRequestOptions, ISession, SendRequestOptions } from '@crawlee/types';

import { storage } from '@apify/timeout';

/**
 * Prepares a function to be used as the `sendRequest` context helper.
 *
 * @internal
 * @param httpClient The HTTP client that will perform the requests.
 * @param originRequest The crawling request being processed.
 * @param session The user session associated with the current request.
 */
export function createSendRequest(httpClient: BaseHttpClient, originRequest: CrawleeRequest, session: ISession) {
    return async (
        overrideRequest: Partial<HttpRequestOptions> = {},
        overrideOptions: SendRequestOptions = {},
    ): Promise<Response> => {
        const baseRequest = originRequest.intoFetchAPIRequest();
        const mergedUrl = overrideRequest.url ?? baseRequest.url;
        const mergedMethod = overrideRequest.method ?? baseRequest.method;

        const mergedHeaders = new Headers(baseRequest.headers);
        if (overrideRequest.headers) {
            overrideRequest.headers.forEach((value, key) => {
                mergedHeaders.set(key, value);
            });
        }

        const request = new Request(mergedUrl, {
            method: mergedMethod,
            headers: mergedHeaders,
            body: overrideRequest.body ?? baseRequest.body,
        } as RequestInit);

        // Aborted when the enclosing timeout (e.g. the request handler's) fires
        const cancelSignal = storage.getStore()?.cancelTask.signal;
        const { signal } = overrideOptions;

        return httpClient.sendRequest(request, {
            session,
            cookieJar: overrideOptions?.cookieJar ?? session.cookieJar,
            timeoutMillis: overrideOptions.timeoutMillis,
            signal: signal && cancelSignal ? AbortSignal.any([signal, cancelSignal]) : (signal ?? cancelSignal),
            ignoreTlsErrors: overrideOptions.ignoreTlsErrors,
        });
    };
}
