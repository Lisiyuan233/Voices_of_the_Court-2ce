/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/unit/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    // Timeline modules ported from 1.x use NodeNext-style './x.js' relative
    // imports; strip the extension so jest resolves the .ts sources.
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1'
    },
    clearMocks: true,
};
