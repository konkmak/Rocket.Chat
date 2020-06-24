import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';

import { ImportData } from '../models/ImportData';
import { IImportUser } from '../definitions/IImportUser';
import { IImportMessage } from '../definitions/IImportMessage';
import { IImportChannel } from '../definitions/IImportChannel';
import { IImportUserRecord, IImportChannelRecord, IImportMessageRecord } from '../definitions/IImportRecord';
import { Users, Rooms } from '../../../models/server';
import { generateUsernameSuggestion, insertMessage, setUserAvatar } from '../../../lib/server';
import { setUserActiveStatus } from '../../../lib/server/functions/setUserActiveStatus';
import { IUser } from '../../../../definition/IUser';
import '../../../../definition/Meteor';
import { getValidRoomName } from '../../../utils';

type IRoom = Record<string, any>;

const guessNameFromUsername = (username: string): string =>
	username
		.replace(/\W/g, ' ')
		.replace(/\s(.)/g, (u) => u.toUpperCase())
		.replace(/^(.)/, (u) => u.toLowerCase())
		.replace(/^\w/, (u) => u.toUpperCase());

export class ImporterBase {
	addObject(type: string, identification: Record<string, any> | undefined, data: Record<string, any>): void {
		ImportData.insert({
			data,
			identification,
			dataType: type,
		});
	}

	addUser(data: IImportUser): void {
		this.addObject('user', undefined, data);
	}

	addChannel(data: IImportChannel): void {
		this.addObject('channel', undefined, data);
	}

	addMessage(identification: IImportMessageIdentification, data: IImportMessage): void {
		this.addObject('message', identification, data);
	}

	updateUserId(_id: string, userData: IImportUser): void {
		const updateData: Record<string, any> = {
			$set: {
				statusText: userData.statusText || undefined,
				roles: userData.roles || ['user'],
				type: userData.type || 'user',
				bio: userData.bio || undefined,
				name: userData.name || undefined,
			},
		};

		if (userData.importIds?.length) {
			updateData.$addToSet = {
				importIds: {
					$each: userData.importIds,
				},
			};
		}

		Users.update({ _id }, updateData);
	}

	updateUser(existingUser: IUser, userData: IImportUser): void {
		console.log('updating user', existingUser._id);

		userData._id = existingUser._id;

		this.updateUserId(userData._id, userData);

		// Meteor.runAsUser(existingUser._id, () => {
		// 	if (userData.avatarUrl) {
		// 		try {
		// 			setUserAvatar(existingUser, userData.avatarUrl, undefined, 'url');
		// 		} catch (error) {
		// 			// this.logger.warn(`Failed to set ${ userId }'s avatar from url ${ userData.avatarUrl }`);
		// 			console.log(error);
		// 			console.log(`Failed to set ${ existingUser._id }'s avatar from url ${ userData.avatarUrl }`);
		// 		}
		// 	}
		// });
	}

	insertUser(userData: IImportUser): IUser {
		console.log('insert user', userData);

		const password = `${ Date.now() }${ userData.name || '' }${ userData.emails.length ? userData.emails[0].toUpperCase() : '' }`;
		const userId = userData.emails.length ? Accounts.createUser({
			email: userData.emails[0],
			password,
		}) : Accounts.createUser({
			username: userData.username,
			password,
			joinDefaultChannelsSilenced: true,
		});

		userData._id = userId;
		const user = Users.findOneById(userId, {});

		Meteor.runAsUser(userId, () => {
			Meteor.call('setUsername', userData.username, { joinDefaultChannelsSilenced: true });
			if (userData.name) {
				Users.setName(userId, userData.name);
			}

			this.updateUserId(userId, userData);

			if (userData.utcOffset) {
				Users.setUtcOffset(userId, userData.utcOffset);
			}

			if (userData.avatarUrl) {
				try {
					setUserAvatar(user, userData.avatarUrl, undefined, 'url');
				} catch (error) {
					// this.logger.warn(`Failed to set ${ userId }'s avatar from url ${ userData.avatarUrl }`);
					// this.logger.error(error);
					console.log(error);
					console.log(`Failed to set ${ userId }'s avatar from url ${ userData.avatarUrl }`);
				}
			}
		});

		return user;
	}

	convertUsers(): void {
		const users = ImportData.find({ dataType: 'user' });
		users.forEach(({ data, _id }: IImportUserRecord) => {
			try {
				data.emails = data.emails.filter((item) => item);
				data.importIds = data.importIds.filter((item) => item);

				if (!data.emails.length && !data.username) {
					throw new Error('importer-user-missing-email-and-username');
				}

				let existingUser;
				if (data.emails.length) {
					existingUser = Users.findOneByEmailAddress(data.emails[0], {});
				}

				if (data.username) {
					// If we couldn't find one by their email address, try to find an existing user by their username
					if (!existingUser) {
						existingUser = Users.findOneByUsernameIgnoringCase(data.username, {});
					}
				} else {
					data.username = generateUsernameSuggestion({
						name: data.name,
						emails: data.emails,
					});
				}

				if (existingUser) {
					this.updateUser(existingUser, data);
				} else {
					if (!data.name && data.username) {
						data.name = guessNameFromUsername(data.username);
					}

					existingUser = this.insertUser(data);
				}

				// Deleted users are 'inactive' users in Rocket.Chat
				if (data.deleted && existingUser?.active) {
					setUserActiveStatus(data._id, false, true);
				}
			} catch (e) {
				this.saveError(_id, e);
			}
		});
	}

	saveNewId(importId: string, newId: string): void {
		ImportData.update({
			_id: importId,
		}, {
			$set: {
				id: newId,
			},
		});
	}

	saveError(importId: string, error: Error): void {
		console.log(error);
		ImportData.update({
			_id: importId,
		}, {
			$push: {
				errors: {
					message: error.message,
					stack: error.stack,
				},
			},
		});
	}

	convertMessages(): void {
		// const rooms = ImportData.model.rawCollection().find({
		// 	dataType: 'message',
		// 	$or: [
		// 		{

		// 		}
		// 	]
		// });

		const timestamps: Record<number, number> = {};
		const messages = ImportData.find({ dataType: 'message' });
		messages.forEach(({ data: m, identification, _id }: IImportMessageRecord) => {
			try {
				if (!m.ts || isNaN(m.ts as unknown as number)) {
					throw new Error('importer-message-invalid-timestamp');
				}

				const creator = this.findUser({
					_id: m.u?._id,
					username: m.u?.username,
					sourceId: identification?.u?._id,
					sourceUsername: identification?.u?.username,
				});

				if (!creator) {
					throw new Error('importer-message-unknown-user');
				}

				const room = this.findRoom({
					rid: m.rid,
					sourceRid: identification?.rid,
				});

				if (!room) {
					throw new Error('importer-message-unknown-room');
				}

				const ts = m.ts.getTime();
				const sourceChannelId = identification?.rid || room._id;

				let suffix = '';
				if (timestamps[ts] === undefined) {
					timestamps[ts] = 1;
				} else {
					suffix = `-${ timestamps[ts] }`;
					timestamps[ts] += 1;
				}

				const msgObj = {
					// _id: `csv-${ csvChannel.id }-${ msg.ts }${ suffix }`,
					_id: `imported-${ sourceChannelId }-${ ts }${ suffix }`,
					ts: m.ts,
					msg: m.msg,
					rid: room._id,
					u: {
						_id: creator._id,
						username: creator.username,
					},
				};

				insertMessage(creator, msgObj, room, true);
			} catch (e) {
				this.saveError(_id, e);
				throw e;
			}
		});
	}

	updateRoom(room: IRoom, roomData: IImportChannel, startedByUserId: string): void {
		console.log('updating room', room._id);
		// eslint-disable-next-line no-extra-parens
		roomData._id = room._id;

		if (roomData._id.toUpperCase() === 'GENERAL' && roomData.name !== room.name) {
			Meteor.runAsUser(startedByUserId, () => {
				Meteor.call('saveRoomSettings', 'GENERAL', 'roomName', roomData.name);
			});
		}

		this.updateRoomId(room._id, roomData);
	}

	_findRoom({ rid, sourceRid }: Record<string, string | undefined>, returnId = false): string | IRoom | null {
		const options = returnId ? { fields: { _id: 1 } } : undefined;

		if (rid) {
			if (returnId) {
				return rid;
			}

			return Rooms.findOneById(rid, options);
		}

		if (sourceRid) {
			const room = Rooms.findOneByImportId(sourceRid, options);

			if (room) {
				if (returnId) {
					return room._id;
				}

				return room;
			}
		}

		return null;
	}

	findRoom({ rid, sourceRid }: Record<string, string | undefined>): IRoom | null {
		return this._findRoom({ rid, sourceRid }, false) as IRoom | null;
	}

	findRoomId({ rid, sourceRid }: Record<string, string | undefined>): string | null {
		return this._findRoom({ rid, sourceRid }, true) as string | null;
	}

	_findImportedUser({ _id, username }: Record<string, string | undefined>, returnId = false): string | IUser | null {
		const options = returnId ? { fields: { _id: 1 } } : undefined;

		if (_id) {
			const user = Users.findOneByImportId(_id, options);
			if (user) {
				if (returnId) {
					return user._id;
				}
				return user;
			}
		}

		if (username) {
			const user = Users.findOneByUsernameIgnoringCase(username, options);
			if (user) {
				if (returnId) {
					return user._id;
				}
				return user;
			}
		}

		return null;
	}

	_findUser({ _id, username }: Record<string, string | undefined>, returnId = false): string | IUser | null {
		const options = returnId ? { fields: { _id: 1 } } : undefined;

		if (_id) {
			if (returnId) {
				return _id;
			}

			return Users.findOneById(_id, options);
		}

		if (username) {
			const user = Users.findOneByUsernameIgnoringCase(username, options);
			if (user) {
				if (returnId) {
					return user._id;
				}

				return user;
			}
		}

		return null;
	}

	findUser({ _id, username }: Record<string, string | undefined>): IUser | null {
		return this._findUser({ _id, username }, false) as IUser | null;
	}

	findUserId({ _id, username }: Record<string, string | undefined>): string | null {
		return this._findUser({ _id, username }, true) as string | null;
	}

	findImportedUser({ _id, username }: Record<string, string | undefined>): IUser | null {
		return this._findImportedUser({ _id, username }, false) as IUser | null;
	}

	findImportedUserId({ _id, username }: Record<string, string | undefined>): string | null {
		return this._findImportedUser({ _id, username }, true) as string | null;
	}

	updateRoomId(_id: string, roomData: IImportChannel): void {
		const set = {
			ts: roomData.ts,
			topic: roomData.topic,
			description: roomData.description,
		};

		const roomUpdate = {};

		if (Object.keys(set).length > 0) {
			roomUpdate.$set = set;
		}

		if (roomData.importIds.length) {
			roomUpdate.$addToSet = {
				importIds: {
					$each: roomData.importIds,
				},
			};
		}

		if (roomUpdate.$set || roomUpdate.$addToSet) {
			Rooms.update({ _id: roomData._id }, roomUpdate);
		}
	}

	insertRoom(roomData: IImportChannel, startedByUserId: string): void {
		// Find the rocketchatId of the user who created this channel
		const creatorId = (roomData.userType === 'rocket.chat' ? this.findUserId(roomData.u) : this.findImportedUserId(roomData.u)) || startedByUserId;

		console.log('insert room by', creatorId);
		const members = roomData.userType === 'rocket.chat' ? roomData.users : roomData.users.map((user) => {
			const obj = Users.findOneByImportId(user, { fields: { username: 1 } });
			// If it's not a direct message, then remove the room creator from the list
			if (roomData.t !== 'd' && obj?._id === creatorId) {
				return false;
			}

			return obj?.username;
		}).filter((user) => user);

		// Create the channel
		try {
			Meteor.runAsUser(creatorId, () => {
				const roomInfo = roomData.t === 'd'
					? Meteor.call('createDirectMessage', ...members)
					: Meteor.call(roomData.t === 'p' ? 'createPrivateGroup' : 'createChannel', roomData.name, members);

				roomData._id = roomInfo.rid;
			});
		} catch (e) {
			console.log(roomData.name, members);
			console.log(e);
			throw e;
		}

		this.updateRoomId(roomData._id, roomData);
	}

	convertChannels(startedByUserId: string): void {
		const channels = ImportData.find({ dataType: 'channel' });
		channels.forEach(({ data: c, _id }: IImportChannelRecord) => {
			try {
				if (!c.name && c.t !== 'd') {
					throw new Error('importer-channel-missing-name');
				}

				c.importIds = c.importIds.filter((item) => item);

				if (!c.importIds.length) {
					throw new Error('importer-channel-missing-import-id');
				}

				let existingRoom;
				if (c._id && c._id.toUpperCase() === 'GENERAL') {
					existingRoom = Rooms.findOneById('GENERAL', {});

					// Prevent the importer from trying to create a new general
					if (!existingRoom) {
						throw new Error('importer-channel-general-not-found');
					}
				} else {
					existingRoom = c.t === 'd' ? Rooms.findDirectRoomContainingAllUsernames(c.users, {}) : Rooms.findOneByNonValidatedName(c.name, {});
				}

				if (existingRoom) {
					this.updateRoom(existingRoom, c, startedByUserId);
				} else {
					this.insertRoom(c, startedByUserId);
				}
			} catch (e) {
				this.saveError(_id, e);
			}
		});
	}

	clearImportData(keepErrors = false): void {
		if (keepErrors) {
			ImportData.model.rawCollection().remove({
				errors: {
					$exists: false,
				},
			});
		} else {
			ImportData.model.rawCollection().remove({});
		}
	}
}