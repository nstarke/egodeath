declare module 'recast' {
  const recast: any;
  export = recast;
}

declare module 'is-valid-var-name' {
  export function es5(name: string): boolean;
  export function es6(name: string): boolean;
}
