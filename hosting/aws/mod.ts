import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'https://deno.land/x/lambda@1.29.1/mod.ts'
import { mawaChannel, mawaConfig, mawaState } from '../deps.ts'
import { mawa } from '../../deps.ts'

export const getHandler = async (
    directory: string,
    requestTransformer: (request: Request) => Request = (request) => request,
) => {
    await mawaConfig.initializeConfiguration(directory, false)

    return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
        mawa.logger.info('Received event', event)

        try {
            const request = new Request(
                `https://${event.requestContext.domainName}${event.rawPath}?${event.rawQueryString}`,
                {
                    method: event.requestContext.http.method,
                    headers: new Headers({ ...event.headers } as HeadersInit),
                    body: event.body,
                },
            )
            const response = await mawaChannel.resolveChannel(
                requestTransformer(request),
                async (sourceAuthorId, message, channel) => {
                    mawa.logger.info('Received message from ' + sourceAuthorId + ' via ' + channel.sourceId, {
                        sourceAuthorId: sourceAuthorId,
                        message,
                        channel: channel.sourceId,
                    })

                    await mawaState.handleMessage(sourceAuthorId, message, channel, directory)
                },
            )
            return {
                statusCode: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                body: response.body ? await response.text() : undefined,
            }
        } catch (err) {
            mawa.logger.error(err)
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Error receiving message: ' + err.message }),
            }
        }
    }
}
