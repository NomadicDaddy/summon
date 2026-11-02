import { describe, expect, test } from 'bun:test';

import { readableError } from '../src/desktop/ipc-error.ts';

/*
 * The real string that prompted this, captured from the running window rather than imagined: saving
 * a teammate whose name was already taken reported Electron's transport wrapper, the Error class
 * name and the actual sentence, in that order, with only the last one addressed to a person.
 */
describe('readableError', () => {
	test('strips the invoke wrapper and the class name', () => {
		expect(
			readableError(
				new Error(
					"Error invoking remote method 'team:save-profile': Error: That teammate already exists.",
				),
			),
		).toBe('That teammate already exists.');
	});

	test('leaves an ordinary message alone', () => {
		expect(readableError(new Error('Choose a registered teammate first.'))).toBe(
			'Choose a registered teammate first.',
		);
	});

	test('does not eat a sentence that merely mentions an error', () => {
		// The guard matters: a message about errors is not a message prefixed by one.
		expect(readableError(new Error('Error log could not be read.'))).toBe(
			'Error log could not be read.',
		);
	});

	test('handles a thrown non-error', () => {
		expect(readableError('plain string failure')).toBe('plain string failure');
	});

	test('strips a wrapper around a message with no class prefix', () => {
		expect(
			readableError(new Error("Error invoking remote method 'team:usage': Nothing to read.")),
		).toBe('Nothing to read.');
	});

	test('a rejection that is not an Error still reads as its text', () => {
		expect(readableError({ toString: () => 'disk full' })).toBe('disk full');
		expect(readableError(undefined)).toBe('undefined');
	});

	test('strips a wrapper whose inner class is not plain Error', () => {
		expect(
			readableError(
				new Error(
					"Error invoking remote method 'team:start': TypeError: Cannot read the session.",
				),
			),
		).toBe('Cannot read the session.');
	});
});
