export function assertBunRuntime() {
  if (!process.versions.bun) {
    throw new Error(
      "The `bun` builder requires the Bun runtime. Run Nitro with Bun (e.g. `bun --bun nitro build`) or use another builder."
    );
  }
}
