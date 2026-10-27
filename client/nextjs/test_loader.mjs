export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server" || specifier.endsWith("next/server")) {
    return nextResolve("next/server.js", context);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return nextResolve(specifier + ".ts", context);
    }
  }
  return nextResolve(specifier, context);
}

