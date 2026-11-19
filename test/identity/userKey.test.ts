import { describe, expect, test } from 'vitest';
import { IDENT, USER_KEY_SECRET } from '#test/fixtures.ts';
import { userKeyWith } from '#server/identity/userKey.ts';

const userKey = userKeyWith(USER_KEY_SECRET);

describe('a user key', () => {
	// The expected keys are from openssl, not from this code:
	//   printf '%s' 10000000001 | openssl dgst -sha256 -hmac "$SECRET" -binary | base64 | tr '+/' '-_' | cut -c1-22
	test('is base64url(HMAC-SHA256(secret, fødselsnummer)), cut to 22 characters', () => {
		expect(userKey('10000000001')).toBe('pvfCn3ybGT9VMf5w3CqfDm');
		expect(userKey('10000000002')).toBe('oRHX62X-AJyeCRomSVTsiL');
	});

	test('is the same every time for the same user', () => {
		expect(userKey(IDENT)).toBe(userKey(IDENT));
	});

	test('is another with another secret', () => {
		expect(userKeyWith('another-secret-of-at-least-32-characters')('10000000001')).toBe('C_kiW9OeY-A_MoFI7-h7Ut');
	});

	test('has nothing of the fødselsnummer in it', () => {
		expect(userKey(IDENT)).not.toContain(IDENT);
		expect(userKey(IDENT)).toMatch(/^[A-Za-z0-9_-]{22}$/);
	});
});
