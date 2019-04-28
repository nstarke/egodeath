function findVal(object, key) {
	    var value;
	    Object.keys(object).some(function(k) {
		            if (k === key) {
				                value = object[k];
				                return true;
				            }
		            if (object[k] && typeof object[k] === 'object') {
				                value = findVal(object[k], key);
				                return value !== undefined;
				            }
		        });
	    return value;
}

var object =  { photo: { progress: 20 }};
console.log(findVal(object, 'progress'));
