var test = false;
if (test) {
	console.log('boo');
}

if (!test) {
	test = !test;
}

switch (test){
	case true:
		console.log('hi');
		break;
	case false:
		console.log('sup');
	default: 
		console.log('state');
}
