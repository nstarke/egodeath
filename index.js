var fs = require('fs');
var crypto = require('crypto');
var recast = require('recast');
var estraverse = require('estraverse');
var Window = require('window');
var window = new Window();  
var isVarName = require('is-valid-var-name');
var windowProps = [];
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
  'window',
  'arguments',
  'console',
  'exports',
  'module',
  'require',
  'window.document',
  '"a"',
  '1',
  '["a"]',
  '{a:2}',
  'unescape',
  'decodeURIComponent',
  'decodeURI',
  'encodeURIComponent',
  'encodeURI'
];

var props = ['getPrototypeOf', 'getOwnPropertyNames', 'hasOwnProperty', 'createElement', 'subarray'];
keywords.forEach(function (key ) {
  var evald = eval(key);
  props = props.concat(Object.getOwnPropertyNames(evald));
  if (evald.prototype) props = props.concat(Object.getOwnPropertyNames(evald.prototype));
});  
keywords = keywords.concat(props);

var isKeyword = function(prop){
 return keywords.indexOf(prop) !== -1;
}

var Identifier = function (name) {
 return {"type":"Identifier","name":name}
}

var Literal = function (value) {
  return {
    type: 'Literal',
    value: value
  }
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
function addIdentifiers(){
  var len = crypto.randomBytes(1)[0] % 16;
  var result = [];
  for (var i = 0; i < len; i++){
    result.push(new Identifier(gen()));
  }
  return result;
}

var globals = {}

function substitute(node, ctx) {
  if (!node || !node.name|| node.name === 'undefined') return node;
  var isKey = isKeyword(node.name);
  if (!node.skipped && !isKey) {
    if (globals[node.name]){
      if (ctx &&  ctx[node.name]){
        node.name = ctx[node.name].___val;
      } else {
        node.name = globals[node.name].___val;
      }
    }
  }
}

function traverseNode(node, finalKey) {
    finalKey = finalKey || []
    if (node.object)  {
      if (node.object.name)finalKey.push(node.object.name);
      if (node.property) {
        finalKey.push(node.property.name);
      } else {
        return traverseNode(node.object, finalKey);
      }
    } 
     
    return finalKey;
}

function traverseNodeAddSwap(base, node) {
  base = base || { ___val : gen()};
  if (node.object){
    var name = node.object.name;
    if (!isKeyword(name)){
      substitute(node.object, base);
    }
    if (name === 'document') node.object.name = 'window.document';
    if (node.property)  {
      var name = node.property.name;
      if (!isKeyword(node.property.name) && !node.property.skipped){
       
          substitute(node.property, base);
      } 
    } else {
      traverseNodeAddSwap(base[node.object.name], node.object);
    } 
  }
  return;
}

var descend = function( base, names ) {
  for( var i = 0; i < names.length; i++ ) { 
    base = base[ names[i] ] = base[ names[i] ] || {___val: gen()};
  }
}

var firstPassHandlers = {
  VariableDeclaration: function (node) {
    return node;
  },
  ObjectExpression: function (node) {
    return node;
  },
  Property: function (node) {
    return node;
  },
  BlockStatement: function (node) {
    return node;
  },
  ForInStatement: function (node) {
    return node;
  },
  LogicalExpression: function (node) {
    return node;
  },
  BinaryExpression: function(node) {
    return node;
  },
  Identifier: function(node, parent) {
    globals[node.name] = globals[node.name] || { ___val: gen() }
    return node;
  },
  VariableDeclarator: function(node, parent){
    return node;
  },
  NewExpression: function (node) {
    return node;
  },
  CallExpression: function(node){
    return node;
  },
  FunctionExpression: function (node) {
    return node;
  },
  ReturnStatement: function(node) {
    return node;
  },
  MemberExpression: function (node, parent) {
    var keys = traverseNode(node);
    descend(globals, keys);
  },
  ThisExpression: function (node) {
    return node;
  },
  ExpressionStatement: function (node) {
    return node;
  },
  UpdateExpression: function (node) {
    return node;
  },
  AssignmentExpression: function (node) {
    if (node.left  && node.left.object && node.left.object.name === 'window') {
      if (node.left.property.name) {
        globals[node.left.property.name] = globals[node.left.property.name] || { ___val: gen() }
        windowProps.push(node.left.property.name);
      }
    } 
    return node;
  },
  FunctionDeclaration: function (node) {
    return node;
  },
  IfStatement: function (node) {
    return node;
  },
  UnaryExpression: function (node) {
    return node;
  },
  SwitchCase: function (node, parent) {
    return node;
  },
  SwitchStatement: function (node) {
    return node;
  },
  ConditionalExpression: function (node) {
    return node;
  },
  Program: function(node) {
    return node;
  },
  Literal: function (node) {
    return node;
  },
  ThrowStatement: function (node) {
    return node;
  },
  Directive: function (node){
    return node;
  }
}
var secondPassHandlers = {
  VariableDeclaration: function (node) {
    return node;
  },
  ObjectExpression: function (node) {
    
    return node;
  },
  Property: function (node) {
    substitute(node.key);
    substitute(node.value);
      return node;
  },
  ForStatement: function (node) {
    substitute(node.init);
    substitute(node.test);
    substitute(node.update);
    return node;
  },
  BlockStatement: function (node) {
    return node;
  },
  ForInStatement: function (node) {
    substitute(node.left);
    substitute(node.right); 
    return node;
  },
  LogicalExpression: function (node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },
  BinaryExpression: function(node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },
  Identifier: function(node, parent) {
    return node;
  },
  VariableDeclarator: function(node){
      substitute(node.id);
    substitute(node.init);
    return node;
  },
  NewExpression: function (node) {
    substitute(node.callee);
    node.arguments.forEach(substitute);
    return node;
  },
  CallExpression: function(node){
    substitute(node.callee);
    node.arguments.forEach(substitute);
    return node;
  },
  FunctionExpression: function (node) {
    node.params.forEach(substitute);
    return node;
  },
  ReturnStatement: function(node) {
    substitute(node.argument);
    return node;
  },
  MemberExpression: function (node, parent) {
    traverseNodeAddSwap(globals, node);
    return node;
    
  },
  ThisExpression: function (node) {
    return node;
  },
  ExpressionStatement: function (node) {
    return node;
  },
  UpdateExpression: function (node) {
    substitute(node.argument);
    return node;
  },
  AssignmentExpression: function (node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },
  FunctionDeclaration: function (node) {
    substitute(node.id);
    node.params.forEach(substitute);
    return node;
  },
  IfStatement: function (node) {
    substitute(node.test);
    return node;
  },
  UnaryExpression: function (node) {
    substitute(node.argument);
    return node;
  },
  SwitchCase: function (node, parent) {
    return node;
  },
  SwitchStatement: function (node) {
    substitute(node.discriminant);
    return node;
  },
  ConditionalExpression: function (node) {
    substitute(node.alternate);
    substitute(node.test);
    substitute(node.consequent);
    return node;
  },
  Program: function(node) {
    return node;
  },
  Literal: function (node) {
    return node;
  },
  ThrowStatement: function (node) {
    return node;
  },
  Directive: function (node){
    return node;
  },
  DoWhileStatement: function( node){
    substitute(node.test);
    substitute(node.body);
    return node;
  },
  ArrayExpression: function (node) {
    node.elements.forEach(substitute);
  }
}
var thirdPassHandlers = {
  VariableDeclaration: function (node) {
    return node;
  },
  ObjectExpression: function (node) {
    return node;
  },
  Property: function (node) {
    return node;
  },
  BlockStatement: function (node) {
    return node;
  },
  ForInStatement: function (node) {
    return node;
  },
  LogicalExpression: function (node) {
    return node;
  },
  BinaryExpression: function(node) {
    return node;
  },
  Identifier: function(node, parent) {
    return node;
  },
  VariableDeclarator: function(node){
   
    return node;
  },
  NewExpression: function (node) {
      return node;
  },
  CallExpression: function(node){
    return node;
  },
  FunctionExpression: function (node) {
    node.params = node.params.concat(addIdentifiers());
    return node;
  },
  ReturnStatement: function(node) {
    return node;
  },
  MemberExpression: function (node, parent) {
    return node;
    
  },
  ThisExpression: function (node) {
    return node;
  },
  ExpressionStatement: function (node) {
    return node;
  },
  UpdateExpression: function (node) {
    return node;
  },
  AssignmentExpression: function (node) {
    return node;
  },
  FunctionDeclaration: function (node) {
    node.params = node.params.concat(addIdentifiers());
    return node;
  },
  IfStatement: function (node) {
    return node;
  },
  UnaryExpression: function (node) {
    return node;
  },
  SwitchCase: function (node, parent) {
    return node;
  },
  SwitchStatement: function (node) {
    return node;
  },
  ConditionalExpression: function (node) {
    return node;
  },
  Program: function(node) {
    return node;
  },
  Literal: function (node) {
    return node;
  },
  ThrowStatement: function (node) {
    return node;
  },
  Directive: function (node){
    return node;
  }
}
var code = fs.readFileSync(process.env.INPUT_FILE || 'input.js').toString();
var ast = recast.parse(code);
if (process.env.DEBUG) console.log(JSON.stringify(ast.program));
    // First Pass
estraverse.traverse(ast.program, {
  enter: function(node, parent) {
    if (!firstPassHandlers[node.type]) return node;
    var node = firstPassHandlers[node.type](node, parent);
  }
});

// Second Pass
estraverse.traverse(ast.program, {
  enter: function(node, parent) {
    if (!secondPassHandlers[node.type]) return node;
    var node = secondPassHandlers[node.type](node, parent);
  }
});

// third Pass
estraverse.traverse(ast.program, {
  enter: function(node, parent) {
    if (node.comments) delete node.comments;
    if (!thirdPassHandlers[node.type]) return node;
    var node = thirdPassHandlers[node.type](node, parent);
  }
});

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

//ast.program.body = consoleKeywords.concat(ast.program.body);

var trans = recast.print(ast).code;
if (!process.env.DEBUG) console.log(trans);
