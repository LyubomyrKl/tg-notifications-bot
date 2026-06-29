/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testMatch: ['**/*.spec.ts'],
  moduleNameMapper: {
    '^@paedavic/config$': '<rootDir>/../../config/src/index.ts',
    '^@paedavic/contracts$': '<rootDir>/../../contracts/src/index.ts',
    '^@paedavic/database$': '<rootDir>/../../database/src/index.ts',
    '^@paedavic/telegram$': '<rootDir>/../../telegram/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
};
