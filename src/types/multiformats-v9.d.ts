declare module 'multiformats' {
  export interface CID {
    readonly version: 0 | 1
    toString(): string
  }

  export const CID: {
    parse(source: string): CID
  }
}
