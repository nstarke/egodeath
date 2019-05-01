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
  'argument',
  '"longassstringthatshouldneverevereverexist"',
  1,
  false
];

var checkObjectProp = function(prop){
 return keywords.some(function(key){
   var ret = false;
    var evald = eval(key);
    try {
      ret = evald[node];
    } catch (ex){
      ret = true;
    }
    if (evald.prototype){
      try {
        ret = evald.prototype[prop];
      } catch (ex){
        ret = true;
      }
    }
    return ret;
  });
}

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

function generateGlobalDecl(name, swap) {
  var code = "var " + swap + ' = ' + name + ';\n';
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
  return findKey(window, testee.name);
}

function addIdentifiers(){
  var len = crypto.randomBytes(1)[0] % 16;
  var result = [];
  for (var i = 0; i < len; i++){
    result.push(new Identifier(gen()));
  }
  return result;
}

var globals = {'toString':{ __val: gen(), mapped: true }, 'hasOwnProperty':{ __val: gen(), mapped: true }, 'module':{ __val: gen(), mapped: true }, 'factory':{ __val: gen(), mapped: true }, 'global': { __val: gen(), mapped: true }, 'exports': { __val: gen(), mapped: true } };
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

function substitute(node, key) {
  if (node.name === 'undefined') return node;
  if ( keywords.indexOf(node.name) !== -1) {
    return node;
  }
  if (!node.swapped) {
    if (globals[node.name] && !globals[node.name].mapped)
      node.name = globals[node.name].___val;
  }
}

function traverseNode(node, finalKey) {
    finalKey = finalKey || []
    node.mapped = true;
    if (node.object)  {
      finalKey.push(node.object.name);
      return traverseNode(node.object, finalKey);
    } 
     if (node.property) {
      finalKey.push(node.property.name);
      return traverseNode(node.object, finalKey);
    }
    return finalKey;
}

function traverseNodeAddSwap(node, finalKey) {
  finalKey = finalKey || []
  node.swapped = true;
  if (node.object )  {
     traverseNodeAddSwap(node.object, finalKey);
  } 
  if (node.property) traverseNodeAddSwap(node.property, finalKey);
  return finalKey;
}
function traverseNodeSwap(base, node) {
  if (!node) return null;
  if (node.object) {
    if (node.object.name === 'arguments') {
      node.object.swapped = true;
      return;
    } 
    var name = node.object.name;
    if (base[name]){
      node.swapped = true;
      node.object.name = base[name].___val;
      traverseNodeSwap(base[name], node.object)
    }
  }
  if (node.property ) {
    if (checkObjectProp(node.property.name)) {
      node.property.swapped = true;
      return node;
    }
    var name = node.property.name;
    if (base[name]){
      node.swapped = true;
      node.property.name = base[name].___val;
      traverseNodeSwap(base[name], node.property)
    }
  }
  
  return node;
}

function traverseNodeSwapArg(base, node) {
  if (!node) return null;
  if (node.object) {
    if (node.object.name === 'arguments') {
      node.object.swapped = true;
    } else {
      var name = node.object.name;
      if (base[name]){
        node.swapped = true;
        node.object.name = base[name].___val;
        traverseNodeSwapArg(base[name], node.object)
      }
    }
  }
  if (node.property ) {
    if (checkObjectProp(node.property.name)) {
      node.property.swapped = true;
      return node;
    }
    var name = node.property.name;
    if (base[name]){
      node.swapped = true;
      node.property.name = base[name].___val;
      traverseNodeSwapArg(base[name], node.property)
    }
  }
  
  return node;
}
var descend = function( base, names ) {
  for( var i = 0; i < names.length; i++ ) { 
    base = base[ names[i] ] = base[ names[i] ] || {___val: gen()};
  }
}

var descendSwap = function( base, node ) {
  for( var i = 0; i < names.length; i++ ) { 
    if (base[names[i]]){
      console.log(names[i], node)
    }
    //base = base[ names[i] ] = base[ names[i] ] || {___val: gen()};
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
    if (!node.mapped) {
      globals[node.name] = { ___val: gen() }
    }
    //substitute(node, node.name);
    return node;
  },
  VariableDeclarator: function(node){
    return node;
  },
  NewExpression: function (node) {
    return node;
    //if (node.callee.name !== 'RegExp') node.arguments = node.arguments.concat(generateRandomLiterals());
  },
  CallExpression: function(node){
    return node;
    //node.arguments = node.arguments.concat(generateRandomLiterals());
  },
  FunctionExpression: function (node) {
    return node;
  },
  ReturnStatement: function(node) {
    return node;
  },
  MemberExpression: function (node, parent) {
    var keys = traverseNode(node);
    keys = keys.reverse();
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
    substitute(node, node.name);
    return node;
  },
  VariableDeclarator: function(node){
    return node;
  },
  NewExpression: function (node) {
    return node;
    //if (node.callee.name !== 'RegExp') node.arguments = node.arguments.concat(generateRandomLiterals());
  },
  CallExpression: function(node){
    return node;
    //node.arguments = node.arguments.concat(generateRandomLiterals());
  },
  FunctionExpression: function (node) {
    return node;
  },
  ReturnStatement: function(node) {
    return node;
  },
  MemberExpression: function (node, parent) {
    var keys = traverseNode(node).reverse();
    if (keys.some(function(k){return keywords.indexOf(k) === -1})){
      traverseNodeSwap(globals, node);
    } else{
        traverseNodeAddSwap(node);
      }
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
    //substitute(node, node.name);
    return node;
  },
  VariableDeclarator: function(node){
    return node;
  },
  NewExpression: function (node) {
    return node;
    //if (node.callee.name !== 'RegExp') node.arguments = node.arguments.concat(generateRandomLiterals());
  },
  CallExpression: function(node){
    return node;
    //node.arguments = node.arguments.concat(generateRandomLiterals());
  },
  FunctionExpression: function (node) {
    node.params = node.params.concat(addIdentifiers());
    return node;
  },
  ReturnStatement: function(node) {
    return node;
  },
  MemberExpression: function (node, parent) {
    //var keys = traverseNode(node);
    //node.name = descendValue(globals, keys.reverse());
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
    // if (node.comments && node.comments.length){
    //   delete node.comments;
    // }
    if (!firstPassHandlers[node.type]) return node;
    var node = firstPassHandlers[node.type](node, parent);
  }
});

// Second Pass
estraverse.traverse(ast.program, {
  enter: function(node, parent) {
    // if (node.comments && node.comments.length){
    //   delete node.comments;
    // }
    if (!secondPassHandlers[node.type]) return node;
    var node = secondPassHandlers[node.type](node, parent);
  }
});

// third Pass
estraverse.traverse(ast.program, {
  enter: function(node, parent) {
    // if (node.comments && node.comments.length){
    //   delete node.comments;
    // }
    if (!thirdPassHandlers[node.type]) return node;
    var node = secondPassHandlers[node.type](node, parent);
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
//ast.program.body = windowProps.concat(ast.program.body);
var trans = recast.print(ast).code;
if (!process.env.DEBUG) console.log(trans);
