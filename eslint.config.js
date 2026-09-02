import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	eslint.configs.recommended,
	{
		ignores: ['node_modules/'],
	},
	...tseslint.configs.strictTypeChecked.map((config) => ({
		...config,
		files: ['**/*.ts'],
	})),
	{
		files: ['**/*.ts'],
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
		},
	},
);
