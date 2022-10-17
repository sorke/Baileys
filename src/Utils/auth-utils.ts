import { randomBytes } from 'crypto'
import NodeCache from 'node-cache'
import type { Logger } from 'pino'
import type { AuthenticationCreds, SignalDataSet, SignalDataTypeMap, SignalKeyStore, SignalKeyStoreWithTransaction, TransactionCapabilityOptions } from '../Types'
import { Curve, signedKeyPair } from './crypto'
import { delay, generateRegistrationId } from './generics'

/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param opts NodeCache options
 */
export function makeCacheableSignalKeyStore(
	store: SignalKeyStore,
	logger: Logger,
	opts?: NodeCache.Options
): SignalKeyStore {
	const cache = new NodeCache({
		...opts || { },
		useClones: false,
	})

	function getUniqueId(type: string, id: string) {
		return `${type}.${id}`
	}

	return {
		async get(type, ids) {
			const data: { [_: string]: SignalDataTypeMap[typeof type] } = { }
			const idsToFetch: string[] = []
			for(const id of ids) {
				const item = cache.get<SignalDataTypeMap[typeof type]>(getUniqueId(type, id))
				if(typeof item !== 'undefined') {
					data[id] = item
				} else {
					idsToFetch.push(id)
				}
			}

			if(idsToFetch.length) {
				logger.trace({ items: idsToFetch.length }, 'loading from store')
				const fetched = await store.get(type, idsToFetch)
				for(const id of idsToFetch) {
					const item = fetched[id]
					if(item) {
						data[id] = item
						cache.set(getUniqueId(type, id), item)
					}
				}
			}

			return data
		},
		async set(data) {
			let keys = 0
			for(const type in data) {
				for(const id in data[type]) {
					cache.set(getUniqueId(type, id), data[type][id])
					keys += 1
				}
			}

			logger.trace({ keys }, 'updated cache')

			await store.set(data)
		},
		async clear() {
			cache.flushAll()
			await store.clear?.()
		}
	}
}

/**
 * Adds DB like transaction capability (https://en.wikipedia.org/wiki/Database_transaction) to the SignalKeyStore,
 * this allows batch read & write operations & improves the performance of the lib
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
export const addTransactionCapability = (
	state: SignalKeyStore,
	logger: Logger,
	{ maxCommitRetries, delayBetweenTriesMs }: TransactionCapabilityOptions
): SignalKeyStoreWithTransaction => {
	let inTransaction = false
	// number of queries made to the DB during the transaction
	// only there for logging purposes
	let dbQueriesInTransaction = 0
	let transactionCache: SignalDataSet = { }
	let mutations: SignalDataSet = { }

	/**
	 * prefetches some data and stores in memory,
	 * useful if these data points will be used together often
	 * */
	const prefetch = async(type: keyof SignalDataTypeMap, ids: string[]) => {
		const dict = transactionCache[type]
		const idsRequiringFetch = dict ? ids.filter(item => !(item in dict)) : ids
		// only fetch if there are any items to fetch
		if(idsRequiringFetch.length) {
			dbQueriesInTransaction += 1
			const result = await state.get(type, idsRequiringFetch)

			transactionCache[type] = Object.assign(transactionCache[type] || { }, result)
		}
	}

	return {
		get: async(type, ids) => {
			if(inTransaction) {
				await prefetch(type, ids)
				return ids.reduce(
					(dict, id) => {
						const value = transactionCache[type]?.[id]
						if(value) {
							dict[id] = value
						}

						return dict
					}, { }
				)
			} else {
				return state.get(type, ids)
			}
		},
		set: data => {
			if(inTransaction) {
				logger.trace({ types: Object.keys(data) }, 'caching in transaction')
				for(const key in data) {
					transactionCache[key] = transactionCache[key] || { }
					Object.assign(transactionCache[key], data[key])

					mutations[key] = mutations[key] || { }
					Object.assign(mutations[key], data[key])
				}
			} else {
				return state.set(data)
			}
		},
		isInTransaction: () => inTransaction,
		transaction: async(work) => {
			// if we're already in a transaction,
			// just execute what needs to be executed -- no commit required
			if(inTransaction) {
				await work()
			} else {
				logger.trace('entering transaction')
				inTransaction = true
				try {
					await work()
					if(Object.keys(mutations).length) {
						logger.trace('committing transaction')
						// retry mechanism to ensure we've some recovery
						// in case a transaction fails in the first attempt
						let tries = maxCommitRetries
						while(tries) {
							tries -= 1
							try {
								await state.set(mutations)
								logger.trace({ dbQueriesInTransaction }, 'committed transaction')
								break
							} catch(error) {
								logger.warn(`failed to commit ${Object.keys(mutations).length} mutations, tries left=${tries}`)
								await delay(delayBetweenTriesMs)
							}
						}
					} else {
						logger.trace('no mutations in transaction')
					}
				} finally {
					inTransaction = false
					transactionCache = { }
					mutations = { }
					dbQueriesInTransaction = 0
				}
			}
		}
	}
}

export const initAuthCreds = (): AuthenticationCreds => {
	const identityKey = Curve.generateKeyPair()
	return {
		noiseKey: Curve.generateKeyPair(),
		signedIdentityKey: identityKey,
		signedPreKey: signedKeyPair(identityKey, 1),
		registrationId: generateRegistrationId(),
		advSecretKey: randomBytes(32).toString('base64'),
		processedHistoryMessages: [],
		nextPreKeyId: 1,
		firstUnuploadedPreKeyId: 1,
		accountSyncCounter: 0,
		accountSettings: {
			unarchiveChats: false
		}
	}
}