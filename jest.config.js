/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  collectCoverageFrom: [
    "src/server/**/*.ts",
    "!src/server/index.ts",
  ],
  coverageDirectory: "coverage",
  // The client tracker targets the DOM and is exercised via the build, not Jest.
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};
