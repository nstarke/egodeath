import {
  getGlobals, setGlobals, resetGlobals,
  getWindowProps, resetWindowProps, addWindowProp,
} from '../globals';

describe('globals state', () => {
  beforeEach(() => {
    resetGlobals();
    resetWindowProps();
  });

  it('starts empty after reset', () => {
    expect(Object.keys(getGlobals())).toHaveLength(0);
  });

  it('setGlobals replaces the globals object', () => {
    setGlobals({ foo: { ___val: 'bar' } });
    expect(getGlobals().foo.___val).toBe('bar');
  });

  it('resetGlobals clears all entries', () => {
    setGlobals({ foo: { ___val: 'bar' } });
    resetGlobals();
    expect(Object.keys(getGlobals())).toHaveLength(0);
  });
});

describe('windowProps state', () => {
  beforeEach(() => {
    resetWindowProps();
  });

  it('starts empty after reset', () => {
    expect(getWindowProps()).toHaveLength(0);
  });

  it('addWindowProp adds to the list', () => {
    addWindowProp('myProp');
    addWindowProp('otherProp');
    expect(getWindowProps()).toEqual(['myProp', 'otherProp']);
  });

  it('resetWindowProps clears all entries', () => {
    addWindowProp('myProp');
    resetWindowProps();
    expect(getWindowProps()).toHaveLength(0);
  });
});
