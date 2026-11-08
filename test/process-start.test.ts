import { expect, test } from 'bun:test';

import { windowsStart } from '../src/process-start.ts';

test('Windows start probe uses CIM when Get-Process StartTime is inaccessible', async () => {
	const started = await windowsStart(25180, (script) => {
		if (script.includes('Get-Process')) throw new Error('Access denied to StartTime');
		expect(script).toContain("Get-CimInstance Win32_Process -Filter 'ProcessId=25180'");
		expect(script).toContain('CreationDate.ToUniversalTime()');
		return Promise.resolve('1794099958000\n');
	});
	expect(started).toBe(1794099958000);
});
