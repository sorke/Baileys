
import NodeCache from 'node-cache'
import { proto } from '../../WAProto'
import { DEFAULT_CACHE_TTLS, KEY_BUNDLE_TYPE, MIN_PREKEY_COUNT } from '../Defaults'
import { MessageReceiptType, MessageRelayOptions, MessageUserReceipt, SocketConfig, WACallEvent, WAMessageKey, WAMessageStatus, WAMessageStubType, WAPatchName } from '../Types'
import { decodeMediaRetryNode, decryptMessageNode, delay, encodeBigEndian, encodeSignedDeviceIdentity, getCallStatusFromNode, getHistoryMsg, getNextPreKeys, getStatusFromReceiptType, unixTimestampSeconds, xmppPreKey, xmppSignedPreKey } from '../Utils'
import { makeMutex } from '../Utils/make-mutex'
import { cleanMessage } from '../Utils/process-message'
import { areJidsSameUser, BinaryNode, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isJidUser, jidDecode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import { extractGroupMetadata } from './groups'
import { makeMessagesSocket } from './messages-send'

export const makeMessagesRecvSocket = (config: SocketConfig) => {
	const {
		logger,
		retryRequestDelayMs,
		getMessage,
		shouldIgnoreJid
	} = config
	const sock = makeMessagesSocket(config)
	const {
		ev,
		authState,
		ws,
		processingMutex,
		signalRepository,
		query,
		upsertMessage,
		resyncAppState,
		onUnexpectedError,
		assertSessions,
		sendNode,
		relayMessage,
		sendReceipt,
		uploadPreKeys,
	} = sock

	/** this mutex ensures that each retryRequest will wait for the previous one to finish */
	const retryMutex = makeMutex()

	const msgRetryCache = config.msgRetryCounterCache || new NodeCache({
		stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
		useClones: false
	})
	const callOfferCache = config.callOfferCache || new NodeCache({
		stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER, // 5 mins
		useClones: false
	})

	let sendActiveReceipts = false

	const sendMessageAck = async({ tag, attrs }: BinaryNode) => {
		const stanza: BinaryNode = {
			tag: 'ack',
			attrs: {
				id: attrs.id,
				to: attrs.from,
				class: tag,
			}
		}

		if(!!attrs.participant) {
			stanza.attrs.participant = attrs.participant
		}

		if(!!attrs.recipient) {
			stanza.attrs.recipient = attrs.recipient
		}

		if(tag !== 'message' && attrs.type) {
			stanza.attrs.type = attrs.type
		}

		logger.debug({ recv: { tag, attrs }, sent: stanza.attrs }, 'sent ack')
		await sendNode(stanza)
	}

	const rejectCall = async(callId: string, callFrom: string) => {
		const stanza: BinaryNode = ({
			tag: 'call',
			attrs: {
				from: authState.creds.me!.id,
				to: callFrom,
			},
			content: [{
			    tag: 'reject',
			    attrs: {
					'call-id': callId,
					'call-creator': callFrom,
					count: '0',
			    },
			    content: undefined,
			}],
		})
		await query(stanza)
	}

	const sendRetryRequest = async(node: BinaryNode, forceIncludeKeys = false) => {
		const msgId = node.attrs.id

		let retryCount = msgRetryCache.get<number>(msgId) || 0
		if(retryCount >= 5) {
			logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')
			msgRetryCache.del(msgId)
			return
		}

		retryCount += 1
		msgRetryCache.set(msgId, retryCount)

		const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds

		const deviceIdentity = encodeSignedDeviceIdentity(account!, true)
		await authState.keys.transaction(
			async() => {
				const receipt: BinaryNode = {
					tag: 'receipt',
					attrs: {
						id: msgId,
						type: 'retry',
						to: node.attrs.from
					},
					content: [
						{
							tag: 'retry',
							attrs: {
								count: retryCount.toString(),
								id: node.attrs.id,
								t: node.attrs.t,
								v: '1'
							}
						},
						{
							tag: 'registration',
							attrs: { },
							content: encodeBigEndian(authState.creds.registrationId)
						}
					]
				}

				if(node.attrs.recipient) {
					receipt.attrs.recipient = node.attrs.recipient
				}

				if(node.attrs.participant) {
					receipt.attrs.participant = node.attrs.participant
				}

				if(retryCount > 1 || forceIncludeKeys) {
					const { update, preKeys } = await getNextPreKeys(authState, 1)

					const [keyId] = Object.keys(preKeys)
					const key = preKeys[+keyId]

					const content = receipt.content! as BinaryNode[]
					content.push({
						tag: 'keys',
						attrs: { },
						content: [
							{ tag: 'type', attrs: { }, content: Buffer.from(KEY_BUNDLE_TYPE) },
							{ tag: 'identity', attrs: { }, content: identityKey.public },
							xmppPreKey(key, +keyId),
							xmppSignedPreKey(signedPreKey),
							{ tag: 'device-identity', attrs: { }, content: deviceIdentity }
						]
					})

					ev.emit('creds.update', update)
				}

				await sendNode(receipt)

				logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')
			}
		)
	}

	const handleEncryptNotification = async(node: BinaryNode) => {
		const from = node.attrs.from
		if(from === S_WHATSAPP_NET) {
			const countChild = getBinaryNodeChild(node, 'count')
			const count = +countChild!.attrs.value
			const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT

			logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
			if(shouldUploadMorePreKeys) {
				await uploadPreKeys()
			}
		} else {
			const identityNode = getBinaryNodeChild(node, 'identity')
			if(identityNode) {
				logger.info({ jid: from }, 'identity changed')
				// not handling right now
				// signal will override new identity anyway
			} else {
				logger.info({ node }, 'unknown encrypt notification')
			}
		}
	}

	const handleGroupNotification = (
		participant: string,
		child: BinaryNode,
		msg: Partial<proto.IWebMessageInfo>
	) => {
		switch (child?.tag) {
		case 'create':
			const metadata = extractGroupMetadata(child)

			msg.messageStubType = WAMessageStubType.GROUP_CREATE
			msg.messageStubParameters = [metadata.subject]
			msg.key = { participant: metadata.owner }

			ev.emit('chats.upsert', [{
				id: metadata.id,
				name: metadata.subject,
				conversationTimestamp: metadata.creation,
			}])
			ev.emit('groups.upsert', [metadata])
			break
		case 'ephemeral':
		case 'not_ephemeral':
			msg.message = {
				protocolMessage: {
					type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
					ephemeralExpiration: +(child.attrs.expiration || 0)
				}
			}
			break
		case 'promote':
		case 'demote':
		case 'remove':
		case 'add':
		case 'leave':
			const stubType = `GROUP_PARTICIPANT_${child.tag!.toUpperCase()}`
			msg.messageStubType = WAMessageStubType[stubType]

			const participants = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid)
			if(
				participants.length === 1 &&
					// if recv. "remove" message and sender removed themselves
					// mark as left
					areJidsSameUser(participants[0], participant) &&
					child.tag === 'remove'
			) {
				msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE
			}

			msg.messageStubParameters = participants
			break
		case 'subject':
			msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
			msg.messageStubParameters = [ child.attrs.subject ]
			break
		case 'announcement':
		case 'not_announcement':
			msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
			msg.messageStubParameters = [ (child.tag === 'announcement') ? 'on' : 'off' ]
			break
		case 'locked':
		case 'unlocked':
			msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
			msg.messageStubParameters = [ (child.tag === 'locked') ? 'on' : 'off' ]
			break
		case 'invite':
			msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK
			msg.messageStubParameters = [ child.attrs.code ]
			break
		}
	}

	const processNotification = async(node: BinaryNode) => {
		const result: Partial<proto.IWebMessageInfo> = { }
		const [child] = getAllBinaryNodeChildren(node)
		const nodeType = node.attrs.type
		const from = jidNormalizedUser(node.attrs.from)

		switch (nodeType) {
		case 'privacy_token':
			const tokenList = getBinaryNodeChildren(child, 'token')
			for(const { attrs, content } of tokenList) {
				const jid = attrs.jid
				ev.emit('chats.update', [
					{
						id: jid,
						tcToken: content as Buffer
					}
				])

				logger.debug({ jid }, 'got privacy token update')
			}

			break
		case 'w:gp2':
			handleGroupNotification(node.attrs.participant, child, result)
			break
		case 'mediaretry':
			const event = decodeMediaRetryNode(node)
			ev.emit('messages.media-update', [event])
			break
		case 'encrypt':
			await handleEncryptNotification(node)
			break
		case 'devices':
			const devices = getBinaryNodeChildren(child, 'device')
			if(areJidsSameUser(child.attrs.jid, authState.creds!.me!.id)) {
				const deviceJids = devices.map(d => d.attrs.jid)
				logger.info({ deviceJids }, 'got my own devices')
			}

			break
		case 'server_sync':
			const update = getBinaryNodeChild(node, 'collection')
			if(update) {
				const name = update.attrs.name as WAPatchName
				await resyncAppState([name], false)
			}

			break
		case 'picture':
			const setPicture = getBinaryNodeChild(node, 'set')
			const delPicture = getBinaryNodeChild(node, 'delete')

			ev.emit('contacts.update', [{
				id: from,
				imgUrl: setPicture ? 'changed' : null
			}])

			if(isJidGroup(from)) {
				const node = setPicture || delPicture
				result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON

				if(setPicture) {
					result.messageStubParameters = [ setPicture.attrs.id ]
				}

				result.participant = node?.attrs.author
				result.key = {
					...result.key || {},
					participant: setPicture?.attrs.author
				}
			}

			break
		case 'account_sync':
			if(child.tag === 'disappearing_mode') {
				const newDuration = +child.attrs.duration
				const timestamp = +child.attrs.t

				logger.info({ newDuration }, 'updated account disappearing mode')

				ev.emit('creds.update', {
					accountSettings: {
						...authState.creds.accountSettings,
						defaultDisappearingMode: {
							ephemeralExpiration: newDuration,
							ephemeralSettingTimestamp: timestamp,
						},
					}
				})
			}

			break
		}

		if(Object.keys(result).length) {
			return result
		}
	}

	const willSendMessageAgain = (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const retryCount = msgRetryCache.get<number>(key) || 0
		return retryCount < 5
	}

	const updateSendMessageAgainCount = (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const newValue = (msgRetryCache.get<number>(key) || 0) + 1
		msgRetryCache.set(key, newValue)
	}

	const sendMessagesAgain = async(
		key: proto.IMessageKey,
		ids: string[],
		retryNode: BinaryNode
	) => {
		const msgs = await Promise.all(ids.map(id => getMessage({ ...key, id })))
		const remoteJid = key.remoteJid!
		const participant = key.participant || remoteJid
		// if it's the primary jid sending the request
		// just re-send the message to everyone
		// prevents the first message decryption failure
		const sendToAll = !jidDecode(participant)?.device
		await assertSessions([participant], true)

		if(isJidGroup(remoteJid)) {
			await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
		}

		logger.debug({ participant, sendToAll }, 'forced new session for retry recp')

		for(let i = 0; i < msgs.length;i++) {
			const msg = msgs[i]
			if(msg) {
				updateSendMessageAgainCount(ids[i], participant)
				const msgRelayOpts: MessageRelayOptions = { messageId: ids[i] }

				if(sendToAll) {
					msgRelayOpts.useUserDevicesCache = false
				} else {
					msgRelayOpts.participant = {
						jid: participant,
						count: +retryNode.attrs.count
					}
				}

				await relayMessage(key.remoteJid!, msg, msgRelayOpts)
			} else {
				logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
			}
		}
	}

	const handleReceipt = async(node: BinaryNode) => {
		const { attrs, content } = node
		const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, authState.creds.me?.id)
		const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		const fromMe = !attrs.recipient || (attrs.type === 'retry' && isNodeFromMe)

		const key: proto.IMessageKey = {
			remoteJid,
			id: '',
			fromMe,
			participant: attrs.participant
		}

		if(shouldIgnoreJid(remoteJid)) {
			logger.debug({ remoteJid }, 'ignoring receipt from jid')
			await sendMessageAck(node)
			return
		}

		const ids = [attrs.id]
		if(Array.isArray(content)) {
			const items = getBinaryNodeChildren(content[0], 'item')
			ids.push(...items.map(i => i.attrs.id))
		}

		await Promise.all([
			processingMutex.mutex(
				async() => {
					const status = getStatusFromReceiptType(attrs.type)
					if(
						typeof status !== 'undefined' &&
						(
							// basically, we only want to know when a message from us has been delivered to/read by the other person
							// or another device of ours has read some messages
							status > proto.WebMessageInfo.Status.DELIVERY_ACK ||
							!isNodeFromMe
						)
					) {
						if(isJidGroup(remoteJid)) {
							if(attrs.participant) {
								const updateKey: keyof MessageUserReceipt = status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
								ev.emit(
									'message-receipt.update',
									ids.map(id => ({
										key: { ...key, id },
										receipt: {
											userJid: jidNormalizedUser(attrs.participant),
											[updateKey]: +attrs.t
										}
									}))
								)
							}
						} else {
							ev.emit(
								'messages.update',
								ids.map(id => ({
									key: { ...key, id },
									update: { status }
								}))
							)
						}
					}

					if(attrs.type === 'retry') {
						// correctly set who is asking for the retry
						key.participant = key.participant || attrs.from
						const retryNode = getBinaryNodeChild(node, 'retry')
						if(willSendMessageAgain(ids[0], key.participant)) {
							if(key.fromMe) {
								try {
									logger.debug({ attrs, key }, 'recv retry request')
									await sendMessagesAgain(key, ids, retryNode!)
								} catch(error) {
									logger.error({ key, ids, trace: error.stack }, 'error in sending message again')
								}
							} else {
								logger.info({ attrs, key }, 'recv retry for not fromMe message')
							}
						} else {
							logger.info({ attrs, key }, 'will not send message again, as sent too many times')
						}
					}
				}
			),
			sendMessageAck(node)
		])
	}

	const handleNotification = async(node: BinaryNode) => {
		const remoteJid = node.attrs.from
		if(shouldIgnoreJid(remoteJid)) {
			logger.debug({ remoteJid, id: node.attrs.id }, 'ignored notification')
			await sendMessageAck(node)
			return
		}

		await Promise.all([
			processingMutex.mutex(
				async() => {
					const msg = await processNotification(node)
					if(msg) {
						const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me!.id)
						msg.key = {
							remoteJid,
							fromMe,
							participant: node.attrs.participant,
							id: node.attrs.id,
							...(msg.key || {})
						}
						msg.participant ??= node.attrs.participant
						msg.messageTimestamp = +node.attrs.t

						const fullMsg = proto.WebMessageInfo.fromObject(msg)
						await upsertMessage(fullMsg, 'append')
					}
				}
			),
			sendMessageAck(node)
		])
	}

	const handleMessage = async(node: BinaryNode) => {
		const { fullMessage: msg, category, author, decrypt } = decryptMessageNode(
			node,
			authState.creds.me!.id,
			signalRepository,
			logger,
		)
		if(shouldIgnoreJid(msg.key.remoteJid!)) {
			logger.debug({ key: msg.key }, 'ignored message')
			await sendMessageAck(node)
			return
		}

		await Promise.all([
			processingMutex.mutex(
				async() => {
					await decrypt()
					// message failed to decrypt
					if(msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
						retryMutex.mutex(
							async() => {
								if(ws.readyState === ws.OPEN) {
									const encNode = getBinaryNodeChild(node, 'enc')
									await sendRetryRequest(node, !encNode)
									if(retryRequestDelayMs) {
										await delay(retryRequestDelayMs)
									}
								} else {
									logger.debug({ node }, 'connection closed, ignoring retry req')
								}
							}
						)
					} else {
						// no type in the receipt => message delivered
						let type: MessageReceiptType = undefined
						let participant = msg.key.participant
						if(category === 'peer') { // special peer message
							type = 'peer_msg'
						} else if(msg.key.fromMe) { // message was sent by us from a different device
							type = 'sender'
							// need to specially handle this case
							if(isJidUser(msg.key.remoteJid!)) {
								participant = author
							}
						} else if(!sendActiveReceipts) {
							type = 'inactive'
						}

						await sendReceipt(msg.key.remoteJid!, participant!, [msg.key.id!], type)

						// send ack for history message
						const isAnyHistoryMsg = getHistoryMsg(msg.message!)
						if(isAnyHistoryMsg) {
							const jid = jidNormalizedUser(msg.key.remoteJid!)
							await sendReceipt(jid, undefined, [msg.key.id!], 'hist_sync')
						}
					}

					cleanMessage(msg, authState.creds.me!.id)

					await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')
				}
			),
			sendMessageAck(node)
		])
	}

	const handleCall = async(node: BinaryNode) => {
		const { attrs } = node
		const [infoChild] = getAllBinaryNodeChildren(node)
		const callId = infoChild.attrs['call-id']
		const from = infoChild.attrs.from || infoChild.attrs['call-creator']
		const status = getCallStatusFromNode(infoChild)
		const call: WACallEvent = {
			chatId: attrs.from,
			from,
			id: callId,
			date: new Date(+attrs.t * 1000),
			offline: !!attrs.offline,
			status,
		}

		if(status === 'offer') {
			call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
			call.isGroup = infoChild.attrs.type === 'group'
			callOfferCache.set(call.id, call)
		}

		const existingCall = callOfferCache.get<WACallEvent>(call.id)

		// use existing call info to populate this event
		if(existingCall) {
			call.isVideo = existingCall.isVideo
			call.isGroup = existingCall.isGroup
		}

		// delete data once call has ended
		if(status === 'reject' || status === 'accept' || status === 'timeout') {
			callOfferCache.del(call.id)
		}

		ev.emit('call', [call])

		await sendMessageAck(node)
	}

	const handleBadAck = async({ attrs }: BinaryNode) => {
		const key: WAMessageKey = { remoteJid: attrs.from, fromMe: true, id: attrs.id }
		// current hypothesis is that if pash is sent in the ack
		// it means -- the message hasn't reached all devices yet
		// we'll retry sending the message here
		if(attrs.phash) {
			logger.info({ attrs }, 'received phash in ack, resending message...')
			const msg = await getMessage(key)
			if(msg) {
				await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
			} else {
				logger.warn({ attrs }, 'could not send message again, as it was not found')
			}
		}

		// error in acknowledgement,
		// device could not display the message
		if(attrs.error) {
			logger.warn({ attrs }, 'received error in ack')
			ev.emit(
				'messages.update',
				[
					{
						key,
						update: {
							status: WAMessageStatus.ERROR,
							messageStubParameters: [
								attrs.error
							]
						}
					}
				]
			)
		}
	}

	/// processes a node with the given function
	/// and adds the task to the existing buffer if we're buffering events
	const processNodeWithBuffer = async<T>(
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode) => Promise<T>
	) => {
		ev.buffer()
		await execTask()
		ev.flush()

		function execTask() {
			return exec(node)
				.catch(err => onUnexpectedError(err, identifier))
		}
	}

	// recv a message
	ws.on('CB:message', (node: BinaryNode) => {
		processNodeWithBuffer(node, 'processing message', handleMessage)
	})

	ws.on('CB:call', async(node: BinaryNode) => {
		processNodeWithBuffer(node, 'handling call', handleCall)
	})

	ws.on('CB:receipt', node => {
		processNodeWithBuffer(node, 'handling receipt', handleReceipt)
	})

	ws.on('CB:notification', async(node: BinaryNode) => {
		processNodeWithBuffer(node, 'handling notification', handleNotification)
	})

	ws.on('CB:ack,class:message', (node: BinaryNode) => {
		handleBadAck(node)
			.catch(error => onUnexpectedError(error, 'handling bad ack'))
	})

	ev.on('call', ([ call ]) => {
		// missed call + group call notification message generation
		if(call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
			const msg: proto.IWebMessageInfo = {
				key: {
					remoteJid: call.chatId,
					id: call.id,
					fromMe: false
				},
				messageTimestamp: unixTimestampSeconds(call.date),
			}
			if(call.status === 'timeout') {
				if(call.isGroup) {
					msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_GROUP_VIDEO : WAMessageStubType.CALL_MISSED_GROUP_VOICE
				} else {
					msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE
				}
			} else {
				msg.message = { call: { callKey: Buffer.from(call.id) } }
			}

			const protoMsg = proto.WebMessageInfo.fromObject(msg)
			upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
		}
	})

	ev.on('connection.update', ({ isOnline }) => {
		if(typeof isOnline !== 'undefined') {
			sendActiveReceipts = isOnline
			logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)
		}
	})

	return {
		...sock,
		sendMessageAck,
		sendRetryRequest,
		rejectCall
	}
}
