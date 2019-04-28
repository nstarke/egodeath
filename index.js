var fs = require('fs');
var crypto = require('crypto');
var recast = require('recast');
var estraverse = require('estraverse');
var Window = require('window');
var window = new Window();

var defaults = {};
var props = {};
var keywords = [
  'Array',
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
  'RegExp',
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
];

var globals = {};
function findVal(object, key) {
  var value = false;
  Object.keys(object).some(function(k) {
      if (k === key) {
          value = true;
          return true;
      }
      if (object[k] && typeof object[k] === 'object') {
          value = findVal(object[k], key);
          return value !== undefined;
      }
  });
  return value;
}

var handlers = {
  VariableDeclaration: function (node) {
  },
  ObjectExpression: function (node) {
  },
  Property: function (node) {
    if (globals[node.key.name]) {
      node.key.name = globals[node.key.name];
    } else {
      var replacement = gen();
      globals[node.key.name] = replacement;
      node.key.name = replacement;
    }
  },
  BlockStatement: function (node) {
  },
  BinaryExpression: function(node) {
    if (globals[node.left.name]) {
      node.left.name = globals[node.left.name];
    } else {
      var replacement = gen();
      globals[node.left.name] = replacement;
      node.left.name = replacement;
    }
    if (globals[node.right.name]) {
      node.right.name = globals[node.right.name];
    } else {
      var replacement = gen();
      globals[node.right.name] = replacement;
      node.right.name = replacement;
    }
  },
  Identifier: function(node, parent) {
    // not enough context to
  },
  VariableDeclarator: function(node){
    if (globals[node.id.name]) {
      node.id.name = globals[node.id.name];
    } else {
      var replacement = gen();
      globals[node.id.name] = replacement;
      node.id.name = replacement;
    }
  },
  CallExpression: function(node){
    if (globals[node.callee.name]) {
      node.callee.name = globals[node.callee.name];
    } else {
      var replacement = gen();
      globals[node.callee.name] = replacement;
      node.callee.name = replacement;
    }
    node.arguments.forEach(function(arg){
      if (globals[arg.name]) {
        arg.name = globals[arg.name];
      } else {
        var replacement = gen();
        globals[arg.name] = replacement;
        arg.name = replacement;
      }
    })
  },
  FunctionExpression: function (node) {
    node.params.forEach(function(param){
      if (globals[param.name]) {
        param.name = globals[param.name];
      } else {
        var replacement = gen();
        globals[param.name] = replacement;
        param.name = replacement;
      }
    })
  },
  ReturnStatement: function(node) {
    if (!node.argument) return;
    if (globals[node.argument.name]) {
      node.argument.name = globals[node.argument.name];
    } else {
      var replacement = gen();
      globals[node.argument.name] = replacement;
      node.argument.name = replacement;
    }
  },
  MemberExpression: function (node, parent) {
    var brk = false;
    keywords.forEach(function(keyword){
      var evald = eval(keyword);
      if (findVal(evald, node.object.name)) {
        brk = true;
      }
      if (evald.prototype && !brk) {
        try {
          if (evald.prototype[node.object.name]){
            brk = true;
          }
        } catch (ex){

        }
      }
    })
    if (keywords.indexOf(node.object.name) !== -1) brk = true;
    if (!brk) {
      if (globals[node.object.name]) {
        node.object.name = globals[node.object.name];
      } else {
        var replacement = gen();
        globals[node.object.name] = replacement;
        node.object.name = replacement;
      }
    }
    brk = false;
    keywords.forEach(function(keyword){
      var evald = eval(keyword);
      if (findVal(evald, node.property.name)) {
        brk = true;
      }
      if (evald.prototype && !brk) {
        try {
          if (evald.prototype[node.property.name]){
            brk = true;
          }
        } catch (ex) {

        }
      }
    })
    if (keywords.indexOf(node.property.name) !== -1) brk = true;
    if (!brk) {
      if (globals[node.property.name]) {
        node.property.name = globals[node.property.name];
      } else {
        var replacement = gen();
        globals[node.property.name] = replacement;
        node.property.name = replacement;
      }
    }
  },
  ThisExpression: function (node) {
  },
  ExpressionStatement: function (node) {
  },
  AssignmentExpression: function (node) {
    if (globals[node.left.name]) {
      node.left.name = globals[node.left.name];
    } else {
      var replacement = gen();
      globals[node.left.name] = replacement;
      node.left.name = replacement;
    }
    if (globals[node.right.name]) {
      node.right.name = globals[node.right.name];
    } else {
      var replacement = gen();
      globals[node.right.name] = replacement;
      node.right.name = replacement;
    }
  },
  FunctionDeclaration: function (node) {
    if (globals[node.id.name]) {
      node.id.name = globals[node.id.name];
    } else {
      var replacement = gen();
      globals[node.id.name] = replacement;
      node.id.name = replacement;
    }
    node.params.forEach(function(param){
      if (globals[param.name]) {
        param.name = globals[param.name];
      } else {
        var replacement = gen();
        globals[param.name] = replacement;
        param.name = replacement;
      }
    })
  },
  IfStatement: function (node) {
    if (globals[node.test.name]) {
      node.test.name = globals[node.test.name];
    } else {
      var replacement = gen();
      globals[node.test.name] = replacement;
      node.test.name = replacement;
    }
  },
  UnaryExpression: function (node) {
    if (globals[node.argument.name]) {
      node.argument.name = globals[node.argument.name];
    } else {
      var replacement = gen();
      globals[node.argument.name] = replacement;
      node.argument.name = replacement;
    } 
  },
  SwitchCase: function (node, parent) {
    
  },
  SwitchStatement: function (node) {
    if (!node.discriminant) return;
    if (globals[node.discriminant.name]) {
      node.discriminant.name = globals[node.discriminant.name];
    } else {
      var replacement = gen();
      globals[node.discriminant.name] = replacement;
      node.discriminant.name = replacement;
    } 
  }
}

var code = fs.readFileSync(process.env.INPUT_FILE || 'input.js').toString();
var ast = recast.parse(code);

if (process.env.DEBUG) console.log(JSON.stringify(ast.program));

var used = [];
// first pass
estraverse.traverse(ast.program, {
  enter: function(node, parent) {
    if (handlers[node.type]) handlers[node.type](node, parent);
    if (node.kind && node.kind !== 'var') node.kind = 'var';
  }
});

function gen() {
  return '_'.repeat((crypto.randomBytes(1)[0] % 16) + 1) + crypto.randomBytes((crypto.randomBytes(1)[0] % 16) + 1).toString('hex');
}

ast.program.body = used.concat(ast.program.body);
var trans = recast.print(ast).code;
if (!process.env.DEBUG) console.log(trans);
