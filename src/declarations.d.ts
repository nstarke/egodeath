declare module 'recast' {
  const recast: any;
  export = recast;
}

declare module 'jsfuck' {
  export const JSFuck: {
    encode(input: string): string;
  };
}

declare module 'is-valid-var-name' {
  export function es5(name: string): boolean;
  export function es6(name: string): boolean;
}

declare module 'window' {
  class Window {}
  export = Window;
}
