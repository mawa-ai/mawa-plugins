import { type Collection, type Db, type Document, MongoClient, type ObjectId } from 'mongodb'
import { mawa } from '../../deps.ts'

type EventTrackingSchema = {
    _id: ObjectId
    userId: mawa.UserId
    event: string
    properties?: Record<string, unknown>
    createdAt: Date
}

/** Derived from `User` so a new field is persisted without touching this file. */
type UserSchema = Omit<mawa.User, 'getSourceId'> & {
    _id: ObjectId
    createdAt: Date
    updatedAt: Date
}

type VariableSchema = {
    _id: ObjectId
    userId: mawa.UserId
    key: string
    value: unknown
    createdAt: Date
}

type LockSchema = {
    /**
     * The user the lock is for.
     *
     * `_id` rather than a field of its own, because Mongo already guarantees one document per
     * `_id` — which is exactly what makes this a lock, and what a separate field would need an
     * extra unique index to get.
     */
    _id: mawa.UserId
    /** Identifies the holder, so that only it can release the lock. */
    token: string
    /** When the lease runs out and another caller may take over. */
    expiresAt: Date
}

export type MongoDbStorageOptions = {
    /**
     * How long a holder keeps a user lock before another caller may take it over.
     *
     * Set this above the longest a flow can take. A flow that outlives its lease can have a
     * second one start beside it, which is what the lock exists to prevent — but a lease is
     * still needed, or an instance that dies mid-flow would lock that user out for good.
     *
     * Defaults to 30 seconds.
     */
    lockLeaseMs?: number
    /**
     * How long to wait for a held lock before running anyway.
     *
     * Giving up and continuing risks a race; waiting forever means never answering the user.
     * Defaults to 15 seconds.
     */
    lockTimeoutMs?: number
    /** How often to retry taking a held lock. Defaults to 50ms. */
    lockPollMs?: number
}

/**
 * Storage backed by MongoDB.
 *
 * Uses the `users`, `variables`, `events` and `locks` collections. Call {@link close} on
 * shutdown, otherwise the open connection keeps the process alive.
 */
export class MongoDbStorage implements mawa.Storage {
    /** One memoized connection attempt, shared by every concurrent caller. */
    private connecting: Promise<MongoClient> | undefined

    /**
     * @param url MongoDB connection string.
     * @param databaseName Database to use. Defaults to the one embedded in the connection string.
     * @param options Lock timings. The defaults suit a flow that answers within seconds.
     */
    constructor(
        private readonly url: string,
        private readonly databaseName?: string,
        private readonly options: MongoDbStorageOptions = {},
    ) {}

    public async track(
        userId: mawa.UserId,
        event: string,
        properties?: Record<string, unknown>,
    ): Promise<void> {
        const collection = await this.getCollection<EventTrackingSchema>('events')
        await collection.insertOne({
            userId,
            event,
            properties,
            createdAt: new Date(),
        } as EventTrackingSchema)
    }

    public async mergeUser(
        userId: mawa.UserId,
        properties: Partial<Omit<mawa.User, 'id'>>,
    ): Promise<mawa.User> {
        const collection = await this.getCollection<UserSchema>('users')

        const { metadata, ...rest } = properties

        // Written as an aggregation pipeline update so that $mergeObjects is actually
        // evaluated. Inside a plain $set, Mongo would treat it as a literal field name.
        const entity = await collection.findOneAndUpdate(
            { id: userId },
            [
                {
                    $set: {
                        ...rest,
                        id: userId,
                        metadata: {
                            $mergeObjects: [{ $ifNull: ['$metadata', {}] }, metadata ?? {}],
                        },
                        createdAt: { $ifNull: ['$createdAt', new Date()] },
                        updatedAt: new Date(),
                    },
                },
            ],
            { upsert: true, returnDocument: 'after' },
        )

        if (!entity) {
            throw new Error(`Failed to merge user ${userId}`)
        }

        return this.toUser(entity)
    }

    public async getUser(id: mawa.UserId): Promise<mawa.User | undefined> {
        const collection = await this.getCollection<UserSchema>('users')
        const entity = await collection.findOne({ id })

        return entity ? this.toUser(entity) : undefined
    }

    public async setKv<T>(userId: mawa.UserId, key: string, value: T): Promise<void> {
        const collection = await this.getCollection<VariableSchema>('variables')
        await collection.updateOne(
            { userId, key },
            {
                $set: {
                    value: typeof value === 'undefined' ? null : value,
                },
                $setOnInsert: {
                    createdAt: new Date(),
                },
            },
            { upsert: true },
        )
    }

    public async getKv<T>(userId: mawa.UserId, key: string): Promise<T | undefined> {
        const collection = await this.getCollection<VariableSchema>('variables')
        const entity = await collection.findOne({ userId, key })

        const value = entity?.value
        return value === null || value === undefined ? undefined : value as T
    }

    /**
     * Serializes work per user across every instance sharing this database.
     *
     * The SDK already queues a user's messages inside one process; this is what covers
     * several of them answering the same webhook, where neither can see the other's queue.
     *
     * The lock is leased rather than held: an instance that dies mid-flow would otherwise
     * lock that user out for good. If it cannot be taken within `lockTimeoutMs` the work runs
     * anyway, because a conversation that continues with a possible race is better than a
     * message that is never answered. See {@linkcode MongoDbStorageOptions}.
     */
    public async lock<T>(userId: mawa.UserId, work: () => Promise<T>): Promise<T> {
        const collection = await this.getCollection<LockSchema>('locks')
        const token = crypto.randomUUID()
        const deadline = Date.now() + (this.options.lockTimeoutMs ?? 15_000)

        let acquired = false
        for (;;) {
            acquired = await this.tryAcquireLock(collection, userId, token)
            if (acquired) {
                break
            }

            if (Date.now() >= deadline) {
                mawa.logger.warn(`Gave up waiting for the lock of ${userId}, continuing without it`)
                break
            }

            await new Promise((resolve) => setTimeout(resolve, this.options.lockPollMs ?? 50))
        }

        try {
            return await work()
        } finally {
            if (acquired) {
                // Scoped to the token: by now the lease may have expired and been taken over,
                // and releasing someone else's lock would let a third caller in as well.
                await collection.deleteOne({ _id: userId, token }).catch((err: unknown) =>
                    mawa.logger.warn(`Failed to release the lock of ${userId}`, mawa.toError(err))
                )
            }
        }
    }

    private async tryAcquireLock(
        collection: Collection<LockSchema>,
        userId: mawa.UserId,
        token: string,
    ): Promise<boolean> {
        const now = new Date()

        try {
            // Upsert filtered on "free or expired", so `_id` is what decides between two callers
            // racing: the loser gets a duplicate key error rather than both believing they hold
            // the lock.
            await collection.updateOne(
                { _id: userId, expiresAt: { $lte: now } },
                {
                    $set: {
                        token,
                        expiresAt: new Date(now.getTime() + (this.options.lockLeaseMs ?? 30_000)),
                    },
                },
                { upsert: true },
            )

            return true
        } catch (err) {
            if ((err as { code?: number }).code === 11000) {
                return false
            }

            throw err
        }
    }

    /** Closes the connection. Safe to call when never connected. */
    public async close(): Promise<void> {
        const connecting = this.connecting
        this.connecting = undefined

        await connecting?.then((client) => client.close()).catch(() => {})
    }

    private toUser(entity: UserSchema): mawa.User {
        const { _id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...user } = entity
        return mawa.User.build(user)
    }

    private async getCollection<T extends Document>(name: string): Promise<Collection<T>> {
        const database = await this.connect()
        return database.collection<T>(name)
    }

    private async connect(): Promise<Db> {
        // Memoized so concurrent first calls share one connection attempt instead of each
        // opening its own client. Cleared on failure, so the next call retries.
        this.connecting ??= new MongoClient(this.url).connect().catch((err) => {
            this.connecting = undefined
            throw err
        })

        return (await this.connecting).db(this.databaseName)
    }
}
