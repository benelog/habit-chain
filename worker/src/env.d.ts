/**
 * The tests read web/app.js as text. @types/node would pull Node's globals in
 * beside workers-types, so declare only the one function used.
 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}
