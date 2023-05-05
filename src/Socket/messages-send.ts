
import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import { proto } from '../../WAProto'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults'
import { AnyMessageContent, MediaConnInfo, MessageReceiptType, MessageRelayOptions, MiscMessageGenerationOptions, SocketConfig, WAMessageKey } from '../Types'
import { aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent, decryptMediaRetryData, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest, extractDeviceJids, generateMessageID, generateWAMessage, getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, parseAndInjectE2ESessions, unixTimestampSeconds } from '../Utils'
import { getUrlInfo } from '../Utils/link-preview'
import { areJidsSameUser, BinaryNode, BinaryNodeAttributes, getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isJidUser, jidDecode, jidEncode, jidNormalizedUser, JidWithDevice, S_WHATSAPP_NET } from '../WABinary'
import { makeGroupsSocket } from './groups'
import ListType = proto.Message.ListMessage.ListType;

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: axiosOptions,
		patchMessageBeforeSending,
	} = config
	const sock = makeGroupsSocket(config)
	const {
		ev,
		authState,
		processingMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		generateMessageTag,
		sendNode,
		groupMetadata,
		groupToggleEphemeral
	} = sock

	const userDevicesCache = config.userDevicesCache || new NodeCache({
		stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
		useClones: false
	})

	let mediaConn: Promise<MediaConnInfo>
	const refreshMediaConn = async(forceGet = false) => {
		const media = await mediaConn
		if(!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
			mediaConn = (async() => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET,
					},
					content: [ { tag: 'media_conn', attrs: { } } ]
				})
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn')
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(
						({ attrs }) => ({
							hostname: attrs.hostname,
							maxContentLengthBytes: +attrs.maxContentLengthBytes,
						})
					),
					auth: mediaConnNode!.attrs.auth,
					ttl: +mediaConnNode!.attrs.ttl,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				return node
			})()
		}

		return mediaConn
	}

	/**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
	const sendReceipt = async(jid: string, participant: string | undefined, messageIds: string[], type: MessageReceiptType) => {
		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0],
			},
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if(isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString()
		}

		if(type === 'sender' && isJidUser(jid)) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if(participant) {
				node.attrs.participant = participant
			}
		}

		if(type) {
			node.attrs.type = type
		}

		const remainingMessageIds = messageIds.slice(1)
		if(remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: { },
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async(keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys)
		for(const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async(keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings()
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
 	}

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async(jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => {
		const deviceResults: JidWithDevice[] = []

		if(!useCache) {
			logger.debug('not using cache for devices')
		}

		const users: BinaryNode[] = []
		jids = Array.from(new Set(jids))
		for(let jid of jids) {
			const user = jidDecode(jid)?.user
			jid = jidNormalizedUser(jid)

			const devices = userDevicesCache.get<JidWithDevice[]>(user!)
			if(devices && useCache) {
				deviceResults.push(...devices)

				logger.trace({ user }, 'using cache for devices')
			} else {
				users.push({ tag: 'user', attrs: { jid } })
			}
		}

		const iq: BinaryNode = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'usync',
			},
			content: [
				{
					tag: 'usync',
					attrs: {
						sid: generateMessageTag(),
						mode: 'query',
						last: 'true',
						index: '0',
						context: 'message',
					},
					content: [
						{
							tag: 'query',
							attrs: { },
							content: [
								{
									tag: 'devices',
									attrs: { version: '2' }
								}
							]
						},
						{ tag: 'list', attrs: { }, content: users }
					]
				},
			],
		}
		const result = await query(iq)
		const extracted = extractDeviceJids(result, authState.creds.me!.id, ignoreZeroDevices)
		const deviceMap: { [_: string]: JidWithDevice[] } = {}

		for(const item of extracted) {
			deviceMap[item.user] = deviceMap[item.user] || []
			deviceMap[item.user].push(item)

			deviceResults.push(item)
		}

		for(const key in deviceMap) {
			userDevicesCache.set(key, deviceMap[key])
		}

		return deviceResults
	}

	const assertSessions = async(jids: string[], force: boolean) => {
		let didFetchNewSession = false
		let jidsRequiringFetch: string[] = []
		if(force) {
			jidsRequiringFetch = jids
		} else {
			const addrs = jids.map(jid => (
				signalRepository
					.jidToSignalProtocolAddress(jid)
			))
			const sessions = await authState.keys.get('session', addrs)
			for(const jid of jids) {
				const signalId = signalRepository
					.jidToSignalProtocolAddress(jid)
				if(!sessions[signalId]) {
					jidsRequiringFetch.push(jid)
				}
			}
		}

		if(jidsRequiringFetch.length) {
			logger.debug({ jidsRequiringFetch }, 'fetching sessions')
			const result = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'encrypt',
					type: 'get',
					to: S_WHATSAPP_NET,
				},
				content: [
					{
						tag: 'key',
						attrs: { },
						content: jidsRequiringFetch.map(
							jid => ({
								tag: 'user',
								attrs: { jid },
							})
						)
					}
				]
			})
			await parseAndInjectE2ESessions(result, signalRepository)

			didFetchNewSession = true
		}

		return didFetchNewSession
	}

	const createParticipantNodes = async(
		jids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs']
	) => {
		const patched = await patchMessageBeforeSending(message, jids)
		const bytes = encodeWAMessage(patched)

		let shouldIncludeDeviceIdentity = false
		const nodes = await Promise.all(
			jids.map(
				async jid => {
					const { type, ciphertext } = await signalRepository
						.encryptMessage({ jid, data: bytes })
					if(type === 'pkmsg') {
						shouldIncludeDeviceIdentity = true
					}

					const node: BinaryNode = {
						tag: 'to',
						attrs: { jid },
						content: [{
							tag: 'enc',
							attrs: {
								v: '2',
								type,
								...extraAttrs || {}
							},
							content: ciphertext
						}]
					}
					return node
				}
			)
		)
		return { nodes, shouldIncludeDeviceIdentity }
	}

	const relayMessage = async(
		jid: string,
		message: proto.IMessage,
		{ messageId: msgId, participant, additionalAttributes, useUserDevicesCache, cachedGroupMetadata }: MessageRelayOptions
	) => {
		const meId = authState.creds.me!.id

		let shouldIncludeDeviceIdentity = false

		const { user, server } = jidDecode(jid)!
		const isGroup = server === 'g.us'
		msgId = msgId || generateMessageID()
		useUserDevicesCache = useUserDevicesCache !== false

		const participants: BinaryNode[] = []
		const destinationJid = jidEncode(user, isGroup ? 'g.us' : 's.whatsapp.net')
		const binaryNodeContent: BinaryNode[] = []
		const devices: JidWithDevice[] = []

		const meMsg: proto.IMessage = {
			deviceSentMessage: {
				destinationJid,
				message
			}
		}

		if(participant) {
			// when the retry request is not for a group
			// only send to the specific device that asked for a retry
			// otherwise the message is sent out to every device that should be a recipient
			if(!isGroup) {
				additionalAttributes = { ...additionalAttributes, 'device_fanout': 'false' }
			}

			const { user, device } = jidDecode(participant.jid)!
			devices.push({ user, device })
		}

		await authState.keys.transaction(
			async() => {
				const mediaType = getMediaType(message)
				if(isGroup) {
					const [groupData, senderKeyMap] = await Promise.all([
						(async() => {
							let groupData = cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
							if(groupData) {
								logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
							}

							if(!groupData) {
								groupData = await groupMetadata(jid)
							}

							return groupData
						})(),
						(async() => {
							if(!participant) {
								const result = await authState.keys.get('sender-key-memory', [jid])
								return result[jid] || { }
							}

							return { }
						})()
					])

					if(!participant) {
						const participantsList = groupData.participants.map(p => p.id)
						const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
						devices.push(...additionalDevices)
					}

					const patched = await patchMessageBeforeSending(message, devices.map(d => jidEncode(d.user, 's.whatsapp.net', d.device)))
					const bytes = encodeWAMessage(patched)

					const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage(
						{
							group: destinationJid,
							data: bytes,
							meId,
						}
					)

					const senderKeyJids: string[] = []
					// ensure a connection is established with every device
					for(const { user, device } of devices) {
						const jid = jidEncode(user, 's.whatsapp.net', device)
						if(!senderKeyMap[jid] || !!participant) {
							senderKeyJids.push(jid)
							// store that this person has had the sender keys sent to them
							senderKeyMap[jid] = true
						}
					}

					// if there are some participants with whom the session has not been established
					// if there are, we re-send the senderkey
					if(senderKeyJids.length) {
						logger.debug({ senderKeyJids }, 'sending new sender key')

						const senderKeyMsg: proto.IMessage = {
							senderKeyDistributionMessage: {
								axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
								groupId: destinationJid
							}
						}

						await assertSessions(senderKeyJids, false)

						const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, mediaType ? { mediatype: mediaType } : undefined)
						shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity

						participants.push(...result.nodes)
					}

					binaryNodeContent.push({
						tag: 'enc',
						attrs: { v: '2', type: 'skmsg' },
						content: ciphertext
					})

					await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
				} else {
					const { user: meUser } = jidDecode(meId)!

					if(!participant) {
						devices.push({ user })
						devices.push({ user: meUser })

						const additionalDevices = await getUSyncDevices([ meId, jid ], !!useUserDevicesCache, true)
						devices.push(...additionalDevices)
					}

					const allJids: string[] = []
					const meJids: string[] = []
					const otherJids: string[] = []
					for(const { user, device } of devices) {
						const jid = jidEncode(user, 's.whatsapp.net', device)
						const isMe = user === meUser
						if(isMe) {
							meJids.push(jid)
						} else {
							otherJids.push(jid)
						}

						allJids.push(jid)
					}

					await assertSessions(allJids, false)

					const [
						{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
						{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }
					] = await Promise.all([
						createParticipantNodes(meJids, meMsg, mediaType ? { mediatype: mediaType } : undefined),
						createParticipantNodes(otherJids, message, mediaType ? { mediatype: mediaType } : undefined)
					])
					participants.push(...meNodes)
					participants.push(...otherNodes)

					shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
				}

				if(participants.length) {
					binaryNodeContent.push({
						tag: 'participants',
						attrs: { },
						content: participants
					})
				}

				const stanza: BinaryNode = {
					tag: 'message',
					attrs: {
						id: msgId!,
						type: 'text',
						...(additionalAttributes || {})
					},
					content: binaryNodeContent
				}
				// if the participant to send to is explicitly specified (generally retry recp)
				// ensure the message is only sent to that person
				// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
				if(participant) {
					if(isJidGroup(destinationJid)) {
						stanza.attrs.to = destinationJid
						stanza.attrs.participant = participant.jid
					} else if(areJidsSameUser(participant.jid, meId)) {
						stanza.attrs.to = participant.jid
						stanza.attrs.recipient = destinationJid
					} else {
						stanza.attrs.to = participant.jid
					}
				} else {
					stanza.attrs.to = destinationJid
				}

				if(shouldIncludeDeviceIdentity) {
					(stanza.content as BinaryNode[]).push({
						tag: 'device-identity',
						attrs: { },
						content: encodeSignedDeviceIdentity(authState.creds.account!, true)
					})

					logger.debug({ jid }, 'adding device identity')
				}

				const buttonType = getButtonType(message)
				if(buttonType) {
					(stanza.content as BinaryNode[]).push({
						tag: 'biz',
						attrs: { },
						content: [
							{
								tag: buttonType,
								attrs: getButtonArgs(message),
							}
						]
					})

					logger.debug({ jid }, 'adding business node')
				}

				logger.debug({ msgId }, `sending message to ${participants.length} devices`)

				await sendNode(stanza)
			}
		)

		return msgId
	}

	const getMediaType = (message: proto.IMessage) => {
		if(message.imageMessage) {
			return 'image'
		} else if(message.videoMessage) {
			return message.videoMessage.gifPlayback ? 'gif' : 'video'
		} else if(message.audioMessage) {
			return message.audioMessage.ptt ? 'ptt' : 'audio'
		} else if(message.contactMessage) {
			return 'vcard'
		} else if(message.documentMessage) {
			return 'document'
		} else if(message.contactsArrayMessage) {
			return 'contact_array'
		} else if(message.liveLocationMessage) {
			return 'livelocation'
		} else if(message.stickerMessage) {
			return 'sticker'
		} else if(message.listMessage) {
			return 'list'
		} else if(message.listResponseMessage) {
			return 'list_response'
		} else if(message.buttonsResponseMessage) {
			return 'buttons_response'
		} else if(message.orderMessage) {
			return 'order'
		} else if(message.productMessage) {
			return 'product'
		} else if(message.interactiveResponseMessage) {
			return 'native_flow_response'
		}
	}

	const getButtonType = (message: proto.IMessage) => {
		if(message.buttonsMessage) {
			return 'buttons'
		} else if(message.buttonsResponseMessage) {
			return 'buttons_response'
		} else if(message.interactiveResponseMessage) {
			return 'interactive_response'
		} else if(message.listMessage) {
			return 'list'
		} else if(message.listResponseMessage) {
			return 'list_response'
		}
	}

	const getButtonArgs = (message: proto.IMessage): BinaryNode['attrs'] => {
		if(message.templateMessage) {
			// TODO: Add attributes
			return {}
		} else if(message.listMessage) {
			const type = message.listMessage.listType
			if(!type) {
				throw new Boom('Expected list type inside message')
			}

			return { v: '2', type: ListType[type].toLowerCase() }
		} else {
			return {}
		}
	}

	const getPrivacyTokens = async(jids: string[]) => {
		const t = unixTimestampSeconds().toString()
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'privacy'
			},
			content: [
				{
					tag: 'tokens',
					attrs: { },
					content: jids.map(
						jid => ({
							tag: 'token',
							attrs: {
								jid: jidNormalizedUser(jid),
								t,
								type: 'trusted_contact'
							}
						})
					)
				}
			]
		})

		return result
	}

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)

	const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

	return {
		...sock,
		getPrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		sendReceipts,
		readMessages,
		refreshMediaConn,
	    waUploadToServer,
		fetchPrivacySettings,
		updateMediaMessage: async(message: proto.IWebMessageInfo) => {
			const content = assertMediaContent(message.message)
			const mediaKey = content.mediaKey!
			const meId = authState.creds.me!.id
			const node = encryptMediaRetryRequest(message.key, mediaKey, meId)

			let error: Error | undefined = undefined
			await Promise.all(
				[
					sendNode(node),
					waitForMsgMediaUpdate(update => {
						const result = update.find(c => c.key.id === message.key.id)
						if(result) {
							if(result.error) {
								error = result.error
							} else {
								try {
									const media = decryptMediaRetryData(result.media!, mediaKey, result.key.id!)
									if(media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
										const resultStr = proto.MediaRetryNotification.ResultType[media.result]
										throw new Boom(
											`Media re-upload failed by device (${resultStr})`,
											{ data: media, statusCode: getStatusCodeForMediaRetry(media.result) || 404 }
										)
									}

									content.directPath = media.directPath
									content.url = getUrlFromDirectPath(content.directPath!)

									logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
								} catch(err) {
									error = err
								}
							}

							return true
						}
					})
				]
			)

			if(error) {
				throw error
			}

			ev.emit('messages.update', [
				{ key: message.key, update: { message: message.message } }
			])

			return message
		},
		sendMessage: async(
			jid: string,
			content: AnyMessageContent,
			options: MiscMessageGenerationOptions = { }
		) => {
			const userJid = authState.creds.me!.id
			if(
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content
				const value = typeof disappearingMessagesInChat === 'boolean' ?
					(disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) :
					disappearingMessagesInChat
				await groupToggleEphemeral(jid, value)
			} else {
				const fullMsg = await generateWAMessage(
					jid,
					content,
					{
						logger,
						userJid,
						getUrlInfo: text => getUrlInfo(
							text,
							{
								thumbnailWidth: linkPreviewImageThumbnailWidth,
								fetchOpts: {
									timeout: 3_000,
									...axiosOptions || { }
								},
								logger,
								uploadImage: generateHighQualityLinkPreview
									? waUploadToServer
									: undefined
							},
						),
						upload: waUploadToServer,
						mediaCache: config.mediaCache,
						options: config.options,
						...options,
					}
				)
				const isDeleteMsg = 'delete' in content && !!content.delete
				const additionalAttributes: BinaryNodeAttributes = { }
				// required for delete
				if(isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if(isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				}

				await relayMessage(jid, fullMsg.message!, { messageId: fullMsg.key.id!, cachedGroupMetadata: options.cachedGroupMetadata, additionalAttributes })
				if(config.emitOwnEvents) {
					process.nextTick(() => {
						processingMutex.mutex(() => (
							upsertMessage(fullMsg, 'append')
						))
					})
				}

				return fullMsg
			}
		}
	}
}