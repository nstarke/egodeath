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
  'require'
];

var props = ['getPrototypeOf', 'getOwnPropertyNames', 'hasOwnProperty',  'createElement'];
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

var safeProps = keywords.slice(0);

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
function addIdentifiers(){
  var len = crypto.randomBytes(1)[0] % 16;
  var result = [];
  for (var i = 0; i < len; i++){
    result.push(new Identifier(gen()));
  }
  return result;
}

var globals = {}

function substitute(node, key) {
  if (node.name === 'undefined') return node;
  var isKey = isKeyword(node.name);
  if (!node.skipped && !isKey) {
    if (globals[node.name]){
      node.name = globals[node.name].___val;
    } else  if (isKey){
       // globals[node.name] = { ___val: node.name}
    }
      //
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
    var isSafeProp = safeProps.indexOf(node.object.name) === -1;
    if (!isKeyword(node.object.name)){
      base[node.object.name] = base[node.object.name] || {___val: gen()}
    } else {
      if (!isSafeProp){
        node.object.skipped = true;
      }
    }
   
    if (node.property)  {
      var name = node.property.name;
      isSafeProp = safeProps.indexOf(node.property.name) === -1;
      if (!isKeyword(node.property.name) && isSafeProp){
        if(base[node.object.name][name]) {
          node.property.name = base[node.object.name][name].___val;
        }
      } else {
        node.property.skipped = true;
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
    //substitute(node, node.name);
    return node;
  },
  VariableDeclarator: function(node){
    if (isKeyword(node.id.name)) {
      delete keywords[keywords.indexOf(node.id.name)];
    } else  if (safeProps.indexOf(node.id.name) !== -1) {
      node.id.skipped = true;
    }
   
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
    if (node.left  && node.left.object && node.left.object.name === 'window') {
        
      if (node.left.property.name) {
        node.left.property.skipped = true;
        globals[node.left.property.name] = globals[node.left.property.name] || { ___val: gen() }
        windowProps.push(node.left.property.name);
        //keywords.push(node.left.property.name);
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
    substitute(node);
    return node;
  },
  VariableDeclarator: function(node){
   
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
    if (node.comments) delete node.comments;
    if (!thirdPassHandlers[node.type]) return node;
    //var node = thirdPassHandlers[node.type](node, parent);
  }
});

//ast.program.body = consoleKeywords.concat(ast.program.body);
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
