import { describe, expect, test } from 'bun:test';

import type { ModelInfo } from '../src/model-info.ts';

import { memberDetail } from '../src/desktop/member-detail.ts';
import { claudeAccountLabel, memberFacts } from '../src/desktop/member-facts.ts';
import {
	contextCapacityText,
	contextWindowText,
	recordedSettings,
} from '../src/desktop/model-settings.ts';
import { validModelInfo } from '../src/model-info.ts';

/** A record with neither reasoning nor a context window, as a provider that exposes none saves. */
const partial: ModelInfo = {
	model: 'fixture-model-9',
	observedAt: '2026-10-08T19:00:00.000Z',
	provider: 'claude',
	sessionId: 's1',
};
const info: ModelInfo = { ...partial, contextWindow: 262144, reasoning: 'high' };

describe('contextWindowText', () => {
	test('is decimal by default and binary only when that alone gives a whole number', () => {
		expect(contextWindowText(262144)).toBe('256K');
		expect(contextWindowText(1048576)).toBe('1M');
		expect(contextWindowText(200000)).toBe('200K');
		expect(contextWindowText(1000000)).toBe('1M');
		expect(contextWindowText(128000)).toBe('128K');
	});

	test('keeps one decimal only when the value needs it', () => {
		expect(contextWindowText(1500000)).toBe('1.5M');
		expect(contextWindowText(32768)).toBe('32K');
		expect(contextWindowText(131072)).toBe('128K');
	});

	test('the exact form carries the token count so 1M cannot hide which million', () => {
		expect(contextCapacityText(1000000)).toBe('1M (1000000 tokens)');
		expect(contextCapacityText(1048576)).toBe('1M (1048576 tokens)');
		expect(contextCapacityText(undefined)).toBe('capacity not recorded');
	});
});

describe('validModelInfo with a context window', () => {
	test('accepts an absent or positive integer capacity and nothing else', () => {
		expect(validModelInfo(info)).toBe(true);
		expect(validModelInfo({ ...partial, reasoning: 'high' })).toBe(true);
		expect(validModelInfo({ ...info, contextWindow: 0 })).toBe(false);
		expect(validModelInfo({ ...info, contextWindow: -1 })).toBe(false);
		expect(validModelInfo({ ...info, contextWindow: 1.5 })).toBe(false);
		expect(validModelInfo({ ...info, contextWindow: '256K' })).toBe(false);
	});
});

describe('recorded settings', () => {
	test('gives all three values from a full record, capacity with its exact tokens', () => {
		expect(recordedSettings(info)).toEqual({
			capacity: '256K (262144 tokens)',
			model: 'fixture-model-9',
			reasoning: 'high',
		});
	});

	test('names each missing field, so a row of absences says which is which (#8054)', () => {
		expect(recordedSettings(undefined)).toEqual({
			capacity: 'capacity not recorded',
			model: 'model not recorded',
			reasoning: 'reasoning not recorded',
		});
	});

	test('distinguishes a provider that exposes no reasoning from a missing record', () => {
		expect(recordedSettings(partial)).toEqual({
			capacity: 'capacity not recorded',
			model: 'fixture-model-9',
			reasoning: 'reasoning not exposed by provider',
		});
	});
});

describe('member facts (Phillip #7999)', () => {
	const probe = {
		cwd: 'D:/work',
		modelInfo: info,
		name: 'Probe',
		provider: 'claude' as const,
		slug: 'probe',
		status: 'running' as const,
	};
	const account = { ...probe, claudeConfigDir: 'D:/accounts/claude-work' };

	test('lists provider, model, reasoning, capacity, account and directory, unlabelled', () => {
		expect(memberFacts(account)).toEqual([
			'claude',
			'fixture-model-9',
			'high',
			'256K (262144 tokens)',
			'Account: claude-work',
			'D:/work',
		]);
	});

	test('carries no Model, Reasoning or Context capacity label', () => {
		expect(memberFacts(account).join(' ')).not.toMatch(/Model:|Reasoning:|Context capacity:/);
	});

	test('names the inherited account Default, and gives no account outside Claude', () => {
		expect(memberFacts({ ...account, claudeConfigInherited: true })).toContain(
			'Account: Default',
		);
		expect(claudeAccountLabel({ ...account, provider: 'codex' })).toBe('');
		expect(memberFacts({ ...account, provider: 'codex' })).toHaveLength(5);
	});

	test('the session header is the facts on one line, with the account path in its title', () => {
		const detail = memberDetail(account);
		expect(detail.text).toBe(memberFacts(account).join(' · '));
		expect(detail.title.split('\n')).toEqual([
			detail.text,
			'Claude configuration directory: D:/accounts/claude-work. The signed-in identity is managed in Claude.',
		]);
		expect(memberDetail(probe).title).toBe(memberDetail(probe).text);
	});
});
