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
  'window'
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
  Object.getOwnPropertyNames(eval(item)).forEach(function(sub){
    var subkey = gen();
    var code = primaryKey + '.' + subkey + ' = ' + primaryKey + '.' + sub + ';\n';
    defaults[item].props[sub] = {
      key: sub,
      used: false,
      injected: false,
      map: subkey,
      ast: recast.parse(code).program.body.pop()
    }
  })
});

var globals = {};

var handlers = {
  VariableDeclaration: function (node) {
    var self = this;
    node.declarations.forEach(function(dec){
      if (self[dec.type]) {
        self[dec.type](dec)
      }
    });
    if (node.body && this[node.body.type]) this[node.body.type](node.body);
  },
  ObjectExpression: function (node) {
    var self = this;
    node.properties.forEach(function(prop){
      if (self[prop.type]) self[prop.type](prop);
    });
  },
  Property: function (node) {
    if (this[node.key.type]) this[node.key.type](node.key);
    if (this[node.value.type]) this[node.value.type](node.value);
  },
  BlockStatement: function (node) {
    var self = this;
      node.body.forEach(function(b){
        if (self[b.type]) {
          self[b.type](b);
        }
      })
  },
  BinaryExpression: function(node) {
    if (this[node.left.type]) {
      this[node.left.type](node.left);
    }
    if (this[node.right.type]) {
      this[node.right.type](node.right);
     }
  },
  Identifier: function(node) {
    // if (defaults[node.name]) {
    //   node.name = defaults[node.name].map;
    //   return;
    // }
    // if (props[node.name]) {
    //   node.name = props[node.name].map;
    //   return;
    // }
    if (globals[node.name]) {
        node.name = globals[node.name];
      } else {
        var replacement = gen();
        globals[node.name] = replacement;
        node.name = replacement;
      }
  },
  VariableDeclarator: function(node){
    if (this[node.init.type]) this[node.init.type](node.init);
    if (this[node.id.type]) this[node.id.type](node.id);
     // if (defaults[node.name]) {
     //  node.name = defaults[node.name].map;
     //  return
    // }
    // if (props[node.name]) {
     //  node.name = props[node.name].map;
     //  return;
    // }
    if (globals[node.name]) {
        node.name = globals[node.name];
      } else {
        var replacement = gen();
        globals[node.name] = replacement;
        node.name = replacement;
      }    if (globals[node.name]) {
        node.name = globals[node.name];
      } else {
        var replacement = gen();
        globals[node.name] = replacement;
        node.name = replacement;
      }
  },
  CallExpression: function(node){
    if (this[node.callee.type]) this[node.callee.type](node.callee);
    var self = this;
    node.arguments.forEach(function(arg){
      if (self[arg.type]) self[arg.type](arg);
    })

    if (globals[node.name]) {
        node.name = globals[node.name];
      } else {
        var replacement = gen();
        globals[node.name] = replacement;
        node.name = replacement;
      }
  },
  FunctionExpression: function (node) {
    var self = this;
    node.params.forEach(function(param){
      if (self[param.type]) self[param.type](param);
    });
    if (this[node.body.type]) this[node.body.type](node.body);
  },
  ReturnStatement: function(node) {
    if (this[node.argument.type]) this[node.argument.type](node.argument);
  },
  MemberExpression: function (node) {
    if (this[node.object.type]) this[node.object.type](node.object);
    if (this[node.property.type]) this[node.property.type](node.property);
  },
  ThisExpression: function (node) {
  },
  ExpressionStatement: function (node) {
      if (this[node.expression.type]) this[node.expression.type](node.expression);
  },
  AssignmentExpression: function (node) {
    if (this[node.left.type]) this[node.left.type](node.left);
    if (this[node.right.type]) this[node.right.type](node.right);
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
  }
});
ast.program.body.forEach(function(node) {
  if (node.kind && node.kind !== 'var') node.kind = 'var';
  if (handlers[node.type]) handlers[node.type](node);
});
function gen() {
  return '_'.repeat((crypto.randomBytes(1)[0] % 16) + 1) + crypto.randomBytes((crypto.randomBytes(1)[0] % 16) + 1).toString('hex');
}

ast.program.body = used.concat(ast.program.body);
var trans = recast.print(ast).code;
if (!process.env.DEBUG) console.log(trans);
