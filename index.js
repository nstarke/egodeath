var fs = require('fs');
var crypto = require('crypto');
var recast = require('recast');
var estraverse = require('estraverse');
var Window = require('window');
var window = new Window();  
var isVarName = require('is-valid-var-name');
var consoleKeywords = [
  'assert',
  'clear',
  'count',
  'error',
  'group',
  'groupCollapsed',
  'groupEnd',
  'info',
  'log',
  'table',
  'time',
  'timeEnd',
  'trace',
  'warn'
].map(function(consoleKeyword){
  return recast.parse('console.' + consoleKeyword + ' = function (){};\n').program.body.pop();
});

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
  'process',
  'window'
];

var windowProps = {}

var Identifier = function (name) {
 return {"type":"Identifier","name":name}
}

var ArrayExpression = function () {
  return { 
    type: 'ArrayExpression',
    elements: []
  }
}

var ObjectExpression = function () {
  return { 
    type: 'ObjectExpression',
    properties: []
  }
}

var Literal = function (value) {
  return {
    type: 'Literal',
    value: value
  }
}

function generateGlobalVarDecl(name, swap) {
  var code = "var " + swap + " = window." + name + ';\n';
  return recast.parse(code).program.body.pop();
}

function generateRandomLiterals() {
  var len = crypto.randomBytes(1)[0] % 16;
  var result = [];
  for (var i = 0; i < len; i++){
    result.push(new Literal([true, false, Math.floor(Math.random() * 10), Math.random(), gen()].choose()));
  }
  return result;
}

Array.prototype.choose = function (){
  return this[(crypto.randomBytes(1))[0] % this.length];
}

Array.prototype.shuffle = function() {
  var i = this.length, j, temp;
  if ( i == 0 ) return this;
  while ( --i ) {
     j = Math.floor( Math.random() * ( i + 1 ) );
     temp = this[i];
     this[i] = this[j];
     this[j] = temp;
  }
  return this;
}

function ensureNotKeyword(testee){
  var brk = false;
  if ((testee.name) === 'undefined') return true;
  if (keywords.indexOf(testee.name) !== -1) brk = true;
    if (!brk) {
      keywords.forEach(function(keyword){
        try {
          var evald = eval(keyword);
          if (evald[testee.name]) brk = true;
          if (findKey(evald, testee.name)) {
            brk = true;
          }
          if (!brk && evald.prototype) {
              if (evald.prototype[testee.name]){
                brk = true;
              }
          
          }
        } catch (ex){
          brk = true;
        }
      })
    }
    return brk;
}

function addIdentifiers(){
  var len = crypto.randomBytes(1)[0] % 16;
  var result = [];
  for (var i = 0; i < len; i++){
    result.push(new Identifier(gen()));
  }
  return result;
}

var globals = {};
function findKey(object, key) {
  var value = false;
  if (!object) return true;
  Object.keys(object).some(function(k) {
      if (k === key) {
          value = true;
          return true;
      }
      if (object[k] && typeof object[k] === 'object') {
          value = findKey(object[k], key);
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
    if (node.key) {
      var brk = ensureNotKeyword(node.key);
      if (!brk) {
        if (globals[node.key.name]) {
          node.key.name = windowProps[node.key.name] ||globals[node.key.name];
        } else {
          var replacement = gen();
          globals[node.key.name] = replacement;
          node.key.name = replacement;
        }
      }
    }
    if (node.value) {
      var brk = ensureNotKeyword(node.value);
      if (!brk) {
        if (globals[node.value.name]) {
          node.value.name = windowProps[node.key.name] ||globals[node.value.name];
        } else {
          var replacement = gen();
          globals[node.value.name] = replacement;
          node.value.name = replacement;
        }
      }
    }
  },
  BlockStatement: function (node) {
  },
  ForInStatement: function (node) {
    if (!node.left) return;
    var brk = ensureNotKeyword(node.left);
    if (node.left){
      if (!brk) {
        if (globals[node.left.name]) {
          node.left.name = windowProps[node.left.name] ||globals[node.left.name];
        } else {
          var replacement = gen();
          globals[node.left.name] = replacement;
          node.left.name = replacement;
        }
      }
    }
    if (!node.right) return;
    brk = ensureNotKeyword(node.right);
    if (node.right){
      if (!brk){
        if (globals[node.right.name]) {
          node.right.name = windowProps[node.right.name] || globals[node.right.name];
        } else {
          var replacement = gen();
          globals[node.right.name] = replacement;
          node.right.name = replacement;
        }
      }
    }
  },
  LogicalExpression: function (node) {
    var brk = ensureNotKeyword(node.left);
    if (node.left){
      if (!brk) {
        if (globals[node.left.name]) {
          node.left.name = windowProps[node.left.name] || globals[node.left.name];
        } else {
          var replacement = gen();
          globals[node.left.name] = replacement;
          node.left.name = replacement;
        }
      }
    }
    
    brk = ensureNotKeyword(node.right);
    if (node.right){
      if (!brk){
        if (globals[node.right.name]) {
          node.right.name = windowProps[node.right.name] || globals[node.right.name];
        } else {
          var replacement = gen();
          globals[node.right.name] = replacement;
          node.right.name = replacement;
        }
      }
    }
  },
  BinaryExpression: function(node) {
    var brk = ensureNotKeyword(node.left);
    if (node.left){
      if (!brk) {
        if (globals[node.left.name]) {
          node.left.name = windowProps[node.left.name] || globals[node.left.name];
        } else {
          var replacement = gen();
          globals[node.left.name] = replacement;
          node.left.name = replacement;
        }
      }
    }
    
    brk = ensureNotKeyword(node.right);
    if (node.right){
      if (!brk){
        if (globals[node.right.name]) {
          node.right.name = windowProps[node.right.name] || globals[node.right.name];
        } else {
          var replacement = gen();
          globals[node.right.name] = replacement;
          node.right.name = replacement;
        }
      }
    }
  },
  Identifier: function(node, parent) {
  },
  VariableDeclarator: function(node){
    if (node.id) {
      var brk = ensureNotKeyword(node.id);
      if (!brk) {
        if (globals[node.id.name]) {
          node.id.name = windowProps[node.id.name] || globals[node.id.name];
        } else {
          var replacement = gen();
          globals[node.id.name] = replacement;
          node.id.name = replacement;
        }
      }
    }
    
    if (node.init){
      brk = ensureNotKeyword(node.init);
      if (!brk){
        if (globals[node.init.name]) {
          node.init.name = windowProps[node.init.name] || globals[node.init.name];
        } else {
          var replacement = gen();
          globals[node.init.name] = replacement;
          node.init.name = replacement;
        }
      }
    }
  },
  NewExpression: function (node) {
    if (!node.callee) return;
    var brk = ensureNotKeyword(node.callee);
    if (node.callee){
      if (!brk) {
        if (globals[node.callee.name]) {
          node.callee.name = windowProps[node.callee.name] ||globals[node.callee.name];
        } else {
          var replacement = gen();
          globals[node.callee.name] = replacement;
          node.callee.name = replacement;
        }
      }
    }
    if (!node.callee) return;
    node.arguments.forEach(function(arg){
      if (windowProps[arg.name]) {
       return arg.name = globals[arg.name];
      }
      brk = ensureNotKeyword(arg);
      if (arg.name){
        if (!brk){
          if (globals[arg.name]) {
            arg.name = windowProps[arg.name] || globals[arg.name];
          } else {
            var replacement = gen();
            globals[arg.name] = replacement;
            arg.name = replacement;
          }
        }
      }
    })
    if (node.callee.name !== 'RegExp') node.arguments = node.arguments.concat(generateRandomLiterals());
  },
  CallExpression: function(node){
    var brk = ensureNotKeyword(node.callee);
    if (node.callee){
      if (!brk) {
        if (globals[node.callee.name]) {
          node.callee.name = windowProps[node.callee.name] ||globals[node.callee.name];
        } else {
          var replacement = gen();
          globals[node.callee.name] = replacement;
          node.callee.name = replacement;
        }
      }
    }
    node.arguments.forEach(function(arg){
      if (windowProps[arg.name]) {
        return arg.name = windowProps[arg.name] || globals[arg.name];
      }
      brk = ensureNotKeyword(arg);
      if (arg.name){
        if (!brk){
          if (globals[arg.name]) {
            arg.name = globals[arg.name];
          } else {
            var replacement = gen();
            globals[arg.name] = replacement;
            arg.name = replacement;
          }
        }
      }
    })
    node.arguments = node.arguments.concat(generateRandomLiterals());
  },
  FunctionExpression: function (node) {
    if (!node.params) return;
    node.params.forEach(function(param){
      var brk = ensureNotKeyword(param);
      if (!brk) {
        if (globals[param.name]) {
          param.name = windowProps[param.name] || globals[param.name];
        } else {
          var replacement = gen();
          globals[param.name] = replacement;
          param.name = replacement;
        }
      }
    })
    node.params = node.params.concat(addIdentifiers());
  },
  ReturnStatement: function(node) {
    if (!node.argument) return;
    var brk = ensureNotKeyword(node.argument);
    if (!brk) {
      if (globals[node.argument.name]) {
        node.argument.name = windowProps[node.argument.name] || globals[node.argument.name];
      } else {
        var replacement = gen();
        globals[node.argument.name] = replacement;
        node.argument.name = replacement;
      }
    }
  },
  MemberExpression: function (node, parent) {
    var brk = false;
    brk = ensureNotKeyword(node.object);
    if (!node.object) brk = true;
    if (node.object.name === 'window') {
    var rando = gen();
      if (windowProps[node.property.name]){
        node.object.name = windowProps[node.property.name].swap;
      } else {
        windowProps[node.property.name] = { name: node.property.name, swap: rando }
        globals[node.property.name] = node.property.name;
      }
      brk = true;
    }
    if (windowProps[node.property.name]){
      var name = windowProps[node.property.name].swap;
      node.property.name = name;
      parent = node;
    }   
    if (!brk) {
      if (globals[node.object.name]) {
        node.object.name = windowProps[node.object.name] || globals[node.object.name];
      } else {
        var replacement = gen();
        globals[node.object.name] = replacement;
        node.object.name = replacement;
      }
    }

    if (!node.property) return;
    brk = ensureNotKeyword(node.property);
    if (windowProps[node.property.name]) {
      
    }
    if (!brk) {
      if (globals[node.property.name]) {
        node.property.name = windowProps[node.property.name] || globals[node.property.name];
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
  UpdateExpression: function (node) {
    if (!node.argument) return;
    var brk = ensureNotKeyword(node.argument);
    if (!brk) {
      if (globals[node.argument.name]) {
        node.argument.name = windowProps[node.argument.name] || globals[node.argument.name];
      } else {
        var replacement = gen();
        globals[node.argument.name] = replacement;
        node.argument.name = replacement;
      }
    }
  },
  AssignmentExpression: function (node) {
    var brk = ensureNotKeyword(node.left);
    if (!node.left) brk = true;
    if (!brk) {
      if (globals[node.left.name]) {
        node.left.name = windowProps[node.left.name] || globals[node.left.name];
      } else {
        var replacement = gen();
        globals[node.left.name] = replacement;
        node.left.name = replacement;
      }
    }
    if (!node.right) return;
    brk = ensureNotKeyword(node.right);
    if (!brk) {
      if (globals[node.right.name]) {
        node.right.name   = windowProps[node.right.name] || globals[node.right.name];
      } else {
        var replacement = gen();
        globals[node.right.name] = replacement;
        node.right.name = replacement;
      }
    }
  },
  FunctionDeclaration: function (node) {
    if (!node.id) brk = true;
    var brk = ensureNotKeyword(node.id);
    if (!brk) {
      if (globals[node.id.name]) {
        node.id.name = windowProps[node.id.name] || globals[node.id.name];
      } else {
        var replacement = gen();
        globals[node.id.name] = replacement;
        node.id.name = replacement;
      }
    }
    brk = false;
    node.params.forEach(function(param){
      brk = ensureNotKeyword(param.name);
      if (!brk) {
        if (globals[param.name]) {
          param.name = windowProps[param.name] || globals[param.name];
        } else {
          var replacement = gen();
          globals[param.name] = replacement;
          param.name = replacement;
        }
      }
    })
    node.params = node.params.concat(addIdentifiers());
  },
  IfStatement: function (node) {
    if (!node.test) return;
    var brk = ensureNotKeyword(node.test);
    if (!brk){
      if (globals[node.test.name]) {
        node.test.name = windowProps[node.test.name] ||globals[node.test.name];
      } else {
        var replacement = gen();
        globals[node.test.name] = replacement;
        node.test.name = replacement;
      }
    }
  },
  UnaryExpression: function (node) {
    if (!node.argument) return;
    var brk = ensureNotKeyword(node.argument);
    if (!brk) {
      if (globals[node.argument.name]) {
        node.argument.name = windowProps[node.argument.name] ||globals[node.argument.name];
      } else {
        var replacement = gen();
        globals[node.argument.name] = replacement;
        node.argument.name = replacement;
      } 
    }
  },
  SwitchCase: function (node, parent) {
    
  },
  SwitchStatement: function (node) {
    if (!node.discriminant) return;
    var brk = ensureNotKeyword(node.discriminant);
    if (!brk) {
      if (globals[node.discriminant.name]) {
        node.discriminant.name = windowProps[node.discriminant.name] || globals[node.discriminant.name];
      } else {
        var replacement = gen();
        globals[node.discriminant.name] = replacement;
        node.discriminant.name = replacement;
      } 
    }
  },
  ConditionalExpression: function (node) {
    var brk = ensureNotKeyword(node.test);
    if (!node.test) brk = true;
    if (!brk) {
      if (globals[node.test.name]) {
        node.test.name = windowProps[node.test.name] || globals[node.test.name];
      } else {
        var replacement = gen();
        globals[node.test.name] = replacement;
        node.test.name = replacement;
      } 
    }
    brk = ensureNotKeyword(node.consequent);
    if (!node.consequent) brk = true;
    if (!brk) {
      if (globals[node.consequent.name]) {
        node.consequent.name = windowProps[node.consequent.name] || globals[node.consequent.name];
      } else {
        var replacement = gen();
        globals[node.consequent.name] = replacement;
        node.consequent.name = replacement;
      } 
    }

    brk = ensureNotKeyword(node.alternate);
    if (!node.alternate) brk = true;
    if (!brk) {
      if (globals[node.alternate.name]) {
        node.alternate.name = windowProps[node.alternate.name] || globals[node.alternate.name];
      } else {
        var replacement = gen();
        globals[node.alternate.name] = replacement;
        node.alternate.name = replacement;
      } 
    }
  }
}

var code = fs.readFileSync(process.env.INPUT_FILE || 'input.js').toString();
var ast = recast.parse(code);
if (process.env.DEBUG) console.log(JSON.stringify(ast.program));

// First Pass
estraverse.traverse(ast.program, {
  enter: function(node, parent) {
    if (node.comments && node.comments.length){
      delete node.comments;
    }
    if (handlers[node.type]) handlers[node.type](node, parent);
    if (node.kind && node.kind !== 'var') node.kind = 'var';
  }
});

ast.program.body = consoleKeywords.concat(ast.program.body);

function gen() {
  var len = (crypto.randomBytes(1)[0] % 24) + 1
  var start ="";
  
  for (var i = 0; i < len; i++){
    var val = "1";
    while (!isVarName(val)){
       val = String.fromCharCode(parseInt(crypto.randomBytes(2).toString('hex'), 16))
    }
      start += val;
  }
 
  return start;
}
var windowDecl = Object.keys(windowProps).map (function(windowProp){
  var prop = windowProps[windowProp];
  return generateGlobalVarDecl(prop.name, prop.swap);
});
ast.program.body = windowDecl.concat(ast.program.body);
var trans = recast.print(ast).code;
if (!process.env.DEBUG) console.log(trans);
