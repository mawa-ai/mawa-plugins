import { config } from 'https://deno.land/x/mawa@0.0.22/mod.ts'
import { mawa } from '../../deps.ts'
import { mawaChannel, mawaConfig, mawaState } from '../deps.ts'

export const createFetchListener = (directory: string) => {
    return async (request: Request): Promise<Response> => {
        if (!config()) {
            await mawaConfig.initializeConfiguration(directory, false)
        }

        try {
            return mawaChannel.resolveChannel(request, async (sourceAuthorId, message, channel) => {
                mawa.logger.info('Received message from ' + sourceAuthorId + ' via ' + channel.sourceId, {
                    sourceAuthorId: sourceAuthorId,
                    message,
                    channel: channel.sourceId,
                })

                await mawaState.handleMessage(sourceAuthorId, message, channel, directory)
            })
        } catch (err) {
            mawa.logger.error(err)
            return Promise.resolve(
                Response.json(
                    {
                        error: 'Error receiving message: ' + err.message,
                    },
                    { status: 500 },
                ),
            )
        }
    }
}
