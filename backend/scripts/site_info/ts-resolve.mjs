// Node module-resolution hook for extract.mjs: noey-frontend imports its own
// modules without an extension ("./plans"); Node's type stripping loads
// `.ts` files but only resolves explicit paths, so append `.ts` to relative
// specifiers that have no extension.
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}
