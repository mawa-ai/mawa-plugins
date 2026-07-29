import { mawa } from '../deps.ts'

/** The name a channel's own contact record carries, and where to keep track of it. */
export type ChannelProfile = {
    /** Name as the channel knows it, if it knows one. */
    name?: string
    /**
     * Metadata key under which the last name seen from this channel is kept.
     *
     * How the channel tells "this is still my name" from "someone else set this".
     */
    key: string
}

/**
 * Records what a channel knows about a contact, without overwriting a name someone else set.
 *
 * A channel learns a name from its own contact record — a WhatsApp profile, a Chatwoot
 * contact — and that name changes whenever the user edits it. Writing it on every message
 * would undo the most ordinary thing a flow does: ask what to call someone and store the
 * answer. One message later the channel would put the profile name back.
 *
 * So the name is claimed on first sight and kept in step with the profile only for as long as
 * nothing else has touched it. Once a flow, a hook or an agent sets it, it is theirs, and the
 * channel keeps its own version in metadata instead — where a bot that wants the current
 * profile name can still read it.
 *
 * @param userId The user the contact belongs to.
 * @param profile Name from the channel's contact record.
 * @param details Everything else the channel learned, which it does own.
 */
export const mergeContact = async (
    userId: mawa.UserId,
    profile: ChannelProfile,
    details: Partial<Omit<mawa.User, 'id' | 'name'>> = {},
): Promise<void> => {
    const storage = mawa.config().storage

    if (!profile.name) {
        // Nothing to say about the name. Passing `undefined` would erase the stored one.
        await storage.mergeUser(userId, details)
        return
    }

    const user = await storage.getUser(userId)
    const ours = !user?.name || user.name === user.metadata?.[profile.key]

    await storage.mergeUser(userId, {
        ...details,
        ...(ours ? { name: profile.name } : {}),
        metadata: { ...details.metadata, [profile.key]: profile.name },
    })
}
