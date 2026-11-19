import { createHmac } from 'node:crypto';

// 22 characters of base64url are 132 bits: far more than it takes to keep every user apart, while still being short enough to make sense for a payload
const LENGTH = 22;

/** Creates a UserKey from a fødselsnummer */
export type UserKey = (ident: string) => string;

/** A stable name for a user that isn't the fødselsnummer */
export const userKeyWith =
	(secret: string): UserKey =>
	(ident) =>
		createHmac('sha256', secret).update(ident).digest('base64url').slice(0, LENGTH);
