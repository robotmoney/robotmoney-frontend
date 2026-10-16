// Test preload: the SDK is pure compute and must never call the network.
// Replacing fetch with a thrower turns an accidental call into a red test.
globalThis.fetch = (() => {
  throw new Error("analyst-sdk tests must not use the network (globalThis.fetch is a thrower)");
}) as unknown as typeof fetch;
