import { Buffer } from "buffer";

// Buffer global requerido por WalletConnect (bn.js/elliptic) en Vite/browser
const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown };
if (!g.Buffer) g.Buffer = Buffer;

// algunos paquetes esperan global
if (typeof g.global === 'undefined') g.global = globalThis;
