// 用 var 而不是 const：const 只在脚本作用域，跨脚本读不到（app.js 里 root.PPC_VERSION 会是 undefined）
var PPC_VERSION = '0.1.0';
