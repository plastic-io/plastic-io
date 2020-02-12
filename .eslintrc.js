module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    "rules": {
        "@typescript-eslint/no-explicit-any": 0
    },
    plugins: [
        '@typescript-eslint',
    ],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/eslint-recommended',
        'plugin:@typescript-eslint/recommended',
    ],
};