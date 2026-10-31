// Says why a test FILE failed when its process ended before reporting a test. The spec reporter only prints
// 'test failed' then: a native crash and an import that never settles (exit code 13) both leave no other output.
const HINTS = {
  13: "loading the file's imports never finished (unsettled top-level await)",
  3221225477: "access violation (native crash)",
  3221226505: "stack buffer overrun / fail-fast (native crash)",
};

export default async function* exitReporter(source) {
  for await (const { type, data } of source) {
    const err = data.details?.error;
    if (type !== "test:fail" || data.nesting !== 0 || err?.failureType !== "testCodeFailure") continue;
    if (err.exitCode == null && err.signal == null) continue;
    const code = err.exitCode == null ? `signal ${err.signal}` : `exit code ${err.exitCode} (0x${(err.exitCode >>> 0).toString(16)})`;
    const hint = HINTS[err.exitCode] ? `: ${HINTS[err.exitCode]}` : "";
    yield `\n✖ ${data.file ?? data.name}: the test process ended with ${code}${hint}, after ${Math.round(data.details.duration_ms)} ms.\n`;
  }
}
