// 用 var 而不是 const：const 只在脚本作用域，跨脚本读不到（app.js 里 root.PPC_VERSION 会是 undefined）
// 0.2.0：样式一键切换、引文导航、补入未引文献、诊断包、文献表悬挂缩进
var PPC_VERSION = '0.2.0';
