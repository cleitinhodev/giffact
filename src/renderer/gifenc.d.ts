declare module 'gifenc' {
  export function GIFEncoder(): any;
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number, opts?: any): number[][];
  export function applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: number[][], format?: string): Uint8Array;
}
