// CommonJS shim so Vite can import node:sqlite without builtins detection issues
// node:sqlite is experimental in Node 22+ and not listed in require('module').builtinModules
module.exports = require('node:sqlite');
