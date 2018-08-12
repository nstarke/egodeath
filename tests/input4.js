var obj = {
  one: function (two) {
    var four = this.three(two) + 2;
    return four;
  },
  three: function (five) {
    var six = Math.pow(five, 3);
    return six + 1;
  }
}

var seven = obj.three(4);
console.log(seven);
