import { Collection, Database, MongoClient, ObjectId, Document } from 'https://deno.land/x/mongo@v0.31.1/mod.ts'
import { mawa } from '../../deps.ts'

type EventTrackingSchema = {
    _id: ObjectId
    userId: mawa.UserId
    event: string
    properties?: Record<string, unknown>
    createdAt: Date
}

type UserSchema = mawa.User & {
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

export default class MongoDbStorage implements mawa.Storage {
    private database: Database | undefined

    constructor(private readonly url: string) {}

    public async track(
        userId: mawa.UserId,
        event: string,
        properties?: Record<string, unknown> | undefined,
    ): Promise<void> {
        const collection = await this.getCollection<EventTrackingSchema>('events')
        await collection.insertOne({
            userId,
            event,
            properties,
            createdAt: new Date(),
        })
    }

    public async mergeUser(userId: mawa.UserId, properties: Partial<Omit<mawa.User, 'id'>>): Promise<mawa.User> {
        const collection = await this.getCollection<UserSchema>('users')
        const entity = (await collection.findAndModify(
            { id: userId },
            {
                update: {
                    $set: {
                        ...properties,
                        metadata: {
                            $mergeObjects: ['$metadata', properties.metadata],
                        },
                        updatedAt: new Date(),
                    } as Document,
                    $setOnInsert: {
                        createdAt: new Date(),
                    } as Document,
                },
                new: true,
                upsert: true,
            },
        )) as UserSchema

        const user: Partial<mawa.User> & { _id?: ObjectId } = { ...entity }
        delete user._id

        return mawa.User.build(user)
    }

    public async getUser(id: mawa.UserId): Promise<mawa.User | undefined> {
        const collection = await this.getCollection<UserSchema>('users')
        const entity = await collection.findOne({ id })

        const user: (Partial<mawa.User> & { _id?: ObjectId }) | undefined = entity && { ...entity }
        if (user) {
            delete user._id
        }

        return user && mawa.User.build(user)
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
        const entity = await collection.findOne({
            userId,
            key,
        })
        const value = entity && (entity.value as T)
        return value === null ? undefined : value
    }

    private async getCollection<T>(name: string): Promise<Collection<T>> {
        if (!this.database) {
            const client = new MongoClient()
            this.database = await client.connect(this.url)
        }
        return this.database.collection<T>(name)
    }
}
