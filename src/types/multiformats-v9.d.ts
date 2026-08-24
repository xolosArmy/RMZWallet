declare module 'multiformats' {
  export class CID {
    readonly version: 0 | 1

    static parse(source: string): CID

    toString(): string
  }
}
