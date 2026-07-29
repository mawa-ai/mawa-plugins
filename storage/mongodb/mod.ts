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

/**
 * Storage backed by MongoDB.
 *
 * Uses the `users`, `variables` and `events` collections. Call {@link close} on shutdown,
 * otherwise the open connection keeps the process alive.
 */
export class MongoDbStorage implements mawa.Storage {
    /** One memoized connection attempt, shared by every concurrent caller. */
    private connecting: Promise<MongoClient> | undefined

    /**
     * @param url MongoDB connection string.
     * @param databaseName Database to use. Defaults to the one embedded in the connection string.
     */
    constructor(private readonly url: string, private readonly databaseName?: string) {}

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
