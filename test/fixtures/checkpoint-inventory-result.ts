if (process.env.SUMMON_TEST_OFFLINE !== '1')
	throw new Error('Isolated inventory fixture required.');
process.stdout.write(process.env.SUMMON_TEST_INVENTORY ?? '');
process.exitCode = Number(process.env.SUMMON_TEST_INVENTORY_EXIT ?? '0');
