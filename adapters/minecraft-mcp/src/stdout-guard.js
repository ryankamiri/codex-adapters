// stdout is the MCP JSON-RPC channel — NOTHING else may write to it. Libraries
// we embed (prismarine-viewer logs "web server running", etc.) use console.log,
// so reroute it (and info/debug) to stderr. Import this module FIRST.
console.log = (...a) => console.error(...a);
console.info = (...a) => console.error(...a);
console.debug = (...a) => console.error(...a);
