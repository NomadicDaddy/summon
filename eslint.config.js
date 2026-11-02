import eslint from '@eslint/js';
import perfectionist from 'eslint-plugin-perfectionist';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

const noDefaultExportPlugin = {
	rules: {
		'no-default-export': {
			create(context) {
				return {
					ExportDefaultDeclaration(node) {
						context.report({ message: 'Prefer named exports.', node });
					},
				};
			},
			meta: { schema: [], type: 'suggestion' },
		},
	},
};

// eslint-disable-next-line import/no-default-export
export default tseslint.config(
	eslint.configs.recommended,
	{
		// .aidd/ holds retained audit evidence (reports, snapshots, probes), never application code.
		ignores: ['node_modules/', 'dist/', '.aidd/'],
	},
	...tseslint.configs.strictTypeChecked.map((config) => ({
		...config,
		files: ['**/*.{ts,tsx,js,jsx}'],
	})),
	{
		files: ['**/*.{ts,tsx,js,jsx}'],
		plugins: {
			import: noDefaultExportPlugin,
			perfectionist,
			'unused-imports': unusedImports,
		},
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-confusing-void-expression': 'off',
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
			eqeqeq: ['error', 'always'],
			'import/no-default-export': 'error',
			'perfectionist/sort-imports': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-named-imports': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'unused-imports/no-unused-imports': 'error',
		},
	},
	{
		files: ['**/*.{js,jsx}'],
		extends: [tseslint.configs.disableTypeChecked],
	},
);
