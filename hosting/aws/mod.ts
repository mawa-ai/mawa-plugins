import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { createRequestHandler } from 'mawa/hosting'
import { mawa } from '../../deps.ts'

/**
 * Builds an AWS Lambda handler for a bot directory, for use behind an HTTP API (payload v2).
 *
 * @param directory The bot directory, containing `mawa.config.ts` and a `flow/` folder.
 * @param requestTransformer Hook to rewrite the request before it is routed to a channel, for
 * instance to strip a stage prefix off the channel path.
 */
export const getHandler = (
    directory: string,
    requestTransformer: (request: Request) => Request = (request) => request,
): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2> => {
    const handle = createRequestHandler({ directory })

    return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
        mawa.logger.debug('Received event', event)

        const request = new Request(
            `https://${event.requestContext.domainName}${event.rawPath}?${event.rawQueryString}`,
            {
                method: event.requestContext.http.method,
                headers: new Headers({ ...event.headers } as HeadersInit),
                body: event.body,
            },
        )

        const response = await handle(requestTransformer(request))

        return {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: response.body ? await response.text() : undefined,
        }
    }
}
