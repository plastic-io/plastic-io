module.exports = { // eslint-disable-line
    preset: 'ts-jest',
    testEnvironment: 'node',
    collectCoverage: true,
    coverageDirectory: "<rootDir>/build/coverage",
    collectCoverageFrom: [
      "dist/**/*.js"
    ]
};
