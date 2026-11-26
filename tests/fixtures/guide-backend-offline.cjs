// Only for the local dry-run integration test. Any external call is a test failure.
globalThis.fetch = async () => { throw new Error('External network forbidden by website dry-run integration test'); };
