import { mawa } from '../../deps.ts'
import { mawaChannel, mawaConfig, mawaState } from '../deps.ts'

export const createFetchListener = async (directory: string) => {
    await mawaConfig.initializeConfiguration(directory, false)
    const logLevel = mawa.config().logLevel
    if (logLevel) {
        mawa.setupLogger(logLevel)
    }

    return (request: Request): Promise<Response> => {
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
