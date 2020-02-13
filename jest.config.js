module.exports = { // eslint-disable-line
    preset: 'ts-jest',
    testEnvironment: 'node',
    collectCoverage: true,
    coverageDirectory: "<rootDir>/docs/coverage",
    collectCoverageFrom: [
      "dist/**/*.js"
    ]
};
