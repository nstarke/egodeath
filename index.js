var fs = require('fs');
var crypto = require('crypto');
var recast = require('recast');
var estraverse = require('estraverse');
var Window = require('window');
var window = new Window();

var defaults = {};
var props = {};
var keywords = [
  'console',
  'Math',
  'Object',
  'Function',
  'Boolean',
  'Symbol',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Number',
  'Date',
  'Infinity',
  'eval',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
  'String',
  //'RegExp',
  'Array',
  'Int8Array',
  'Uint8Array',,
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'ArrayBuffer',
  'DataView',
  'JSON',
  'Promise',
  'Reflect',
  'Proxy',
  'window',
  'module',
  'exports',
  'require',
  'process'
].forEach(function(item){
  var primaryKey = gen();
  var primaryCode  = 'var ' + primaryKey + ' = ' + item + ';\n';
  defaults[item] = {
    key: item,
    used: false,
    injected: false,
    map: primaryKey,
    ast: recast.parse(primaryCode).program.body.pop(),
    props: {
    }
  }
  var evald = eval(item);
  Object.getOwnPropertyNames(evald).forEach(function(sub){
    var subkey = gen();
    var code = primaryKey + '.' + subkey + ' = ' + primaryKey + '.' + sub + ';\n';
    defaults[item].props[sub] = {
      key: sub,
      used: false,
      injected: false,
      map: subkey,
      ast: recast.parse(code).program.body.pop()
    }
    if (evald.prototype) {
      Object.getOwnPropertyNames(evald.prototype).forEach(function(sub){
        var subkey = gen();
        var code = primaryKey + '.' + subkey + ' = ' + primaryKey + '.' + sub + ';\n';
        defaults[item].props[sub] = {
          key: sub,
          used: false,
          injected: false,
          map: subkey,
          ast: recast.parse(code).program.body.pop()
        }
        });
    }
  })
});

var globals = {};

var handlers = {
  VariableDeclaration: function (node) {
  },
  ObjectExpression: function (node) {
  },
  Property: function (node) {
  },
  BlockStatement: function (node) {
  },
  BinaryExpression: function(node) {
  },
  Identifier: function(node) {
    if (globals[node.name]) {
        node.name = globals[node.name];
      } else {
        var replacement = gen();
        globals[node.name] = replacement;
        node.name = replacement;
      }
  },
  VariableDeclarator: function(node){
    if (globals[node.name]) {
        node.name = globals[node.name];
      } else {
        var replacement = gen();
        globals[node.name] = replacement;
        node.name = replacement;
      }   
       if (globals[node.name]) {
        node.name = globals[node.name];
      } else {
        var replacement = gen();
        globals[node.name] = replacement;
        node.name = replacement;
      }
  },
  CallExpression: function(node){
    if (globals[node.name]) {
        node.name = globals[node.name];
      } else {
        var replacement = gen();
        globals[node.name] = replacement;
        node.name = replacement;
      }
  },
  FunctionExpression: function (node) {
  },
  ReturnStatement: function(node) {
  },
  MemberExpression: function (node) {
  },
  ThisExpression: function (node) {
  },
  ExpressionStatement: function (node) {
  },
  AssignmentExpression: function (node) {
  }
}

var code = fs.readFileSync(process.env.INPUT_FILE || 'input.js').toString();
var ast = recast.parse(code);

if (process.env.DEBUG) console.log(JSON.stringify(ast.program));

var used = [];
// first pass
estraverse.traverse(ast.program, {
  enter: function(node, parent) {
    if (defaults[node.name]) {
      globals[node.name] = defaults[node.name].map;
      used.push(defaults[node.name].ast);
      return;
    }
    if (parent && parent.object && defaults[parent.object.name] && defaults[parent.object.name].props[node.name]) {
      globals[node.name] = defaults[parent.object.name].props[node.name].map;
      used.push(defaults[parent.object.name].props[node.name].ast);
      return;
    }
    if (handlers[node.type]) handlers[node.type](node);
    if (node.kind && node.kind !== 'var') node.kind = 'var';
  }
});

function gen() {
  return '_'.repeat((crypto.randomBytes(1)[0] % 16) + 1) + crypto.randomBytes((crypto.randomBytes(1)[0] % 16) + 1).toString('hex');
}

ast.program.body = used.concat(ast.program.body);
var trans = recast.print(ast).code;
if (!process.env.DEBUG) console.log(trans);
